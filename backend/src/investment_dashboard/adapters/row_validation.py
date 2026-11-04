"""Light per-row consistency checks for parsed broker rows (audit D4).

The broker parsers are deliberately tolerant — they map whatever the export
contains onto the ledger schema without second-guessing the numbers. That
let a handful of corrupt or surprising rows through silently (a negative
price, an ``Amount`` that doesn't reconcile with ``Quantity × Price``).

These checks don't *reject* a row — the export is the user's own brokerage
record and unusual-but-real edge cases exist — they emit **warnings** that
the importer surfaces so the user can eyeball anything that looks off,
turning a previously-silent mis-import into a visible one.
"""

from __future__ import annotations

from dataclasses import replace
from decimal import Decimal

from investment_dashboard.adapters.importer_types import ParsedTransactionRow

#: Kinds for which ``|net| ≈ |quantity × price|`` (± fees) should hold. Cash
#: distributions, splits, deposits, fees etc. legitimately break that identity.
_TRADE_KINDS = frozenset({"buy", "sell", "dividend_reinvest"})

#: Relative tolerance for the amount/quantity×price reconciliation. Brokers
#: round price to a few decimals, so allow ~1% slack before warning.
_RECONCILE_TOLERANCE = Decimal("0.01")


def _reconcile_gap(row: ParsedTransactionRow) -> Decimal | None:
    """``|qty * price|`` when a trade's amount does not reconcile with it, else ``None``."""
    qty, price, net = row.quantity, row.price_native, row.net_native
    if (
        row.kind not in _TRADE_KINDS
        or qty is None
        or price is None
        or net is None
        or qty == 0
        or price <= 0
    ):
        return None
    expected = abs(qty * price)
    fees = abs(row.fees_native) if row.fees_native is not None else Decimal(0)
    # Allow the booked amount to differ from quantity×price by the fees
    # plus a small rounding tolerance, in either direction.
    slack = expected * _RECONCILE_TOLERANCE + fees
    return expected if abs(abs(net) - expected) > slack else None


def validate_row(row: ParsedTransactionRow) -> list[str]:
    """Return a list of human-readable consistency warnings for ``row``.

    An empty list means the row passed every check. The checks are
    intentionally conservative (see module docstring) — anything they flag
    is reported but still imported.
    """
    warnings: list[str] = []

    price = row.price_native
    if price is not None and price < 0:
        warnings.append(f"negative price {price}")

    qty = row.quantity
    if qty is not None and qty == 0 and row.kind in _TRADE_KINDS:
        warnings.append(f"{row.kind} row with zero quantity")

    if _reconcile_gap(row) is not None:
        warnings.append(
            f"amount {row.net_native} does not reconcile with quantity*price "
            f"({qty}*{price}={(qty or 0) * (price or 0)})"
        )

    return warnings


# -- resolving a flagged row (import preview) --------------------------------

#: Import it exactly as the file has it (the user checked it).
FIX_KEEP = "keep"
#: Keep amount and quantity, recompute the price from them.
FIX_PRICE = "fix_price"
#: Leave the row out of the import.
FIX_SKIP = "skip"

_PRICE_Q = Decimal("0.000001")


def price_from_amount(row: ParsedTransactionRow) -> Decimal | None:
    """The price that makes ``row`` reconcile: (|amount| ∓ fees) / |quantity|.

    A buy pays the fees on top (``|net| = qty×price + fees``); a sale has them
    taken off (``|net| = qty×price − fees``). ``None`` when there is nothing to
    compute it from.
    """
    qty, net = row.quantity, row.net_native
    if qty is None or net is None or qty == 0:
        return None
    fees = abs(row.fees_native) if row.fees_native is not None else Decimal(0)
    base = abs(net) + fees if row.kind == "sell" else abs(net) - fees
    if base <= 0:
        return None
    return (base / abs(qty)).quantize(_PRICE_Q)


def fixes_for(row: ParsedTransactionRow) -> list[str]:
    """The resolutions offered for a flagged row (empty when it passed every check)."""
    if not validate_row(row):
        return []
    out = [FIX_KEEP]
    if _reconcile_gap(row) is not None and price_from_amount(row) is not None:
        out.append(FIX_PRICE)
    out.append(FIX_SKIP)
    return out


def apply_fix(row: ParsedTransactionRow, fix: str | None) -> ParsedTransactionRow | None:
    """``row`` with ``fix`` applied; ``None`` when the row is skipped.

    The ``external_id`` is kept, so a later re-import of the same file still
    deduplicates against the corrected row.
    """
    if fix == FIX_SKIP:
        return None
    if fix == FIX_PRICE:
        price = price_from_amount(row)
        if price is None or row.quantity is None:
            return row
        gross = row.gross_native
        if gross is not None:
            new_gross = abs(row.quantity) * price
            gross = -new_gross if gross < 0 else new_gross
        return replace(row, price_native=price, gross_native=gross)
    return row
