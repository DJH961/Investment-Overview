"""Tests for the EUR/USD currency-effect domain math."""

from __future__ import annotations

from decimal import Decimal

from investment_dashboard.domain.currency_effect import compute_currency_effect


def test_weaker_euro_is_a_tailwind_for_a_euro_investor() -> None:
    """Investing at 1.20 USD/EUR and the rate falling to 1.00 (euro weaker)
    leaves the euro investor with more euros than they put in, all else equal."""
    effect = compute_currency_effect(
        contributions_eur=Decimal("1000"),
        contributions_usd=Decimal("1200"),  # avg invest rate 1.20
        value_eur=Decimal("1200"),
        value_usd=Decimal("1200"),  # current rate 1.00 (euro weaker)
        growth_eur=Decimal("0.20"),
        growth_usd=Decimal("0.00"),
    )
    assert effect.avg_invest_rate == Decimal("1.2")
    assert effect.current_rate == Decimal("1")
    # Rate fell ~16.7% (1.0/1.2 - 1).
    assert effect.rate_change_pct is not None
    assert effect.rate_change_pct < 0
    # Currency added 20pp of the EUR return that USD didn't see.
    assert effect.currency_effect_pp == Decimal("0.20")
    # FX P&L in EUR: 1200 EUR now vs 1200/1.2 = 1000 had the rate held => +200.
    assert effect.fx_pnl_eur == Decimal("200")
    assert effect.repatriation_value_eur == Decimal("1200")
    assert effect.breakeven_rate == Decimal("1.2")


def test_no_usd_value_degrades_to_none() -> None:
    effect = compute_currency_effect(
        contributions_eur=Decimal("1000"),
        contributions_usd=Decimal("1100"),
        value_eur=Decimal("1200"),
        value_usd=None,
        growth_eur=None,
        growth_usd=None,
    )
    assert effect.current_rate is None
    assert effect.fx_pnl_eur is None
    assert effect.currency_effect_pp is None
    # The average invest rate is still computable from contributions alone.
    assert effect.avg_invest_rate == Decimal("1.1")
    # Repatriation value is just the EUR value, which we do know.
    assert effect.repatriation_value_eur == Decimal("1200")


def test_zero_contributions_yield_no_average_rate() -> None:
    effect = compute_currency_effect(
        contributions_eur=Decimal("0"),
        contributions_usd=Decimal("0"),
        value_eur=Decimal("100"),
        value_usd=Decimal("108"),
        growth_eur=Decimal("0.05"),
        growth_usd=Decimal("0.04"),
    )
    assert effect.avg_invest_rate is None
    assert effect.rate_change_pct is None
    assert effect.fx_pnl_eur is None
    # Current rate still derives from the live values.
    assert effect.current_rate == Decimal("1.08")
    # Currency effect (growth difference) is independent of the average rate.
    assert effect.currency_effect_pp == Decimal("0.01")


def test_stronger_euro_is_a_headwind() -> None:
    effect = compute_currency_effect(
        contributions_eur=Decimal("1000"),
        contributions_usd=Decimal("1000"),  # avg 1.00
        value_eur=Decimal("1000"),
        value_usd=Decimal("1200"),  # current 1.20 (euro stronger)
        growth_eur=Decimal("0.00"),
        growth_usd=Decimal("0.20"),
    )
    assert effect.rate_change_pct == Decimal("0.2")
    assert effect.currency_effect_pp == Decimal("-0.20")
    # FX P&L: 1000 EUR now vs 1200/1.0 = 1200 had the rate held => -200.
    assert effect.fx_pnl_eur == Decimal("-200")
