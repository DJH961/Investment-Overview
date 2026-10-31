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

from decimal import Decimal

from investment_dashboard.adapters.importer_types import ParsedTransactionRow

#: Kinds for which ``|net| ≈ |quantity × price|`` (± fees) should hold. Cash
#: distributions, splits, deposits, fees etc. legitimately break that identity.
_TRADE_KINDS = frozenset({"buy", "sell", "dividend_reinvest"})

#: Relative tolerance for the amount/quantity×price reconciliation. Brokers
#: round price to a few decimals, so allow ~1% slack before warning.
_RECONCILE_TOLERANCE = Decimal("0.01")


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

    net = row.net_native
    if (
        row.kind in _TRADE_KINDS
        and qty is not None
        and price is not None
        and net is not None
        and qty != 0
        and price > 0
    ):
        expected = abs(qty * price)
        fees = abs(row.fees_native) if row.fees_native is not None else Decimal(0)
        # Allow the booked amount to differ from quantity×price by the fees
        # plus a small rounding tolerance, in either direction.
        slack = expected * _RECONCILE_TOLERANCE + fees
        if abs(abs(net) - expected) > slack:
            warnings.append(
                f"amount {net} does not reconcile with quantity*price ({qty}*{price}={qty * price})"
            )

    return warnings
