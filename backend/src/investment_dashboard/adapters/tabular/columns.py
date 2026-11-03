"""Find the header row and match columns to ledger fields.

Matching runs in two passes:

1. **By header name** — each field has synonyms (English, German, French,
   Spanish, Dutch, and the names the supported brokers use). Exact synonym
   matches beat "header contains the synonym" matches, and earlier synonyms
   beat later ones, so ``Action`` wins *action* over Fidelity's ``Type``
   (``Cash``/``Shares``) column.
2. **By content** — fields still unassigned are guessed from the values: the
   first mostly-date column is the trade date, a column of recognised action
   words is the action, ticker-shaped text is the symbol, and numeric columns
   are resolved by finding ``quantity × price ≈ amount`` triples.

Files with no recognisable header at all are read from their first data row
with generic ``Column N`` names.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from decimal import Decimal
from enum import StrEnum

from investment_dashboard.adapters.tabular.actions import known_action_share
from investment_dashboard.adapters.tabular.values import (
    Cell,
    DecimalSep,
    is_blank,
    looks_like_date,
    looks_numeric,
    parse_number,
)


class Field(StrEnum):
    DATE = "date"
    SETTLEMENT_DATE = "settlement_date"
    ACTION = "action"
    SYMBOL = "symbol"
    NAME = "name"
    DESCRIPTION = "description"
    QUANTITY = "quantity"
    PRICE = "price"
    AMOUNT = "amount"
    GROSS = "gross"
    FEES = "fees"
    COMMISSION = "commission"
    CURRENCY = "currency"


@dataclass(frozen=True)
class FieldInfo:
    id: Field
    label: str
    help: str
    required: bool = False


FIELDS: tuple[FieldInfo, ...] = (
    FieldInfo(Field.DATE, "Trade date", "When the transaction happened.", required=True),
    FieldInfo(Field.SETTLEMENT_DATE, "Settlement date", "Optional."),
    FieldInfo(
        Field.ACTION,
        "Action / type",
        "Buy, sell, dividend, deposit ... Without it the kind is guessed from the signs.",
    ),
    FieldInfo(Field.SYMBOL, "Symbol / ticker", "Ticker or ISIN of the security."),
    FieldInfo(Field.NAME, "Security name", "Optional."),
    FieldInfo(Field.DESCRIPTION, "Description", "Optional free text."),
    FieldInfo(Field.QUANTITY, "Quantity / shares", "Number of shares or units."),
    FieldInfo(Field.PRICE, "Price", "Price per share."),
    FieldInfo(
        Field.AMOUNT,
        "Amount (net)",
        "Cash that moved, fees included. Needed unless quantity and price are mapped.",
    ),
    FieldInfo(Field.GROSS, "Gross amount", "Quantity x price before fees. Optional."),
    FieldInfo(Field.FEES, "Fees", "Optional."),
    FieldInfo(Field.COMMISSION, "Commission", "Optional; added to the fees."),
    FieldInfo(Field.CURRENCY, "Currency", "Three-letter currency code per row. Optional."),
)

#: Synonyms per field, normalised (see :func:`normalise_header`), best first.
SYNONYMS: dict[Field, tuple[str, ...]] = {
    Field.DATE: (
        "trade date",
        "run date",
        "transaction date",
        "date",
        "trade dt",
        "booking date",
        "buchungstag",
        "buchungsdatum",
        "handelstag",
        "handelsdatum",
        "datum",
        "transaktionsdatum",
        "ausführungsdatum",
        "schlusstag",
        "date d'opération",
        "date operation",
        "date de transaction",
        "fecha",
        "fecha operación",
        "transactiedatum",
        "activity date",
        "process date",
        "execution date",
        "posted date",
        "time",
        "zeit",
    ),
    Field.SETTLEMENT_DATE: (
        "settlement date",
        "settle date",
        "settled date",
        "value date",
        "valuta",
        "valutadatum",
        "wertstellung",
        "date de valeur",
        "fecha valor",
        "valutadatum",
    ),
    Field.ACTION: (
        "action",
        "transaction type",
        "activity type",
        "activity",
        "transaction",
        "type",
        "trans code",
        "trans type",
        "buy sell",
        "buy/sell",
        "side",
        "operation",
        "transaktionsart",
        "buchungsart",
        "geschäftsart",
        "art",
        "typ",
        "vorgang",
        "type d'opération",
        "opération",
        "tipo",
        "tipo de operación",
        "soort",
        "omschrijving type",
    ),
    Field.SYMBOL: (
        "symbol",
        "ticker",
        "ticker symbol",
        "security symbol",
        "instrument",
        "isin",
        "wkn",
        "code",
        "security id",
        "stock",
        "asset",
        "symbole",
        "símbolo",
        "valor",
        "wertpapierkennnummer",
        "fund",
    ),
    Field.NAME: (
        "investment name",
        "security name",
        "security",
        "name",
        "instrument name",
        "fund name",
        "asset name",
        "product",
        "produkt",
        "wertpapier",
        "bezeichnung",
        "titel",
        "nom",
        "nombre",
        "naam",
        "security description",
    ),
    Field.DESCRIPTION: (
        "transaction description",
        "description",
        "details",
        "memo",
        "notes",
        "note",
        "beschreibung",
        "verwendungszweck",
        "buchungstext",
        "text",
        "libellé",
        "libelle",
        "descripción",
        "omschrijving",
        "comment",
        "kommentar",
    ),
    Field.QUANTITY: (
        "quantity",
        "shares",
        "qty",
        "units",
        "share quantity",
        "no of shares",
        "number of shares",
        "anzahl",
        "stück",
        "stueck",
        "stk",
        "menge",
        "nominal",
        "quantité",
        "quantite",
        "cantidad",
        "aantal",
        "volume",
        "amount of shares",
    ),
    Field.PRICE: (
        "price",
        "share price",
        "unit price",
        "price per share",
        "execution price",
        "trade price",
        "fill price",
        "kurs",
        "preis",
        "ausführungskurs",
        "stückpreis",
        "prix",
        "cours",
        "precio",
        "koers",
        "nav",
        "rate",
    ),
    Field.AMOUNT: (
        "net amount",
        "amount",
        "net",
        "total",
        "total amount",
        "net value",
        "value",
        "proceeds",
        "cash amount",
        "betrag",
        "nettobetrag",
        "endbetrag",
        "gesamtbetrag",
        "summe",
        "wert",
        "montant",
        "montant net",
        "importe",
        "importe neto",
        "bedrag",
        "netto",
        "transaction amount",
        "net cash",
    ),
    Field.GROSS: (
        "principal amount",
        "gross amount",
        "gross",
        "principal",
        "bruttobetrag",
        "brutto",
        "kurswert",
        "montant brut",
        "importe bruto",
        "market value",
    ),
    Field.FEES: (
        "fees",
        "fee",
        "commission fees",
        "commission & fees",
        "commissions and fees",
        "charges",
        "costs",
        "gebühren",
        "gebuehren",
        "kosten",
        "entgelt",
        "spesen",
        "frais",
        "comisiones",
        "kosten",
        "transaction costs",
        "fees & comm",
    ),
    Field.COMMISSION: ("commission", "commissions", "provision", "courtage", "comisión"),
    Field.CURRENCY: (
        "currency",
        "ccy",
        "curr",
        "währung",
        "waehrung",
        "devise",
        "moneda",
        "valuta code",
        "currency code",
        "settlement currency",
    ),
}

#: A header containing one of these words is never that field (``Account Type``
#: is not the action, ``Cash Balance`` is not the amount).
_EXCLUDE: dict[Field, tuple[str, ...]] = {
    Field.ACTION: ("account", "asset", "security", "investment", "fund", "konto", "share"),
    Field.AMOUNT: ("balance", "saldo", "accrued", "interest", "fee", "commission", "kurs"),
    Field.GROSS: ("balance", "saldo"),
    Field.DATE: ("settle", "valuta", "value date", "wertstellung", "expir", "birth"),
    Field.SYMBOL: ("cusip", "account"),
    Field.PRICE: ("total", "amount"),
    Field.NAME: ("account", "file", "broker"),
}

_EXACT, _CONTAINS = 1.0, 0.75
_HEADER_MIN = 0.7
_TICKER_RE = re.compile(r"^[A-Z][A-Z0-9.\-]{0,9}$|^[A-Z]{2}[A-Z0-9]{9}\d$")
#: ISO codes a per-row currency column realistically holds. A plain
#: ``[A-Z]{3}`` test would take a column of tickers (VTI, VOO) for currencies.
_CURRENCIES = frozenset(
    [
        "USD",
        "EUR",
        "GBP",
        "CHF",
        "JPY",
        "CAD",
        "AUD",
        "NZD",
        "SEK",
        "NOK",
        "DKK",
        "PLN",
        "CZK",
        "HUF",
        "HKD",
        "SGD",
        "CNY",
        "INR",
        "ZAR",
        "MXN",
        "BRL",
        "TRY",
        "ILS",
        "KRW",
        "TWD",
        "THB",
    ]
)
_SAMPLE_ROWS = 200


def normalise_header(h: Cell) -> str:
    """Lower-case, drop ``($)`` / ``**`` style decorations, collapse spaces."""
    s = "" if h is None else str(h)
    s = s.strip().lower().replace("_", " ")
    s = re.sub(r"\((?:[$€£]|[a-z]{3})\)", " ", s)  # "Price ($)", "Amount (EUR)"
    s = re.sub(r"[*$€£#:]", " ", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip(" .-")


def header_score(header: Cell, fld: Field) -> float:
    """How well ``header`` names ``fld`` (0 = not at all, 1 = best synonym)."""
    h = normalise_header(header)
    if not h:
        return 0.0
    if any(x in h for x in _EXCLUDE.get(fld, ())):
        return 0.0
    synonyms = SYNONYMS[fld]
    for rank, syn in enumerate(synonyms):
        if h == syn:
            return _EXACT - rank * 0.005
    best = 0.0
    padded = f" {h} "
    for rank, syn in enumerate(synonyms):
        # Whole-word containment; single short words only when they are the
        # header's first or last word ("Trade Date", "Amount EUR").
        if f" {syn} " in padded:
            words = h.split()
            if len(syn) < 4 and syn not in (words[0], words[-1]):
                continue
            best = max(best, _CONTAINS - rank * 0.005)
    return best


@dataclass
class ColumnProfile:
    """What a column looks like, from a sample of its values."""

    index: int
    header: str
    samples: list[str]
    date_share: float = 0.0
    numeric_share: float = 0.0
    ticker_share: float = 0.0
    currency_share: float = 0.0
    action_share: float = 0.0
    negative_share: float = 0.0
    avg_len: float = 0.0
    filled: int = 0


@dataclass
class Assignment:
    field: Field
    index: int
    confidence: float
    by: str  # "header", "content", "saved" or "user"


@dataclass
class Detection:
    header_row: int | None  # 0-based index in the grid; None = no header
    headers: list[str]
    profiles: list[ColumnProfile]
    assignments: dict[Field, Assignment] = field(default_factory=dict)

    @property
    def data_start(self) -> int:
        return 0 if self.header_row is None else self.header_row + 1

    def column(self, fld: Field) -> int | None:
        a = self.assignments.get(fld)
        return None if a is None else a.index


def _row_header_score(row: Sequence[Cell]) -> float:
    total = 0.0
    for cell in row:
        if is_blank(cell) or looks_numeric(cell) or looks_like_date(cell):
            continue
        best = max(header_score(cell, f) for f in Field)
        if best >= _HEADER_MIN:
            total += best
    return total


def find_header_row(rows: Sequence[Sequence[Cell]], scan: int = 40) -> int | None:
    """The 0-based index of the most header-like row among the first ``scan``."""
    best_idx, best = None, 0.0
    for i, row in enumerate(rows[:scan]):
        score = _row_header_score(row)
        if score > best + 1e-9:
            best_idx, best = i, score
    # Two recognised column names are needed to trust a header.
    return best_idx if best >= 2 * _HEADER_MIN else None


def _text(c: Cell) -> str:
    return "" if c is None else str(c).strip()


def profile_columns(
    rows: Sequence[Sequence[Cell]], headers: Sequence[str], start: int, decimal: DecimalSep
) -> list[ColumnProfile]:
    data = [r for r in rows[start : start + _SAMPLE_ROWS] if any(not is_blank(c) for c in r)]
    out: list[ColumnProfile] = []
    for idx, header in enumerate(headers):
        values = [r[idx] for r in data if idx < len(r) and not is_blank(r[idx])]
        prof = ColumnProfile(index=idx, header=header, samples=[])
        seen: list[str] = []
        for v in values:
            t = _text(v)
            if t not in seen:
                seen.append(t)
            if len(seen) >= 4:
                break
        prof.samples = seen
        n = len(values)
        prof.filled = n
        if n:
            texts = [_text(v) for v in values]
            prof.date_share = sum(looks_like_date(v) for v in values) / n
            nums: list[Decimal] = []
            for v in values:
                if looks_numeric(v):
                    try:
                        num = parse_number(v, decimal)
                    except ValueError:
                        continue
                    if num is not None:
                        nums.append(num)
            prof.numeric_share = len(nums) / n
            prof.negative_share = sum(1 for x in nums if x < 0) / n
            prof.ticker_share = sum(bool(_TICKER_RE.match(t)) for t in texts) / n
            prof.currency_share = sum(t.upper() in _CURRENCIES for t in texts) / n
            prof.action_share = known_action_share(texts) if prof.numeric_share < 0.5 else 0.0
            prof.avg_len = sum(len(t) for t in texts) / n
        out.append(prof)
    return out


def _assign_by_header(det: Detection) -> None:
    candidates: list[tuple[float, int, Field]] = []
    for prof in det.profiles:
        for fld in Field:
            score = header_score(prof.header, fld)
            if score >= _HEADER_MIN:
                candidates.append((score, prof.index, fld))
    candidates.sort(key=lambda c: (-c[0], c[1]))
    used: set[int] = set()
    for score, idx, fld in candidates:
        if fld in det.assignments or idx in used:
            continue
        if not _content_fits(det.profiles[idx], fld):
            continue
        det.assignments[fld] = Assignment(fld, idx, round(score, 2), "header")
        used.add(idx)


_NUMERIC_FIELDS = {Field.QUANTITY, Field.PRICE, Field.AMOUNT, Field.GROSS, Field.FEES}
_DATE_FIELDS = {Field.DATE, Field.SETTLEMENT_DATE}


def _content_fits(prof: ColumnProfile, fld: Field) -> bool:
    """Veto a header match whose values clearly aren't that kind of data."""
    if prof.filled == 0:
        return True  # an empty column may still be the right one
    if fld in _DATE_FIELDS:
        # A date-named header is strong evidence: footers, disclaimers and
        # repeated headers in short files may outnumber the real dates.
        return prof.date_share >= 0.3
    if fld in _NUMERIC_FIELDS or fld == Field.COMMISSION:
        return prof.numeric_share >= 0.5 or prof.date_share < 0.5
    if fld == Field.ACTION:
        return prof.numeric_share < 0.5 and prof.date_share < 0.5
    return True


