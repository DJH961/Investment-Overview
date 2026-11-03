"""Flexible transaction-file parser: any CSV / TSV / XLSX with a halfway usable layout.

Pipeline: read every table in the file (:mod:`..tabular.reader`), infer the
decimal separator, find the header row and match columns to fields
(:mod:`..tabular.columns`), infer the date order, then parse each row into a
:class:`ParsedTransactionRow`.

What the user can steer (from the import page, or a saved layout) is a
:class:`LayoutChoice`: which column is which field, the number/date format,
the header row and the sheet. What was detected comes back as a
:class:`Layout` on the report so the page can show it and offer corrections.

Rules that keep the result meaningful when the file is vague:

* **Kind** comes from the action column through ``action_mapper`` (the
  broker's own map when a known broker's file is read this way, else the
  multi-language :func:`classify_action`). With no action column — or an
  empty cell — the kind is guessed from the signs (shares in + cash out = buy,
  plain cash in = deposit, ...) and a warning says so.
* **Signs**: when the amount column never goes negative the file is unsigned
  and the ledger sign is set from the kind (buys/fees/withdrawals negative).
  Sell quantities are always stored negative.
* **Missing columns are asked, not guessed**: a file with trades but no price
  (or no quantity, or no amount) gets a :class:`Question`; the page offers to
  pick the column, to work the value out from the other two
  (``LayoutChoice.derive``) when that is possible, or to cancel. Ambiguous date
  orders (``01/05/2024``) are asked the same way unless the caller knows the
  file's convention (``date_order_default``). Confirming is blocked while a
  question is open.
* Rows without a date (subtotals, footers, repeated headers) are skipped
  silently; rows with a date that fail to parse are reported as errors.
"""

from __future__ import annotations

import hashlib
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from investment_dashboard.adapters.importer_types import (
    ParsedTransactionRow,
    ParseReport,
    RowIssue,
    UnknownActionError,
)
from investment_dashboard.adapters.row_validation import validate_row
from investment_dashboard.adapters.tabular.actions import classify_action
from investment_dashboard.adapters.tabular.columns import (
    FIELDS,
    Assignment,
    Detection,
    Field,
    detect,
    header_signature,
    normalise_header,
)
from investment_dashboard.adapters.tabular.reader import Sheet, read_sheets
from investment_dashboard.adapters.tabular.values import (
    Cell,
    DateOrder,
    DecimalSep,
    date_order_ambiguous,
    infer_date_order,
    infer_decimal,
    is_blank,
    looks_numeric,
    parse_date,
    parse_number,
)

ActionMapper = Callable[[str, Mapping[str, str] | None], str | None]

#: ``header_row`` value meaning "find it automatically".
AUTO = -1

_OUTFLOW = frozenset({"buy", "dividend_reinvest", "withdrawal", "fee", "transfer_out"})
_INFLOW = frozenset({"sell", "dividend_cash", "interest", "deposit", "transfer_in"})
_SHARE_IN = frozenset({"buy", "dividend_reinvest"})
_SAMPLE = 4


@dataclass(frozen=True)
class LayoutChoice:
    """User (or saved) corrections to the detected layout.

    ``columns`` maps a field id to a column index, a header name, or ``None``
    (= "this file has no such column"). Unlisted fields keep the detection.
    """

    columns: Mapping[str, int | str | None] = field(default_factory=dict)
    decimal: DecimalSep | None = None
    date_order: DateOrder | None = None
    header_row: int | None = AUTO  # 0-based; None = the file has no header row
    sheet: int | None = None
    #: Fields to work out from the others: ``price`` (= amount / quantity),
    #: ``quantity`` (= amount / price) or ``amount`` (= quantity x price +- fees).
    derive: frozenset[str] = frozenset()


DERIVABLE: tuple[str, ...] = ("price", "quantity", "amount")


@dataclass(frozen=True)
class Question:
    """Something the user must settle before this file can be imported."""

    field: str  # a field id, or "date_order"
    message: str
    can_derive: bool = False
    derive_hint: str = ""


@dataclass(frozen=True)
class ColumnInfo:
    index: int
    header: str
    samples: tuple[str, ...]
    field: str | None
    confidence: float
    by: str | None


