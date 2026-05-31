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
#: currency we don't know about yet. v1.3 introduced EUR/USD; the v2.2
#: DKK leg was dropped in v2.4 so the symbol table mirrors the supported
#: currencies again.
_SYMBOLS: dict[str, str] = {"EUR": "€", "USD": "$"}

#: Uniform number of fractional digits used to render *share* quantities in
#: every table, so a holding reads the same whether it appears on the
#: overview, the transactions ledger or the rebalance calculator.
SHARES_DECIMALS = 4


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


def dual_money(
    eur: Decimal | None,
    usd: Decimal | None,
    *,
    primary: str = "USD",
    decimals: int = 2,
) -> str:
    """Inline ``"$1,234.56 / €1,123.45"`` pair for dense table cells.

    v2.5 — every monetary cell in every table renders both currencies
    side-by-side. ``primary`` controls which side comes first (the
    user's chosen display currency).
    """
    primary = primary.upper()
    if primary == "EUR":
        return f"{fmt_money(eur, 'EUR', decimals=decimals)} / {fmt_money(usd, 'USD', decimals=decimals)}"
    return (
        f"{fmt_money(usd, 'USD', decimals=decimals)} / {fmt_money(eur, 'EUR', decimals=decimals)}"
    )


def fmt_pct(value: Decimal | None, *, decimals: int = 2) -> str:
    """Render a fractional percentage (``0.1234`` → ``"12.34 %"``)."""
    if value is None:
        return "—"
    return f"{value * 100:,.{decimals}f} %"


def fmt_shares(value: Decimal | None, *, decimals: int = SHARES_DECIMALS) -> str:
    """Render a share quantity with a uniform number of decimal places.

    Every table renders share counts through this helper so a holding shows
    the same precision regardless of the page it appears on. ``None`` renders
    as an empty cell (the convention used by the AG-Grid tables).
    """
    if value is None:
        return ""
    return f"{value:,.{decimals}f}"


def aggrid_money_formatter(currency: str, *, decimals: int = 2) -> str:
    """Build an AG-Grid ``valueFormatter`` (JS) for a numeric money column.

    Renders the value with thousand separators, a fixed number of decimals
    (cents by default) and the currency symbol prefixed, so a column reads e.g.
    ``"€1,234.56"`` / ``"$1,234.56"`` and EUR vs USD is unambiguous. ``null``
    blanks out.
    """
    symbol = currency_symbol(currency)
    return (
        f"params.value == null ? '' : '{symbol}' + params.value.toLocaleString("
        f"undefined,{{minimumFractionDigits:{decimals},maximumFractionDigits:{decimals}}})"
    )


def dual_pct(
    eur_pct: Decimal | None,
    usd_pct: Decimal | None,
    *,
    primary: str = "USD",
    decimals: int = 2,
) -> str:
    """Inline ``"12.34 % (USD) / 10.10 % (EUR)"`` for KPIs whose value
    legitimately differs by currency (XIRR, Total Growth)."""
    primary = primary.upper()
    eur_s = f"{fmt_pct(eur_pct, decimals=decimals)} (EUR)"
    usd_s = f"{fmt_pct(usd_pct, decimals=decimals)} (USD)"
    if primary == "EUR":
        return f"{eur_s} / {usd_s}"
    return f"{usd_s} / {eur_s}"
