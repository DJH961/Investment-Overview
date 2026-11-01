"""Holdings read-model: one row per instrument, ccy legs selected, never converted."""

from __future__ import annotations

from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from api._seed import RATE_NOW, seed_ledger
from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.readmodels import holdings
from investment_dashboard.readmodels.queries.overview_query import (
    build_holding_cards,
    compute_instrument_metrics,
)
from investment_dashboard.services.positions_service import compute_positions

D = Decimal


def test_merge_positions_sums_accounts_per_instrument(session: Session) -> None:
    seed_ledger(session)
    raw = compute_positions(session, as_of=exchange_today())
    assert len(raw) == 3  # VTI in two accounts + BND
    merged = holdings.merge_positions_by_instrument(raw)
    by_symbol = {p.instrument.symbol: p for p in merged}
    assert set(by_symbol) == {"VTI", "BND"}
    vti = by_symbol["VTI"]
    assert vti.shares == 15
    assert vti.cost_basis_native == D("3050")
    assert vti.current_value_native == D("3750")
    assert vti.current_value_eur == pytest.approx(D("3750") / RATE_NOW)


def test_unmerged_cards_would_double_count(session: Session) -> None:
    """Regression guard for the cross-cutting risk (instrument in two accounts)."""
    seed_ledger(session)
    as_of = exchange_today()
    raw = compute_positions(session, as_of=as_of)
    naive_metrics = compute_instrument_metrics(session, raw, as_of=as_of)
    naive = build_holding_cards(raw, metrics=naive_metrics)
    assert len(naive) == 3  # one card per account row
    assert sum((c.value_usd or 0 for c in naive), D(0)) != D("5150")  # the problem merge avoids
    merged = holdings.merge_positions_by_instrument(raw)
    metrics = compute_instrument_metrics(session, merged, as_of=as_of)
    cards = build_holding_cards(merged, metrics=metrics)
    assert len(cards) == 2
    assert sum((c.value_usd or 0 for c in cards), D(0)) == D("5150")


def test_build_selects_legs_without_converting_returns(session: Session) -> None:
    seed_ledger(session)
    eur = holdings.build(session, ccy="EUR")
    usd = holdings.build(session, ccy="USD")
    rows_eur = {r["symbol"]: r for r in eur["holdings"]}
    rows_usd = {r["symbol"]: r for r in usd["holdings"]}
    assert D(usd["total_value"]) == D("5150")
    # Metrics round money to the cent.
    assert D(eur["total_value"]) == pytest.approx(D("5150") / RATE_NOW, abs=D("0.01"))
    # EUR growth differs from USD growth (FX moved 1.10 -> 1.20); neither is derived from the other.
    assert D(rows_eur["VTI"]["total_growth"]) != D(rows_usd["VTI"]["total_growth"])
    assert D(rows_usd["VTI"]["capital_gain"]) == D("700")
    assert D(rows_eur["VTI"]["xirr"]) != D(rows_usd["VTI"]["xirr"])
    assert rows_eur["VTI"]["price_native"] == rows_usd["VTI"]["price_native"]
    assert rows_usd["BND"]["price_type"] == "market"
    assert usd["holdings"][0]["symbol"] == "VTI"  # largest first


def test_pick_selects_the_requested_leg() -> None:
    assert holdings.pick(D(1), D(2), "EUR") == 1
    assert holdings.pick(D(1), D(2), "USD") == 2
    assert holdings.pick(D(1), None, "USD") is None  # a missing USD leg stays missing
