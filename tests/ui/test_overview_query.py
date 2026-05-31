"""Tests for the overview query helpers (positions table + treemap aggregation)."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.models.transaction import TransactionSource
from investment_dashboard.repositories import (
    accounts_repo,
    fx_repo,
    instrument_overrides_repo,
    instruments_repo,
    prices_repo,
)
from investment_dashboard.ui.pages._overview_query import (
    allocation_treemap,
    get_positions,
    position_rows,
)


@pytest.fixture
def seeded(session: Session) -> None:
    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Fidelity",
        native_currency="USD",
        account_type="brokerage",
    )
    vti = instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
    bnd = instruments_repo.get_or_create(session, symbol="BND", asset_class="etf")
    instrument_overrides_repo.set_category(session, vti.id, "US Stocks")
    instrument_overrides_repo.set_category(session, bnd.id, "US Bonds")
    prices_repo.upsert_closes(session, vti.id, {date.today(): Decimal("230.00")})
    prices_repo.upsert_closes(session, bnd.id, {date.today(): Decimal("75.00")})
    # A flat EUR→USD = 1.25 on both the trade date and today, so EUR figures
    # are exactly the USD ones / 1.25 and the growth fractions match.
    fx_repo.upsert_rates(
        session,
        {date(2024, 1, 5): Decimal("1.25"), date.today(): Decimal("1.25")},
    )
    session.add_all(
        [
            Transaction(
                account_id=acct.id,
                date=date(2024, 1, 5),
                kind="buy",
                instrument_id=vti.id,
                quantity=Decimal("10"),
                price_native=Decimal("220"),
                net_native=Decimal("-2200"),
                source=TransactionSource.MANUAL,
            ),
            Transaction(
                account_id=acct.id,
                date=date(2024, 1, 5),
                kind="buy",
                instrument_id=bnd.id,
                quantity=Decimal("20"),
                price_native=Decimal("74"),
                net_native=Decimal("-1480"),
                source=TransactionSource.MANUAL,
            ),
        ]
    )
    session.flush()


def test_instrument_daily_growth_per_currency(session: Session, seeded: None) -> None:
    """Daily growth uses the two most recent print dates, converted at each
    day's own FX, so EUR and USD differ by the intraday FX move."""
    from investment_dashboard.ui.pages._overview_query import compute_instrument_metrics

    vti = instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
    yesterday = date.today() - timedelta(days=1)
    # Prior close + a slightly different FX on the prior day vs today.
    prices_repo.upsert_closes(session, vti.id, {yesterday: Decimal("220.00")})
    fx_repo.upsert_rates(session, {yesterday: Decimal("1.20")})
    session.flush()

    positions = get_positions(session)
    metrics = compute_instrument_metrics(session, positions)
    im = metrics[vti.id]
    # USD price move 220 -> 230 = +4.5454...%
    assert im.daily_growth_usd is not None
    assert abs(im.daily_growth_usd - Decimal("0.04545")) < Decimal("0.001")
    # EUR move includes the FX shift 1.20 -> 1.25, so it differs from USD.
    assert im.daily_growth_eur is not None
    assert im.daily_growth_eur != im.daily_growth_usd


def test_positions_table_has_growth_pct(session: Session, seeded: None) -> None:
    from investment_dashboard.ui.pages._overview_query import compute_instrument_metrics

    positions = get_positions(session)
    metrics = compute_instrument_metrics(session, positions)
    rows = position_rows(positions, metrics=metrics)
    symbols = {r["symbol"] for r in rows}
    assert symbols == {"VTI", "BND"}
    vti_row = next(r for r in rows if r["symbol"] == "VTI")
    # cost 2200, current 2300 ⇒ +4.55 % in both currencies (flat FX).
    assert abs(vti_row["total_growth_usd_signed"] - 0.04545) < 0.001
    assert abs(vti_row["total_growth_eur_signed"] - 0.04545) < 0.001


def test_treemap_aggregates_by_category(session: Session, seeded: None) -> None:
    positions = get_positions(session)
    data = allocation_treemap(positions)
    labels = {d.label for d in data}
    assert labels == {"US Stocks", "US Bonds"}
    # US Stocks (VTI=2300) > US Bonds (BND=1500) ⇒ sorted descending
    assert data[0].label == "US Stocks"


def test_treemap_handles_no_positions(session: Session) -> None:
    assert allocation_treemap([]) == []