@dataclass(frozen=True)
class Layout:
    """What the parser used, for the import page's column editor."""

    sheets: tuple[str, ...]
    sheet: int
    header_row: int | None
    columns: tuple[ColumnInfo, ...]
    decimal: DecimalSep
    date_order: DateOrder
    missing: tuple[str, ...]
    signature: str
    notes: tuple[str, ...] = ()
    questions: tuple[Question, ...] = ()
    derive: tuple[str, ...] = ()


@dataclass(frozen=True)
class GenericParseReport(ParseReport):
    layout: Layout | None = None


def _text(c: Cell) -> str:
    return "" if c is None else str(c).strip()


def _flat_cells(rows: Sequence[Sequence[Cell]]) -> list[Cell]:
    return [c for r in rows for c in r]


def _sheet_score(det: Detection, data_rows: int) -> float:
    score = 0.0
    weights = {Field.DATE: 4.0, Field.AMOUNT: 2.0, Field.QUANTITY: 1.0, Field.ACTION: 1.5}
    for fld, w in weights.items():
        a = det.assignments.get(fld)
        if a is not None:
            score += w * a.confidence
    return score + min(data_rows, 1000) / 1000


def _apply_choice(det: Detection, choice: LayoutChoice) -> None:
    wanted = {f.value for f in Field}
    for raw_field, target in choice.columns.items():
        if raw_field not in wanted:
            continue
        fld = Field(raw_field)
        det.assignments.pop(fld, None)
        idx: int | None
        if isinstance(target, str):
            key = normalise_header(target)
            idx = next((i for i, h in enumerate(det.headers) if normalise_header(h) == key), None)
        else:
            idx = target
        if idx is None or not 0 <= idx < len(det.headers):
            continue
        for other in [f for f, a in det.assignments.items() if a.index == idx]:
            del det.assignments[other]
        det.assignments[fld] = Assignment(fld, idx, 1.0, "user")


def _missing(det: Detection) -> tuple[str, ...]:
    """Fields without which no row can be read at all (nothing is parsed)."""
    missing: list[str] = []
    if Field.DATE not in det.assignments:
        missing.append(Field.DATE.value)
    has_amount = Field.AMOUNT in det.assignments or Field.GROSS in det.assignments
    has_trade = Field.QUANTITY in det.assignments and Field.PRICE in det.assignments
    if not has_amount and not has_trade:
        missing.append(Field.AMOUNT.value)
    return tuple(missing)


def _has(det: Detection, *fields: Field) -> bool:
    return all(f in det.assignments for f in fields)


def _questions(det: Detection, choice: LayoutChoice, ambiguous_dates: bool) -> list[Question]:
    qs: list[Question] = []
    derive = choice.derive
    has_cash = _has(det, Field.AMOUNT) or _has(det, Field.GROSS)
    if not _has(det, Field.DATE):
        qs.append(Question("date", "Which column holds the trade date?"))
    elif ambiguous_dates:
        qs.append(
            Question(
                "date_order",
                "Dates like 01/05/2024 could mean 1 May or 5 January. "
                "Which order does this file use?",
            )
        )
    if not has_cash and "amount" not in derive:
        can = _has(det, Field.QUANTITY, Field.PRICE)
        qs.append(
            Question(
                "amount",
                "No amount (cash) column was found.",
                can_derive=can,
                derive_hint="quantity x price, plus or minus fees",
            )
        )
    if _has(det, Field.QUANTITY) and not _has(det, Field.PRICE) and "price" not in derive:
        qs.append(
            Question(
                "price",
                "The file has share quantities but no price column.",
                can_derive=has_cash,
                derive_hint="amount / quantity (fees taken out)",
            )
        )
    if _has(det, Field.PRICE) and not _has(det, Field.QUANTITY) and "quantity" not in derive:
        qs.append(
            Question(
                "quantity",
                "The file has prices but no quantity column.",
                can_derive=has_cash,
                derive_hint="amount / price (fees taken out)",
            )
        )
    return qs


