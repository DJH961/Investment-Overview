"""Wise account statement -> EUR to USD conversions (7.3).

Reads a Wise statement export (CSV or TSV; the tabular reader sniffs the delimiter
and pads the trailing empty columns) and emits **conversions**, not transactions.
The "Wise statement" preset knows the header names; when a layout changes, the same
fields can be mapped by hand (``mapping``: field -> column index).

Rows that are not conversions are never dropped silently: each comes back with a
status and a reason for the preview (``skipped``: deposits, card payments, plain
transfers, a duplicate of a conversion already read; ``ignored``: a conversion into
another currency while the owner's setting says to ignore those; ``unsupported``:
the same with the setting off, 7.3 only supports EUR to USD).

The same conversion can appear in both the EUR and the USD statement (same
``CONVERSION_ORDER-...`` id). The row that states the fee wins (see
:func:`_better`). Fee maths lives in :mod:`domain.conversion_fees`.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Literal

from investment_dashboard.adapters.tabular.reader import read_sheets
from investment_dashboard.adapters.tabular.values import Cell, parse_date, parse_number
from investment_dashboard.domain.conversion_fees import (
    ConversionAmounts,
    with_hidden_fee,
    with_stated_fee,
)

#: field id -> (label, normalised default header, required)
FIELDS: dict[str, tuple[str, str, bool]] = {
    "id": ("Wise ID", "transferwise id", True),
    "date": ("Date", "date", True),
    "amount": ("Amount", "amount", False),
    "currency": ("Currency", "currency", False),
    "description": ("Description", "description", False),
    "exchange_from": ("Exchange from", "exchange from", True),
    "exchange_to": ("Exchange to", "exchange to", True),
    "exchange_rate": ("Exchange rate", "exchange rate", False),
    "total_fees": ("Total fees", "total fees", False),
    "exchange_to_amount": ("Exchange to amount", "exchange to amount", True),
    "details_type": ("Transaction details type", "transaction details type", False),
    "merchant": ("Merchant", "merchant", False),
    "card_last_four": ("Card last four digits", "card last four digits", False),
}

Status = Literal["conversion", "skipped", "ignored", "unsupported"]

_DESCRIPTION_RE = re.compile(
    r"converted\s+([\d.,]+)\s+([A-Za-z]{3})\s+to\s+([\d.,]+)\s+([A-Za-z]{3})", re.IGNORECASE
)


@dataclass(frozen=True)
class WiseRow:
    line: int
    external_id: str
    on: date | None
    status: Status
    reason: str | None = None
    from_ccy: str | None = None
    to_ccy: str | None = None
    amounts: ConversionAmounts | None = None
    #: The fee is stated on the row (EUR statement) rather than derived from the rate.
    fee_stated: bool = False
    #: A send-with-conversion: the dollars went straight on (to the broker).
    sent_on: bool = False
    #: The statement's own description of the row (shown in the preview only).
    description: str | None = None
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True)
class WiseStatement:
    rows: tuple[WiseRow, ...]
    headers: tuple[str, ...]
    header_row: int
    #: field id -> column index (``None`` = not found; map it by hand).
    mapping: Mapping[str, int | None]
    #: Required fields without a column.
    missing: tuple[str, ...] = ()
    errors: list[str] = field(default_factory=list)


def _norm(cell: Cell) -> str:
    return " ".join(str(cell).split()).lower() if cell is not None else ""


def _find_header_row(grid: list[list[Cell]]) -> int | None:
    wanted = {spec[1] for spec in FIELDS.values()}
    for i, row in enumerate(grid[:20]):
        hits = sum(1 for c in row if _norm(c) in wanted)
        if hits >= 3 or "transferwise id" in {_norm(c) for c in row}:
            return i
    return None


def default_mapping(headers: list[Cell]) -> dict[str, int | None]:
    normal = [_norm(h) for h in headers]
    out: dict[str, int | None] = {}
    for fid, (_label, header, _req) in FIELDS.items():
        out[fid] = normal.index(header) if header in normal else None
    return out


def _cell(row: list[Cell], mapping: Mapping[str, int | None], fid: str) -> Cell:
    idx = mapping.get(fid)
    if idx is None or idx >= len(row):
        return None
    return row[idx]


def _text(cell: Cell) -> str:
    return "" if cell is None else str(cell).strip()


def _num(cell: Cell) -> Decimal | None:
    return parse_number(cell, ".")


def parse_statement(
    content: bytes,
    *,
    mapping: Mapping[str, int | None] | None = None,
    ignore_other_pairs: bool = True,
) -> WiseStatement:
    """Parse a Wise statement. ``mapping`` overrides the preset column by column."""
    sheet = read_sheets(content)[0]
    grid = sheet.rows
    found = _find_header_row(grid)
    header_row = found if found is not None else 0
    headers = grid[header_row] if grid else []
    base = default_mapping(headers)
    if found is None:
        base = {k: None for k in base}
    effective: dict[str, int | None] = {**base, **(dict(mapping) if mapping else {})}
    missing = tuple(fid for fid, spec in FIELDS.items() if spec[2] and effective.get(fid) is None)
    shown_headers = tuple(_text(h) for h in headers)
    if missing:
        return WiseStatement((), shown_headers, header_row, effective, missing)

    rows: list[WiseRow] = []
    for offset, raw in enumerate(grid[header_row + 1 :], start=header_row + 2):
        if not any(_text(c) for c in raw):
            continue
        rows.append(_read_row(offset, raw, effective, ignore_other_pairs))
    return WiseStatement(tuple(_dedupe(rows)), shown_headers, header_row, effective)


def _better(a: WiseRow, b: WiseRow) -> WiseRow:
    """Of two rows for one conversion, the one that carries a fee (stated beats derived)."""

    def key(r: WiseRow) -> tuple[bool, bool]:
        fee = r.amounts.fees_eur if r.amounts else Decimal(0)
        return (fee > 0, r.fee_stated)

    return b if key(b) > key(a) else a


def _dedupe(rows: list[WiseRow]) -> list[WiseRow]:
    best: dict[str, WiseRow] = {}
    for r in rows:
        if r.status == "conversion":
            best[r.external_id] = _better(best[r.external_id], r) if r.external_id in best else r
    out: list[WiseRow] = []
    for r in rows:
        if r.status == "conversion" and best[r.external_id] is not r:
            kept = best[r.external_id]
            out.append(
                WiseRow(
                    line=r.line,
                    external_id=r.external_id,
                    on=r.on,
                    status="skipped",
                    reason=(
                        f"Same conversion as line {kept.line} (the other statement); "
                        "the row with the fee is used"
                    ),
                    description=r.description,
                )
            )
        else:
            out.append(r)
    return out


def _skip(line: int, ext: str, on: date | None, reason: str, desc: str | None) -> WiseRow:
    return WiseRow(line, ext, on, "skipped", reason, description=desc)


def _read_row(  # noqa: PLR0911 - one linear classification, clearer undivided
    line: int, raw: list[Cell], mapping: Mapping[str, int | None], ignore_other: bool
) -> WiseRow:
    ext = _text(_cell(raw, mapping, "id"))
    desc = _text(_cell(raw, mapping, "description")) or None
    try:
        on: date | None = parse_date(_cell(raw, mapping, "date"), "DMY")
    except ValueError:
        return _skip(line, ext, None, "The date could not be read", desc)
    details = _text(_cell(raw, mapping, "details_type")).upper()
    if (
        details == "CARD"
        or _text(_cell(raw, mapping, "merchant"))
        or _text(_cell(raw, mapping, "card_last_four"))
    ):
        return _skip(line, ext, on, "Card payment, not a conversion", desc)
    if details == "DEPOSIT":
        return _skip(line, ext, on, "Money received (a deposit), not a conversion", desc)
    from_ccy = _text(_cell(raw, mapping, "exchange_from")).upper()
    to_ccy = _text(_cell(raw, mapping, "exchange_to")).upper()
    if not from_ccy or not to_ccy or from_ccy == to_ccy:
        why = (
            "Money sent without a conversion"
            if details == "TRANSFER"
            else "Not a conversion (no currencies exchanged)"
        )
        return _skip(line, ext, on, why, desc)
    if details not in ("CONVERSION", "TRANSFER", ""):
        return _skip(line, ext, on, "Not a conversion", desc)
    if not ext:
        return _skip(line, ext, on, "The row has no Wise ID", desc)
    if (from_ccy, to_ccy) != ("EUR", "USD"):
        status: Status = "ignored" if ignore_other else "unsupported"
        why = (
            f"Conversion {from_ccy} to {to_ccy} ignored (only EUR to USD is imported)"
            if ignore_other
            else f"Conversion {from_ccy} to {to_ccy}: only EUR to USD can be imported"
        )
        return WiseRow(line, ext, on, status, why, from_ccy, to_ccy, description=desc)
    try:
        return _conversion(line, ext, on, details, desc, raw, mapping)
    except (ValueError, ArithmeticError) as exc:
        return WiseRow(
            line, ext, on, "unsupported", f"Could not read the amounts: {exc}", from_ccy, to_ccy
        )


def _conversion(
    line: int,
    ext: str,
    on: date,
    details: str,
    desc: str | None,
    raw: list[Cell],
    mapping: Mapping[str, int | None],
) -> WiseRow:
    usd = _num(_cell(raw, mapping, "exchange_to_amount"))
    amount = _num(_cell(raw, mapping, "amount"))
    statement_ccy = _text(_cell(raw, mapping, "currency")).upper()
    rate = _num(_cell(raw, mapping, "exchange_rate"))
    fee = _num(_cell(raw, mapping, "total_fees")) or Decimal(0)
    if usd is None and statement_ccy == "USD" and amount is not None and amount > 0:
        usd = amount
    if usd is None or usd <= 0:
        raise ValueError("the dollars received are missing")
    warnings: list[str] = []
    stated = False
    if statement_ccy == "EUR" and amount is not None:
        # EUR statement: the debit is the all-in total, the fee is stated.
        stated = True
        legs = with_stated_fee(eur_total=abs(amount), fee_eur=fee, usd=usd)
    else:
        total = _total_from_description(desc)
        if total is not None and rate is not None and rate > 0:
            legs = with_hidden_fee(eur_total=total, usd=usd, rate=rate)
        elif rate is not None and rate > 0:
            eur = (usd / rate).quantize(Decimal("0.01"))
            legs = ConversionAmounts(eur_sent=eur, fees_eur=Decimal(0), usd_received=usd)
            warnings.append("The euro total is not in the description: no fee could be derived")
        else:
            raise ValueError("neither the euro total nor the rate is available")
    if legs.eur_sent <= 0:
        raise ValueError("the euros sent are not positive")
    return WiseRow(
        line,
        ext,
        on,
        "conversion",
        None,
        "EUR",
        "USD",
        legs,
        fee_stated=stated,
        sent_on=details == "TRANSFER",
        description=desc,
        warnings=tuple(warnings),
    )


def _total_from_description(desc: str | None) -> Decimal | None:
    if not desc:
        return None
    m = _DESCRIPTION_RE.search(desc)
    if m is None or m.group(2).upper() != "EUR":
        return None
    try:
        return parse_number(m.group(1), ".")
    except ValueError:
        return None
