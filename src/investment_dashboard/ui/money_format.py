"""Money formatting — uniform EUR/USD rendering across every page.

Every page that wants to display monetary values funnels through these
helpers so:

* a single rule decides which symbol/prefix to use (``€`` vs ``$``),
* thousand-separator and decimal precision are consistent,
* ``None`` values render as an em dash rather than crashing the page,
* a single helper renders a "primary + secondary" pair for the
  ``USD ($X) · EUR (€Y)`` layout the overview uses.
"""

from __future__ import annotations

from decimal import Decimal

#: Symbol prefix per currency. Falls back to the ISO code + space for any
#: currency we don't know about yet. v1.3 introduced EUR/USD; v2.2 added
#: DKK (Danish krone — by convention rendered with a trailing "kr"
#: suffix; we use a leading "kr " here for column-alignment consistency
#: with the other prefix-symbol currencies).
_SYMBOLS: dict[str, str] = {"EUR": "€", "USD": "$", "DKK": "kr "}


def currency_symbol(currency: str) -> str:
    """Return the display symbol for an ISO currency code."""
    return _SYMBOLS.get(currency.upper(), f"{currency.upper()} ")


def fmt_money(
    amount: Decimal | None,
    currency: str = "EUR",
    *,
    decimals: int = 2,
) -> str:
    """Format ``amount`` in ``currency`` with thousand separators."""
    if amount is None:
        return "—"
    return f"{currency_symbol(currency)}{amount:,.{decimals}f}"


def fmt_pair(
    primary_amount: Decimal | None,
    primary_currency: str,
    secondary_amount: Decimal | None,
    secondary_currency: str,
    *,
    decimals: int = 2,
) -> tuple[str, str]:
    """Format two amounts (primary big, secondary small) for KPI cards.

    Returns ``(primary_str, secondary_str)``. Either side renders as
    ``"—"`` when its amount is ``None``.
    """
    return (
        fmt_money(primary_amount, primary_currency, decimals=decimals),
        fmt_money(secondary_amount, secondary_currency, decimals=decimals),
    )