def _choose_sheet(
    sheets: Sequence[Sheet], choice: LayoutChoice
) -> tuple[int, DecimalSep, Detection]:
    candidates = (
        [choice.sheet]
        if choice.sheet is not None and 0 <= choice.sheet < len(sheets)
        else list(range(len(sheets)))
    )
    best: tuple[float, int, DecimalSep, Detection] | None = None
    for i in candidates:
        rows = sheets[i].rows
        decimal = choice.decimal or infer_decimal(_flat_cells(rows))
        det = detect(rows, decimal, choice.header_row)
        score = _sheet_score(det, len(rows) - det.data_start)
        if best is None or score > best[0]:
            best = (score, i, decimal, det)
    assert best is not None  # read_sheets never returns an empty list
    return best[1], best[2], best[3]


def _cell(row: Sequence[Cell], det: Detection, fld: Field) -> Cell:
    idx = det.column(fld)
    if idx is None or idx >= len(row):
        return None
    return row[idx]


def _guess_kind(qty: Decimal | None, net: Decimal | None, signed: bool) -> str:
    if qty is not None and qty != 0:
        if signed and net is not None and net != 0:
            return "buy" if net < 0 else "sell"
        return "buy" if qty > 0 else "sell"
    if net is not None and net < 0:
        return "withdrawal"
    return "deposit"


_PRICE_Q = Decimal("0.000001")
_QTY_Q = Decimal("0.000001")


def _cash_gross(net: Decimal, fees: Decimal | None, kind: str) -> Decimal:
    """Quantity x price implied by a booked amount: fees come out of a buy's cost
    and are added back to a sale's proceeds."""
    fee = fees or Decimal(0)
    if kind in _OUTFLOW:
        return max(abs(net) - fee, Decimal(0))
    return abs(net) + fee


def _hash(*parts: object) -> str:
    return hashlib.sha256("|".join(str(p) for p in parts).encode("utf-8")).hexdigest()[:32]


def _norm(d: Decimal | None) -> str:
    return "" if d is None else format(d.normalize(), "f")


def _column_signed(rows: Sequence[Sequence[Cell]], idx: int | None, decimal: DecimalSep) -> bool:
    if idx is None:
        return False
    for r in rows:
        if idx < len(r) and looks_numeric(r[idx]):
            try:
                v = parse_number(r[idx], decimal)
            except ValueError:
                continue
            if v is not None and v < 0:
                return True
    return False


def _layout(
    sheets: Sequence[Sheet],
    sheet: int,
    det: Detection,
    decimal: DecimalSep,
    date_order: DateOrder,
    notes: Sequence[str],
    questions: Sequence[Question] = (),
    derive: frozenset[str] = frozenset(),
) -> Layout:
    by_index = {a.index: a for a in det.assignments.values()}
    columns = tuple(
        ColumnInfo(
            index=p.index,
            header=p.header,
            samples=tuple(p.samples[:_SAMPLE]),
            field=by_index[p.index].field.value if p.index in by_index else None,
            confidence=by_index[p.index].confidence if p.index in by_index else 0.0,
            by=by_index[p.index].by if p.index in by_index else None,
        )
        for p in det.profiles
    )
    return Layout(
        sheets=tuple(s.name for s in sheets),
        sheet=sheet,
        header_row=det.header_row,
        columns=columns,
        decimal=decimal,
        date_order=date_order,
        missing=_missing(det),
        signature=header_signature(det.headers) if det.header_row is not None else "",
        notes=tuple(notes),
        questions=tuple(questions),
        derive=tuple(sorted(derive)),
    )


@dataclass
class _Acc:
    rows: list[ParsedTransactionRow] = field(default_factory=list)
    sweeps: int = 0
    unknown: list[str] = field(default_factory=list)
    errors: list[RowIssue] = field(default_factory=list)
    warnings: list[RowIssue] = field(default_factory=list)
    guessed: int = 0
    seen: Counter[str] = field(default_factory=Counter)


