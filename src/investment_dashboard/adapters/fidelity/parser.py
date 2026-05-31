"""Fidelity CSV parser (spec §5.1).

Column layout (case-insensitive, whitespace-stripped, order tolerant)::

    Run Date, Action, Symbol, Description, Type, Quantity, Price ($),
    Commission ($), Fees ($), Accrued Interest ($), Amount ($),
    Cash Balance ($), Settlement Date

The parser is pure — no DB, no FX lookup. The importer service is what
attaches FX rates and writes rows.
"""

from __future__ import annotations

import csv
import hashlib
import io
from collections.abc import Iterable, Iterator
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

from investment_dashboard.adapters.fidelity.action_map import map_action
from investment_dashboard.adapters.importer_types import (
    ParsedTransactionRow,
    UnknownActionError,
)

_DATE_FORMATS = ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y")


def _normalise_header(h: str) -> str:
    return h.strip().lower().replace("(", "").replace(")", "").replace("$", "").strip()


def _parse_date(s: str) -> date:
    s = s.strip()
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"Unrecognised date format: {s!r}")


def _parse_decimal(s: str | None) -> Decimal | None:
    if s is None:
        return None
    cleaned = s.replace(",", "").replace("$", "").strip()
    if not cleaned or cleaned in {"-", "--"}:
        return None
    try:
        return Decimal(cleaned)
    except InvalidOperation as exc:
        raise ValueError(f"Bad decimal: {s!r}") from exc


def _hash_external_id(*parts: object) -> str:
    payload = "|".join(str(p) for p in parts)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:32]


def _iter_dict_rows(content: str) -> Iterator[dict[str, str]]:
    """Yield CSV rows with normalised header keys.

    Fidelity exports occasionally prepend a few "Account Summary" or
    disclaimer lines before the header. We skip blank lines and locate
    the first row that contains an ``Action`` column.
    """
    # Find the actual header line.
    lines = content.splitlines()
    header_idx = -1
    for i, line in enumerate(lines):
        lowered = line.lower()
        if "run date" in lowered and "action" in lowered:
            header_idx = i
            break
    if header_idx == -1:
        raise ValueError("Fidelity CSV: no header row containing 'Run Date' and 'Action'")
    body = "\n".join(lines[header_idx:])
    reader = csv.DictReader(io.StringIO(body))
    if reader.fieldnames is None:
        return
    normalised = [_normalise_header(h) for h in reader.fieldnames]
    reader.fieldnames = normalised
    for row in reader:
        # Skip blank lines / summary rows lacking action.
        if not row.get("action"):
            continue
        yield row


def parse_fidelity_csv(content: str) -> Iterable[ParsedTransactionRow]:
    """Parse Fidelity transaction CSV text. Yields :class:`ParsedTransactionRow`.

    Unknown actions raise :class:`UnknownActionError` — callers can catch
    per-row and surface them in the UI's "rows skipped" report.
    """
    results: list[ParsedTransactionRow] = []
    for row in _iter_dict_rows(content):
        action = row["action"]
        try:
            kind = map_action(action)
        except UnknownActionError:
            raise
        run_date = _parse_date(row["run date"])
        settlement_raw = row.get("settlement date") or ""
        settlement = _parse_date(settlement_raw) if settlement_raw.strip() else None
        symbol = (row.get("symbol") or "").strip() or None
        quantity = _parse_decimal(row.get("quantity"))
        price = _parse_decimal(row.get("price"))
        commission = _parse_decimal(row.get("commission")) or Decimal(0)
        fees = _parse_decimal(row.get("fees")) or Decimal(0)
        amount = _parse_decimal(row.get("amount"))
        raw_amount = amount  # preserved for a stable external_id below
        total_fees = commission + fees

        # Share distribution vs cash distribution. Fidelity books a stock
        # split / in-kind share distribution as a DISTRIBUTION row whose
        # ``Type`` is ``Shares`` (blank price, a share Quantity, and an Amount
        # that is the *cost-basis value*, not cash that moved). The action map
        # can't tell it apart from a cash payout, so it lands as
        # ``dividend_cash``. Treat the share form as a ``split`` (zero-cost
        # share add) instead: the shares belong in the holding and the figure
        # is not income. Counting it as a cash dividend both dropped the shares
        # and invented a phantom dividend.
        row_type = (row.get("type") or "").strip().lower()
        if kind == "dividend_cash" and row_type == "shares" and quantity not in (None, Decimal(0)):
            kind = "split"
            amount = None  # no cash moved; the shares carry the value
            price = None

        # Fidelity may report Price to 2 decimals — recompute for precision
        # when we have quantity > 0 and an amount (spec §5.1 caveat).
        if (
            quantity is not None
            and quantity != 0
            and amount is not None
            and kind in {"buy", "sell", "dividend_reinvest"}
        ):
            recomputed_price = abs(amount - (-total_fees if amount < 0 else total_fees)) / abs(
                quantity
            )
            # Use recomputed price; keep CSV's price in description for audit.
            price = recomputed_price

        gross = quantity * price if (quantity is not None and price is not None) else None

        external_id = _hash_external_id(
            run_date.isoformat(),
            action,
            symbol or "",
            quantity or "",
            price or "",
            raw_amount or "",
        )

        results.append(
            ParsedTransactionRow(
                date=run_date,
                settlement_date=settlement,
                kind=kind,
                symbol=symbol,
                quantity=quantity,
                price_native=price,
                gross_native=gross,
                fees_native=total_fees if total_fees != 0 else None,
                net_native=amount,
                description=row.get("description") or row.get("action"),
                external_id=external_id,
                source="import_fidelity_csv",
                name=(row.get("security description") or row.get("description") or "").strip()
                or None,
            )
        )
    return results