def test_instrument_metrics_xirr_and_dividend_inclusive_growth(
    session: Session, seeded: None
) -> None:
    from investment_dashboard.ui.pages._overview_query import compute_instrument_metrics

    positions = get_positions(session)
    metrics = compute_instrument_metrics(session, positions)
    vti = next(p for p in positions if p.instrument.symbol == "VTI")
    im = metrics[vti.instrument.id]
    # VTI USD: cost 2200, value 2300 ⇒ gain 100 (USD), 80 (EUR @ 1.25).
    assert im.capital_gain_usd == Decimal("100.00")
    assert im.capital_gain_eur == Decimal("80.00")
    assert im.cost_basis_usd == Decimal("2200.00")
    assert im.cost_basis_eur == Decimal("1760.00")
    # Growth +4.55 % in both wallets (flat FX).
    assert im.total_growth_usd is not None
    assert abs(im.total_growth_usd - Decimal("0.04545")) < Decimal("0.001")
    assert abs(im.total_growth_eur - Decimal("0.04545")) < Decimal("0.001")
    # A single buy followed by a higher terminal mark ⇒ positive XIRR per ccy.
    assert im.xirr_usd is not None
    assert im.xirr_usd > Decimal(0)
    assert im.xirr_eur is not None
    assert im.xirr_eur > Decimal(0)


def test_position_rows_enriched_with_metrics(session: Session, seeded: None) -> None:
    from investment_dashboard.ui.pages._overview_query import compute_instrument_metrics

    positions = get_positions(session)
    metrics = compute_instrument_metrics(session, positions)
    rows = position_rows(positions, display_currency="USD", metrics=metrics)
    vti_row = next(r for r in rows if r["symbol"] == "VTI")
    assert abs(vti_row["total_growth_usd_signed"] - 0.04545) < 0.001
    assert vti_row["total_growth_usd_signed"] > 0
    assert vti_row["xirr_usd_signed"] != 0
    assert vti_row["capital_gain_usd_num"] == 100.0
    assert vti_row["capital_gain_eur_num"] == 80.0


def test_market_verdict_beating_and_trailing(session: Session, seeded: None) -> None:
    from investment_dashboard.ui.pages._overview_query import compute_market_verdict

    # Seed the default benchmark (VT) with +10 % over the window.
    vt = instruments_repo.get_or_create(session, symbol="VT", asset_class="etf")
    prices_repo.upsert_closes(
        session,
        vt.id,
        {date(2024, 1, 5): Decimal("100.00"), date.today(): Decimal("110.00")},
    )
    session.flush()

    beating = compute_market_verdict(session, portfolio_return=Decimal("0.20"))
    assert beating.benchmark_symbol == "VT"
    assert beating.benchmark_return is not None
    assert abs(beating.benchmark_return - Decimal("0.10")) < Decimal("0.0001")
    assert beating.beating is True

    trailing = compute_market_verdict(session, portfolio_return=Decimal("0.05"))
    assert trailing.beating is False


def test_market_verdict_none_without_benchmark_history(session: Session, seeded: None) -> None:
    from investment_dashboard.ui.pages._overview_query import compute_market_verdict

    verdict = compute_market_verdict(session, portfolio_return=Decimal("0.10"))
    assert verdict.beating is None
    assert verdict.benchmark_return is None


def test_partial_sale_uses_average_cost_growth(session: Session) -> None:
    """A partial sale must release a proportional slice of the cost basis in
    both wallets, otherwise growth is massively deflated (v2.9.6 fix)."""
    from investment_dashboard.ui.pages._overview_query import compute_instrument_metrics

    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Fidelity",
        native_currency="USD",
        account_type="brokerage",
    )
    acme = instruments_repo.get_or_create(session, symbol="ACME", asset_class="etf")
    prices_repo.upsert_closes(session, acme.id, {date.today(): Decimal("150.00")})
    fx_repo.upsert_rates(
        session,
        {date(2024, 1, 5): Decimal("1.25"), date.today(): Decimal("1.25")},
    )
    session.add_all(
        [
            Transaction(
                account_id=acct.id,
                date=date(2024, 1, 5),
                kind="buy",
                instrument_id=acme.id,
                quantity=Decimal("10"),
                price_native=Decimal("100"),
                net_native=Decimal("-1000"),
                source=TransactionSource.MANUAL,
            ),
            Transaction(
                account_id=acct.id,
                date=date(2024, 6, 5),
                kind="sell",
                instrument_id=acme.id,
                quantity=Decimal("-5"),
                price_native=Decimal("150"),
                net_native=Decimal("750"),
                source=TransactionSource.MANUAL,
            ),
        ]
    )
    session.flush()

    positions = get_positions(session)
    metrics = compute_instrument_metrics(session, positions)
    im = metrics[acme.id]
    # 5 shares remain; half the $1000 basis is released ⇒ cost $500.
    assert im.cost_basis_usd == Decimal("500.00")
    # Value 5 × $150 = $750 ⇒ gain $250, growth +50 % (not a deflated loss).
    assert im.capital_gain_usd == Decimal("250.00")
    assert im.total_growth_usd is not None
    assert abs(im.total_growth_usd - Decimal("0.5")) < Decimal("0.001")
