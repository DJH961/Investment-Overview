"""Native-USD valuation of a position (never a EUR figure converted back).

💱 CURRENCY (rule in ``AGENTS.md``): a USD figure is never ``value_eur * rate``
for a holding that is itself USD. A USD-native account counts at its native
amount; only genuinely non-USD holdings are converted into USD, at the
valuation instant's rate.
"""

from __future__ import annotations

from decimal import Decimal

from investment_dashboard.services.positions_service import Position

ZERO = Decimal(0)


def position_value_usd(p: Position, usd_per_eur: Decimal | None) -> Decimal:
    """USD value of one position at one instant.

    USD accounts: the native value. Other currencies go through EUR at
    ``usd_per_eur``; with no usable rate they are omitted (the same policy as
    ``positions_service.total_portfolio_value_usd``), never relabelled.
    """
    if p.account.native_currency.upper() == "USD":
        return p.current_value_native
    if usd_per_eur is None or usd_per_eur <= ZERO:
        return ZERO
    return p.current_value_eur * usd_per_eur
