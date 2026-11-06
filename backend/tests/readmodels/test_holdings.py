"""Holdings read-model: one row per instrument, ccy legs selected, never converted."""

from __future__ import annotations

from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from api._seed import RATE_NOW, seed_ledger
from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.readmodels import holdings
from investment_dashboard.readmodels.queries.overview_query import (
    HoldingCard,
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


def test_mutual_fund_rows_read_as_nav_and_carry_market_time(session: Session) -> None:
    """A NAV fund is never a "market close": the row says ``price_type == "nav"``."""
    ids = seed_ledger(session)
    from investment_dashboard.repositories import instruments_repo

    bnd = instruments_repo.get_instrument(session, ids["BND"])
    assert bnd is not None
    bnd.asset_class = "mutual_fund"
    session.flush()
    rows = {r["symbol"]: r for r in holdings.build(session, ccy="USD")["holdings"]}
    assert rows["BND"]["price_type"] == "nav"
    assert rows["VTI"]["price_type"] == "market"
    # The provider's market time is passed through (None when never recorded).
    assert "price_market_at" in rows["VTI"]
    assert rows["VTI"]["price_market_at"] is None


def test_pick_selects_the_requested_leg() -> None:
    assert holdings.pick(D(1), D(2), "EUR") == 1
    assert holdings.pick(D(1), D(2), "USD") == 2
    assert holdings.pick(D(1), None, "USD") is None  # a missing USD leg stays missing


def test_group_total_growth_is_total_return_over_cost_basis(session: Session) -> None:
    from dataclasses import replace

    seed_ledger(session)
    usd = holdings.build(session, ccy="USD", group_by="currency")
    (group,) = usd["groups"]
    # VTI +700 and BND -100 on cost 3,050 + 1,500: 600 / 4,550 (a simple return on cost).
    assert group["count"] == 2
    assert D(group["total_return"]) == D("600")
    assert D(group["cost_basis"]) == D("4550")
    assert D(group["total_growth"]) == D("600") / D("4550")
    # EUR is built from its own legs (never the USD return converted).
    (eur_group,) = holdings.build(session, ccy="EUR", group_by="currency")["groups"]
    assert D(eur_group["total_growth"]) == D(eur_group["total_return"]) / D(eur_group["cost_basis"])

    # Null when a member lacks the cost leg, or the cost basis is not positive.
    as_of = exchange_today()
    positions = holdings.merge_positions_by_instrument(compute_positions(session, as_of=as_of))
    cards = build_holding_cards(
        positions, metrics=compute_instrument_metrics(session, positions, as_of=as_of)
    )
    by_id = {p.instrument.id: p for p in positions}
    rows = [holdings.holding_row(c, by_id[c.instrument_id], None, "USD") for c in cards]
    broken = [replace(cards[0], cost_basis_usd=None), *cards[1:]]
    assert holdings.build_groups(rows, broken, "currency", "USD")[0]["total_growth"] is None
    zero = [replace(c, cost_basis_usd=D(0)) for c in cards]
    assert holdings.build_groups(rows, zero, "currency", "USD")[0]["total_growth"] is None


def _mm_card(
    symbol: str,
    *,
    unrealised: Decimal,
    income: Decimal,
    is_money_market: bool = True,
) -> HoldingCard:
    """A holding carrying only the return-split fields ``_summary`` classifies on."""
    return HoldingCard(
        instrument_id=abs(hash(symbol)) % 100000,
        symbol=symbol,
        name=f"{symbol} Fund",
        category="",
        native_currency="USD",
        is_money_market=is_money_market,
        value_warning=False,
        price_data_warning=False,
        shares=D("10240"),
        current_price_native=D("1"),
        avg_price_native=D("1"),
        expense_ratio=None,
        value_eur=D("10240"),
        value_usd=D("10240"),
        cost_basis_eur=D("10000"),
        cost_basis_usd=D("10000"),
        capital_gain_eur=None,
        capital_gain_usd=None,
        total_growth_eur=None,
        total_growth_usd=None,
        xirr_eur=None,
        xirr_usd=None,
        daily_growth_eur=None,
        daily_growth_usd=None,
        daily_move_eur=None,
        daily_move_usd=None,
        ytd_growth_eur=None,
        ytd_growth_usd=None,
        weight=None,
        price_as_of=None,
        updated_at=None,
        income_eur=income,
        income_usd=income,
        unrealised_gain_eur=unrealised,
        unrealised_gain_usd=unrealised,
    )


def test_cash_fund_earning_only_dividends_counts_as_in_profit() -> None:
    """A money-market fund holds its NAV at par: all of its return is income.

    Classifying on the capital gain left such a holding in neither bucket (or, on a
    rounding cent the wrong way, in "in loss") while its own Total return column
    read clearly positive. It is judged on total return.
    """
    cash = _mm_card("VMFXX", unrealised=D("0"), income=D("240"))
    summary = holdings._summary([], [cash], "EUR")
    assert summary["in_profit"] == 1
    assert summary["in_loss"] == 0


def test_cash_fund_with_a_rounding_cent_against_it_is_still_in_profit() -> None:
    """An FX-leg cent of unrealised loss must not outvote $240 of dividends."""
    cash = _mm_card("VMFXX", unrealised=D("-0.37"), income=D("240"))
    assert holdings._summary([], [cash], "EUR")["in_profit"] == 1
    assert holdings._summary([], [cash], "EUR")["in_loss"] == 0


def test_a_genuinely_losing_holding_is_still_counted_as_in_loss() -> None:
    """The fix must not make everything "in profit": dividends can be outweighed."""
    losing = _mm_card("XXXX", unrealised=D("-900"), income=D("240"), is_money_market=False)
    summary = holdings._summary([], [losing], "EUR")
    assert summary["in_profit"] == 0
    assert summary["in_loss"] == 1