def _close(a: Decimal, b: Decimal) -> bool:
    if a == 0 or b == 0:
        return False
    return abs(abs(a) - abs(b)) <= abs(b) * Decimal("0.02") + Decimal("0.02")


def _numeric_values(
    rows: Sequence[Sequence[Cell]], idx: int, start: int, decimal: DecimalSep
) -> list[Decimal | None]:
    out: list[Decimal | None] = []
    for r in rows[start : start + _SAMPLE_ROWS]:
        try:
            out.append(parse_number(r[idx], decimal) if idx < len(r) else None)
        except ValueError:
            out.append(None)
    return out


def _assign_numeric_by_content(  # noqa: PLR0912
    det: Detection, rows: Sequence[Sequence[Cell]], decimal: DecimalSep
) -> None:
    used = {a.index for a in det.assignments.values()}
    numeric = [p for p in det.profiles if p.index not in used and p.numeric_share >= 0.8]
    if not numeric:
        return
    cols = {p.index: _numeric_values(rows, p.index, det.data_start, decimal) for p in numeric}
    amount_idx = det.column(Field.AMOUNT)
    if amount_idx is not None:
        # A header-matched amount still helps find the quantity/price pair.
        cols[amount_idx] = _numeric_values(rows, amount_idx, det.data_start, decimal)
    best: tuple[int, int, int, int] | None = None  # (hits, q, p, a)
    pool = list(cols)
    for q in pool:
        for p in pool:
            if p == q:
                continue
            for a in pool:
                if a in (p, q):
                    continue
                hits = sum(
                    1
                    for qv, pv, av in zip(cols[q], cols[p], cols[a], strict=False)
                    if qv is not None and pv is not None and av is not None and _close(qv * pv, av)
                )
                if hits and (best is None or hits > best[0]):
                    best = (hits, q, p, a)
    if best is not None and best[0] >= 2:
        _, q, p, a = best
        # q × p is symmetric: the price column has fewer distinct-per-row
        # integers; prefer the column with more non-integral values as price.
        if _integral_share(cols[q]) < _integral_share(cols[p]):
            q, p = p, q
        for fld, idx in ((Field.QUANTITY, q), (Field.PRICE, p), (Field.AMOUNT, a)):
            if fld not in det.assignments and idx not in used:
                det.assignments[fld] = Assignment(fld, idx, 0.6, "content")
                used.add(idx)
    if Field.AMOUNT not in det.assignments:
        rest = [p for p in numeric if p.index not in used]
        if len(rest) == 1 or (rest and rest[0].negative_share > 0):
            # A lone numeric column — or the first signed one — is the cash amount.
            signed = [p for p in rest if p.negative_share > 0] or rest
            det.assignments[Field.AMOUNT] = Assignment(
                Field.AMOUNT, signed[0].index, 0.4, "content"
            )


