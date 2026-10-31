"""Projection read-model (extracted from the NiceGUI page)."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from investment_dashboard.readmodels.projection import (
    ProjectionSeed,
    build_params,
    project,
)


def _seed(primary: str = "EUR") -> ProjectionSeed:
    return ProjectionSeed(
        monthly=False,
        primary=primary,
        starting_eur=Decimal(1000),
        starting_usd=Decimal(1100),
        avg_contribution_eur=Decimal(100),
        avg_contribution_usd=Decimal(120),
        expected_rate_eur=Decimal("0.05"),
        expected_rate_usd=Decimal("0.08"),
        usd_per_eur=Decimal("1.1"),
        xirr_available=True,
        today=date(2026, 1, 1),
    )


def test_build_params_spread_between_wallets() -> None:
    eur, usd = build_params(
        _seed("EUR"),
        expected_primary=Decimal("0.06"),
        band=Decimal("0.02"),
        stepup=Decimal(0),
        inflation=Decimal(0),
        horizon=3,
        contrib_primary=Decimal(100),
    )
    # USD expected = EUR expected + historical spread (0.08 - 0.05).
    assert eur.annual_rates["expected"] == Decimal("0.06")
    assert usd.annual_rates["expected"] == Decimal("0.09")
    assert eur.annual_rates["pessimistic"] == Decimal("0.04")
    assert usd.base_contribution == Decimal("110.0")  # forward spot assumption only
    assert eur.starting_value == 1000
    assert usd.starting_value == 1100


def test_project_uses_own_wallet_start_and_defaults() -> None:
    usd = project(_seed(), ccy="USD", horizon=1, band=Decimal(0), inflation=Decimal(0))
    # No conversion of the return: USD wallet 1100 at its own 8 % + 120 contribution.
    assert Decimal(usd["points"][0]["expected"]) == Decimal(1100) * Decimal("1.08") + 120
    eur = project(_seed(), ccy="EUR", horizon=1, band=Decimal(0), inflation=Decimal(0))
    assert Decimal(eur["points"][0]["expected"]) == Decimal(1000) * Decimal("1.05") + 100
    assert usd["inputs"]["expected_rate"] == "0.08"
