"""How the EUR ↔ USD exchange rate has affected a EUR-based investor.

The dashboard's owner funds the portfolio in **EUR**, buys USD-denominated
assets in the US, but still lives in the euro zone — so the money will likely
be converted *back* to EUR one day. Between paying in and cashing out, the
EUR/USD rate moves, and that move is a real gain or loss on top of the assets'
own performance.

This module isolates that currency effect as pure
:class:`decimal.Decimal` math so it can be unit-tested and reused. It compares
two rates:

* the **average rate you invested at** — the USD bought per EUR contributed,
  weighted by contribution size (``contributions_usd / contributions_eur``), and
* the **current rate** — today's USD per EUR (``value_usd / value_eur``).

From those it derives the FX drift, the slice of your EUR return that came from
currency rather than the assets, and the EUR you'd gain or lose purely from the
rate change if you repatriated now.

All rates are quoted **USD per EUR** (the conventional EUR/USD quote): a *lower*
rate means the euro has weakened, which is *favourable* for a euro investor
holding dollar assets (each dollar buys back more euros).
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

ZERO = Decimal(0)


@dataclass(frozen=True)
class CurrencyEffect:
    """The EUR/USD currency effect on a portfolio, all figures EUR/USD-aware.

    Every field is ``None`` when it cannot be computed (no USD value cached, no
    contributions, or a non-positive rate), so the UI degrades to "—" rather
    than showing a misleading zero.
    """

    #: Weighted average rate you invested at (USD per EUR), or ``None``.
    avg_invest_rate: Decimal | None
    #: Current spot rate (USD per EUR), or ``None``.
    current_rate: Decimal | None
    #: Fractional change of the current rate vs the average invest rate
    #: (``current / avg - 1``). Negative ⇒ the euro weakened (good for you).
    rate_change_pct: Decimal | None
    #: Slice of your total EUR return attributable to FX, in fractional points
    #: (``growth_eur - growth_usd``). Positive ⇒ currency was a tailwind.
    currency_effect_pp: Decimal | None
    #: EUR gained (+) or lost (−) purely from the rate move versus having
    #: invested at the average rate. The FX P&L baked into your EUR value.
    fx_pnl_eur: Decimal | None
    #: What you'd receive converting the whole portfolio back to EUR now.
    repatriation_value_eur: Decimal | None
    #: The rate at which the FX effect nets to zero (== the average invest rate).
    breakeven_rate: Decimal | None


def compute_currency_effect(
    *,
    contributions_eur: Decimal | None,
    contributions_usd: Decimal | None,
    value_eur: Decimal | None,
    value_usd: Decimal | None,
    growth_eur: Decimal | None,
    growth_usd: Decimal | None,
) -> CurrencyEffect:
    """Derive the EUR/USD :class:`CurrencyEffect` from portfolio aggregates.

    Args:
        contributions_eur: Net external contributions in EUR (deposits minus
            withdrawals), as the ledger stored them.
        contributions_usd: The same flows valued in USD at each trade date.
        value_eur: Current portfolio value in EUR (today's spot).
        value_usd: Current portfolio value in USD (today's spot), or ``None``.
        growth_eur: Compounded total growth measured in EUR (fraction).
        growth_usd: Compounded total growth measured in USD (fraction).
    """
    avg_rate: Decimal | None = None
    if (
        contributions_eur is not None
        and contributions_usd is not None
        and contributions_eur > 0
        and contributions_usd > 0
    ):
        avg_rate = contributions_usd / contributions_eur

    current_rate: Decimal | None = None
    if value_eur is not None and value_usd is not None and value_eur > 0 and value_usd > 0:
        current_rate = value_usd / value_eur

    rate_change_pct: Decimal | None = None
    if avg_rate is not None and current_rate is not None and avg_rate != 0:
        rate_change_pct = current_rate / avg_rate - 1

    currency_effect_pp: Decimal | None = None
    if growth_eur is not None and growth_usd is not None:
        currency_effect_pp = growth_eur - growth_usd

    fx_pnl_eur: Decimal | None = None
    if value_usd is not None and value_eur is not None and avg_rate is not None and avg_rate != 0:
        # EUR value today minus the EUR you'd hold had the rate stayed at the
        # average you invested at (same USD assets, valued back at avg_rate).
        fx_pnl_eur = value_eur - value_usd / avg_rate

    return CurrencyEffect(
        avg_invest_rate=avg_rate,
        current_rate=current_rate,
        rate_change_pct=rate_change_pct,
        currency_effect_pp=currency_effect_pp,
        fx_pnl_eur=fx_pnl_eur,
        repatriation_value_eur=value_eur if value_eur is not None and value_eur > 0 else None,
        breakeven_rate=avg_rate,
    )