def _parse_rows(  # noqa: PLR0912, PLR0915 - one linear row recipe reads best in one place
    rows: Sequence[Sequence[Cell]],
    det: Detection,
    *,
    decimal: DecimalSep,
    date_order: DateOrder,
    action_mapper: ActionMapper,
    action_overrides: Mapping[str, str] | None,
    source: str,
    line_offset: int,
    derive: frozenset[str] = frozenset(),
) -> _Acc:
    acc = _Acc()
    data = rows[det.data_start :]
    signed = _column_signed(data, det.column(Field.AMOUNT), decimal) or _column_signed(
        data, det.column(Field.GROSS), decimal
    )
    header_keys = [normalise_header(h) for h in det.headers]
    numeric_fields = (Field.QUANTITY, Field.PRICE, Field.AMOUNT, Field.GROSS)
    for offset, row in enumerate(data):
        line = line_offset + det.data_start + offset + 1
        if all(is_blank(c) for c in row):
            continue
        if det.header_row is not None and [normalise_header(c) for c in row] == header_keys:
            continue  # header repeated on every page of a long export
        raw_date = _cell(row, det, Field.DATE)
        raw_action = _text(_cell(row, det, Field.ACTION))
        context = raw_action or " ".join(_text(c) for c in row if not is_blank(c))[:120]
        try:
            trade_date = parse_date(raw_date, date_order) if not is_blank(raw_date) else None
        except ValueError as exc:
            # "Total" / "Subtotal" lines carry an amount but no date at all; only
            # a malformed date (it has digits) is worth reporting.
            has_digits = any(ch.isdigit() for ch in _text(raw_date))
            if has_digits and any(looks_numeric(_cell(row, det, f)) for f in numeric_fields):
                acc.errors.append(RowIssue(message=str(exc), line=line, raw=context))
            continue  # footers / notes / subtotals without a date
        if trade_date is None:
            continue
        try:
            qty = parse_number(_cell(row, det, Field.QUANTITY), decimal)
            price = parse_number(_cell(row, det, Field.PRICE), decimal)
            net = parse_number(_cell(row, det, Field.AMOUNT), decimal)
            gross = parse_number(_cell(row, det, Field.GROSS), decimal)
            fees_a = parse_number(_cell(row, det, Field.FEES), decimal)
            fees_b = parse_number(_cell(row, det, Field.COMMISSION), decimal)
            raw_settle = _cell(row, det, Field.SETTLEMENT_DATE)
            settlement: date | None = (
                parse_date(raw_settle, date_order) if not is_blank(raw_settle) else None
            )
        except ValueError as exc:
            acc.errors.append(RowIssue(message=str(exc), line=line, raw=context))
            continue
        if raw_action:
            try:
                kind = action_mapper(raw_action, action_overrides)
            except UnknownActionError as exc:
                acc.unknown.append(raw_action)
                acc.errors.append(RowIssue(message=str(exc), line=line, raw=raw_action))
                continue
            if kind is None:
                acc.sweeps += 1
                continue
        else:
            if qty is None and net is None and gross is None:
                continue  # a dated row with nothing to book (e.g. a note line)
            kind = _guess_kind(qty, net if net is not None else gross, signed)
            acc.guessed += 1

        fees = None
        if fees_a is not None or fees_b is not None:
            fees = abs(fees_a or Decimal(0)) + abs(fees_b or Decimal(0))
            if fees == 0:
                fees = None
        if qty is not None and (
            (kind in ("sell", "transfer_out") and qty > 0) or (kind in _SHARE_IN and qty < 0)
        ):
            qty = -qty
        if price is not None and price < 0:
            price = -price
        if "price" in derive and net is not None and qty and price is None:
            price = (_cash_gross(net, fees, kind) / abs(qty)).quantize(_PRICE_Q)
        if "quantity" in derive and net is not None and price and qty is None:
            qty = (_cash_gross(net, fees, kind) / price).quantize(_QTY_Q)
            if kind in ("sell", "transfer_out"):
                qty = -qty
        if gross is None and qty is not None and price is not None:
            gross = qty * price
        no_cash_column = det.column(Field.AMOUNT) is None and det.column(Field.GROSS) is None
        if net is None and gross is not None and (not no_cash_column or "amount" in derive):
            fee = fees or Decimal(0)
            if kind in _OUTFLOW:
                net = -(abs(gross) + fee)
            elif kind in _INFLOW:
                net = abs(gross) - fee
        if net is not None and not signed:
            if kind in _OUTFLOW:
                net = -abs(net)
            elif kind in _INFLOW:
                net = abs(net)
        if net is None and qty is None:
            acc.errors.append(
                RowIssue(message="row has neither an amount nor a quantity", line=line, raw=context)
            )
            continue

        symbol = _text(_cell(row, det, Field.SYMBOL)).upper() or None
        name = _text(_cell(row, det, Field.NAME)) or None
        description = _text(_cell(row, det, Field.DESCRIPTION)) or raw_action or name
        ccy = _text(_cell(row, det, Field.CURRENCY)).upper()
        currency = ccy if len(ccy) == 3 and ccy.isalpha() else None
        base = _hash(
            trade_date.isoformat(),
            kind,
            symbol or "",
            _norm(qty),
            _norm(price),
            _norm(net),
            description or "",
        )
        acc.seen[base] += 1
        n = acc.seen[base]
        parsed = ParsedTransactionRow(
            date=trade_date,
            settlement_date=settlement,
            kind=kind,
            symbol=symbol,
            quantity=qty,
            price_native=price,
            gross_native=gross,
            fees_native=fees,
            net_native=net,
            description=description,
            # Identical rows in one file are distinct transactions: number them.
            external_id=base if n == 1 else _hash(base, n),
            source=source,
            name=name,
            native_currency=currency,
        )
        acc.rows.append(parsed)
        for warn in validate_row(parsed):
            acc.warnings.append(RowIssue(message=warn, line=line, raw=context))
    return acc