def _integral_share(values: list[Decimal | None]) -> float:
    nums = [v for v in values if v is not None]
    if not nums:
        return 0.0
    return sum(1 for v in nums if v == v.to_integral_value()) / len(nums)


def _assign_by_content(det: Detection, rows: Sequence[Sequence[Cell]], decimal: DecimalSep) -> None:
    def free(p: ColumnProfile) -> bool:
        return p.index not in {a.index for a in det.assignments.values()}

    if Field.DATE not in det.assignments:
        dated = [p for p in det.profiles if free(p) and p.date_share >= 0.8]
        if dated:
            det.assignments[Field.DATE] = Assignment(Field.DATE, dated[0].index, 0.5, "content")
            if len(dated) > 1 and Field.SETTLEMENT_DATE not in det.assignments:
                det.assignments[Field.SETTLEMENT_DATE] = Assignment(
                    Field.SETTLEMENT_DATE, dated[1].index, 0.4, "content"
                )
    if Field.ACTION not in det.assignments:
        acts = sorted(
            (p for p in det.profiles if free(p) and p.action_share >= 0.5),
            key=lambda p: -p.action_share,
        )
        if acts:
            det.assignments[Field.ACTION] = Assignment(
                Field.ACTION, acts[0].index, round(min(acts[0].action_share, 0.9), 2), "content"
            )
    if Field.CURRENCY not in det.assignments:
        ccy = [p for p in det.profiles if free(p) and p.currency_share >= 0.9]
        if ccy:
            det.assignments[Field.CURRENCY] = Assignment(
                Field.CURRENCY, ccy[0].index, 0.5, "content"
            )
    if Field.SYMBOL not in det.assignments:
        tick = sorted(
            (
                p
                for p in det.profiles
                if free(p) and p.ticker_share >= 0.6 and p.numeric_share < 0.5
            ),
            key=lambda p: -p.ticker_share,
        )
        if tick:
            det.assignments[Field.SYMBOL] = Assignment(Field.SYMBOL, tick[0].index, 0.5, "content")
    _assign_numeric_by_content(det, rows, decimal)
    if Field.DESCRIPTION not in det.assignments:
        texts = sorted(
            (
                p
                for p in det.profiles
                if free(p) and p.numeric_share < 0.3 and p.date_share < 0.3 and p.avg_len >= 8
            ),
            key=lambda p: -p.avg_len,
        )
        if texts:
            det.assignments[Field.DESCRIPTION] = Assignment(
                Field.DESCRIPTION, texts[0].index, 0.3, "content"
            )


def detect(
    rows: Sequence[Sequence[Cell]], decimal: DecimalSep, header_row: int | None = -1
) -> Detection:
    """Locate the header (``header_row=-1`` = auto, ``None`` = no header) and assign fields."""
    if header_row == -1:
        header_row = find_header_row(rows)
    width = max((len(r) for r in rows), default=0)
    if header_row is None:
        headers = [f"Column {i + 1}" for i in range(width)]
    else:
        raw = list(rows[header_row]) + [None] * (width - len(rows[header_row]))
        headers = [_text(h) or f"Column {i + 1}" for i, h in enumerate(raw)]
    start = 0 if header_row is None else header_row + 1
    det = Detection(
        header_row=header_row,
        headers=headers,
        profiles=profile_columns(rows, headers, start, decimal),
    )
    if header_row is not None:
        _assign_by_header(det)
    _assign_by_content(det, rows, decimal)
    return det


def header_signature(headers: Sequence[str]) -> str:
    """Order-insensitive key identifying a file layout (for saved mappings)."""
    names = sorted({normalise_header(h) for h in headers if normalise_header(h)})
    return "|".join(names)[:500]