def parse_generic(
    content: bytes | str,
    *,
    choice: LayoutChoice | None = None,
    action_overrides: Mapping[str, str] | None = None,
    action_mapper: ActionMapper = classify_action,
    source: str = "import_generic",
    date_order_default: DateOrder | None = None,
) -> GenericParseReport:
    """Parse any tabular transaction file; never raises for a readable table.

    A file whose required columns can't be found returns no rows, one error
    and a :class:`Layout` whose ``missing`` lists what to map. Unreadable files
    (binary, empty, legacy ``.xls``) raise
    :class:`~investment_dashboard.adapters.tabular.reader.UnreadableFileError`.
    """
    choice = choice or LayoutChoice()
    sheets = read_sheets(content)
    sheet_idx, decimal, det = _choose_sheet(sheets, choice)
    _apply_choice(det, choice)
    rows = sheets[sheet_idx].rows
    date_idx = det.column(Field.DATE)
    date_cells = [r[date_idx] for r in rows[det.data_start :] if date_idx is not None]
    date_order = choice.date_order or infer_date_order(
        date_cells, default=date_order_default or ("DMY" if decimal == "," else "MDY")
    )
    ambiguous = (
        choice.date_order is None
        and date_order_default is None
        and date_order_ambiguous(date_cells)
    )
    questions = _questions(det, choice, ambiguous)
    notes: list[str] = []
    if det.header_row is None:
        notes.append("No header row found; columns were guessed from their contents.")
    missing = _missing(det)
    if missing:
        labels = {f.id.value: f.label for f in FIELDS}
        need = " and ".join(labels[m] for m in missing)
        return GenericParseReport(
            rows=[],
            errors=[RowIssue(message=f"Choose the {need} column to import this file")],
            layout=_layout(
                sheets, sheet_idx, det, decimal, date_order, notes, questions, choice.derive
            ),
        )
    acc = _parse_rows(
        rows,
        det,
        decimal=decimal,
        date_order=date_order,
        action_mapper=action_mapper,
        action_overrides=action_overrides,
        source=source,
        line_offset=0,
        derive=choice.derive,
    )
    if acc.guessed:
        acc.warnings.insert(
            0,
            RowIssue(
                message=(
                    f"{acc.guessed} row(s) have no action; their kind was guessed from the "
                    "signs of quantity and amount. Check them, or map an action column."
                )
            ),
        )
    return GenericParseReport(
        rows=acc.rows,
        sweeps_dropped=acc.sweeps,
        unknown_actions=acc.unknown,
        errors=acc.errors,
        warnings=acc.warnings,
        layout=_layout(
            sheets, sheet_idx, det, decimal, date_order, notes, questions, choice.derive
        ),
    )
