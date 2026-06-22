"""Tests for the overview query helpers (positions table + treemap aggregation)."""

from __future__ import annotations

from datetime import date, datetime, timedelta
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


def test_live_eur_usd_spot_shifts_daily_growth_not_history(session: Session, seeded: None) -> None:
    """A live intraday EUR/USD overlay moves *today's* FX leg of daily growth
    while historical YTD figures (priced at past-date FX) stay put."""
    from investment_dashboard.services import fx_service
    from investment_dashboard.ui.pages._overview_query import compute_instrument_metrics

    vti = instruments_repo.get_or_create(session, symbol="VTI", asset_class="etf")
    yesterday = date.today() - timedelta(days=1)
    prices_repo.upsert_closes(session, vti.id, {yesterday: Decimal("220.00")})
    fx_repo.upsert_rates(session, {yesterday: Decimal("1.20")})
    session.flush()

    fx_service.clear_live_spot()
    try:
        base = compute_instrument_metrics(session, get_positions(session))[vti.id]
        # Live spot: EUR/USD jumps from today's ECB 1.25 to 1.32 intraday.
        fx_service.set_live_spot("USD", Decimal("1.32"), observed_on=date.today())
        live = compute_instrument_metrics(session, get_positions(session))[vti.id]
        # The EUR daily growth moved with the live FX; USD (FX-neutral) did not.
        assert live.daily_growth_eur != base.daily_growth_eur
        assert live.daily_growth_usd == base.daily_growth_usd
        # The YTD growth's start value is priced at the Jan FX (1.25), untouched
        # by the live spot — only the current mark revalues.
        assert live.ytd_growth_usd == base.ytd_growth_usd
    finally:
        fx_service.clear_live_spot()


def test_money_market_daily_growth_is_flat_zero(session: Session) -> None:
    """Settlement funds have no price feed; their single-day growth is a flat
    0 (par did not move) rather than an inconsistent em dash."""
    from investment_dashboard.models import Transaction
    from investment_dashboard.models.transaction import TransactionSource
    from investment_dashboard.ui.pages._overview_query import (
        compute_instrument_metrics,
        get_positions,
    )

    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Fidelity",
        native_currency="USD",
        account_type="brokerage",
    )
    spaxx = instruments_repo.get_or_create(session, symbol="SPAXX")
    session.add(
        Transaction(
            account_id=acct.id,
            date=date(2024, 1, 5),
            kind="buy",
            instrument_id=spaxx.id,
            quantity=Decimal("1000"),
            price_native=Decimal("1"),
            net_native=Decimal("-1000"),
            source=TransactionSource.MANUAL,
        )
    )
    session.flush()

    positions = get_positions(session)
    metrics = compute_instrument_metrics(session, positions)
    im = metrics[spaxx.id]
    assert im.daily_growth_usd == Decimal("0")
    assert im.daily_growth_eur == Decimal("0")


def test_money_market_reinvested_dividends_count_as_gain(session: Session) -> None:
    """Money-market funds price at par ($1), so a reinvested dividend is pure
    return — it must surface as a positive gain/growth, not collapse to zero
    by inflating the cost basis (user report: "growth should not be 0")."""
    from investment_dashboard.models import Transaction
    from investment_dashboard.models.transaction import TransactionSource
    from investment_dashboard.ui.pages._overview_query import (
        compute_instrument_metrics,
        get_positions,
    )

    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Fidelity",
        native_currency="USD",
        account_type="brokerage",
    )
    spaxx = instruments_repo.get_or_create(session, symbol="SPAXX")
    session.add(
        Transaction(
            account_id=acct.id,
            date=date(2024, 1, 5),
            kind="buy",
            instrument_id=spaxx.id,
            quantity=Decimal("1000"),
            price_native=Decimal("1"),
            net_native=Decimal("-1000"),
            source=TransactionSource.MANUAL,
        )
    )
    session.add(
        Transaction(
            account_id=acct.id,
            date=date(2024, 2, 5),
            kind="dividend_reinvest",
            instrument_id=spaxx.id,
            quantity=Decimal("5"),
            price_native=Decimal("1"),
            net_native=Decimal("0"),
            source=TransactionSource.MANUAL,
        )
    )
    session.flush()

    positions = get_positions(session)
    pos = next(p for p in positions if p.instrument.id == spaxx.id)
    # 1005 shares at par minus a $1000 cost basis ⇒ $5 of earned dividends.
    assert pos.cost_basis_native == Decimal("1000")
    assert pos.current_value_native == Decimal("1005")

    metrics = compute_instrument_metrics(session, positions)
    im = metrics[spaxx.id]
    # Native total growth is the earned dividends over principal: 5 / 1000.
    assert im.total_growth_pct is not None
    assert im.total_growth_pct > Decimal("0")
    assert abs(im.total_growth_pct - Decimal("0.005")) < Decimal("0.001")
    assert im.capital_gain_native is not None
    assert im.capital_gain_native > Decimal("0")


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


def test_position_rows_flag_price_data_warning(session: Session, seeded: None) -> None:
    positions = get_positions(session)
    vti_id = next(p.instrument.id for p in positions if p.instrument.symbol == "VTI")
    rows = position_rows(positions, price_anomaly_ids={vti_id})
    vti_row = next(r for r in rows if r["symbol"] == "VTI")
    other = next(r for r in rows if r["symbol"] != "VTI")
    assert vti_row["price_data_warning"] is True
    assert other["price_data_warning"] is False


def test_position_rows_default_no_price_data_warning(session: Session, seeded: None) -> None:
    rows = position_rows(get_positions(session))
    assert all(r["price_data_warning"] is False for r in rows)


def test_market_verdict_beating_and_trailing(session: Session, seeded: None) -> None:
    from investment_dashboard.ui.pages._overview_query import compute_market_verdict

    # Fund the simulated benchmark with a real external contribution, and give
    # VT a +10 % move over the window (flat EUR→USD so EUR price == USD close).
    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Cash",
        native_currency="EUR",
        account_type="brokerage",
    )
    session.add(
        Transaction(
            account_id=acct.id,
            date=date(2024, 1, 5),
            kind="deposit",
            quantity=None,
            price_native=None,
            net_native=Decimal("1000"),
            net_eur=Decimal("1000"),
            source=TransactionSource.MANUAL,
        )
    )
    vt = instruments_repo.get_or_create(session, symbol="VT", asset_class="etf")
    prices_repo.upsert_closes(
        session,
        vt.id,
        {date(2024, 1, 5): Decimal("100.00"), date.today(): Decimal("110.00")},
    )
    fx_repo.upsert_rates(
        session,
        {date(2024, 1, 5): Decimal("1.00"), date.today(): Decimal("1.00")},
    )
    session.flush()

    from investment_dashboard.domain.returns import years_between

    # In production ``years`` is the real horizon (first contribution → as_of),
    # which equals the benchmark simulation horizon, so the benchmark's
    # compounded growth collapses back to its 1000 → 1100 total return.
    years = years_between(date(2024, 1, 5), date.today())
    # Portfolio XIRR well above the benchmark's ⇒ beating.
    beating = compute_market_verdict(session, portfolio_xirr=Decimal("5.0"), years=years)
    assert beating.benchmark_symbol == "VT"
    assert beating.benchmark_return is not None
    # A single contribution that grows 1000 → 1100 implies 10 % compounded
    # total growth over the horizon, independent of the annualisation.
    assert abs(beating.benchmark_return - Decimal("0.10")) < Decimal("0.0001")
    assert beating.beating is True

    trailing = compute_market_verdict(session, portfolio_xirr=Decimal("0.0"), years=years)
    assert trailing.beating is False


def test_market_verdict_none_without_benchmark_history(session: Session, seeded: None) -> None:
    from investment_dashboard.ui.pages._overview_query import compute_market_verdict

    verdict = compute_market_verdict(session, portfolio_xirr=Decimal("0.10"), years=Decimal("1"))
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
    # Value 5 × $150 = $750 ⇒ gain $250 (a genuine profit, not a deflated loss).
    assert im.capital_gain_usd == Decimal("250.00")
    # Total growth is now the compounded (1 + XIRR) ^ years figure rather than a
    # simple gain/cost ratio; with a clear profit it stays positive.
    assert im.total_growth_usd is not None
    assert im.total_growth_usd > Decimal(0)


def test_multi_flow_growth_is_compounded_not_simple_ratio(session: Session) -> None:
    """A holding funded by regular, repeated buys must report the compounded
    (1 + XIRR) ^ years growth rather than a plain gain/cost ratio.

    This is the user-reported defect: dollar-cost-averaged holdings whose latest
    contributions have barely had time to grow showed a deflated simple ratio.
    With multiple cashflows the two formulas genuinely diverge (for a single
    contribution they coincide), so the row must not fall back to gain/cost.
    """
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
        {
            date(2024, 1, 5): Decimal("1.10"),
            date(2025, 1, 6): Decimal("1.10"),
            date.today(): Decimal("1.10"),
        },
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
                date=date(2025, 1, 6),
                kind="buy",
                instrument_id=acme.id,
                quantity=Decimal("10"),
                price_native=Decimal("120"),
                net_native=Decimal("-1200"),
                source=TransactionSource.MANUAL,
            ),
        ]
    )
    session.flush()

    positions = get_positions(session)
    metrics = compute_instrument_metrics(session, positions)
    im = metrics[acme.id]
    # Cost basis $2200, value 20 × $150 = $3000 ⇒ simple ratio would be 800/2200.
    assert im.cost_basis_usd == Decimal("2200.00")
    simple_ratio = Decimal("800") / Decimal("2200")
    assert im.total_growth_usd is not None
    # Compounded growth is a real profit but is NOT the naive gain/cost ratio.
    assert im.total_growth_usd > Decimal(0)
    assert abs(im.total_growth_usd - simple_ratio) > Decimal("0.01")


def test_position_rows_carry_portfolio_weight(session: Session, seeded: None) -> None:
    from investment_dashboard.ui.pages._overview_query import compute_instrument_metrics

    positions = get_positions(session)
    metrics = compute_instrument_metrics(session, positions)
    rows = position_rows(positions, metrics=metrics)
    # Weight is a fraction of the held EUR total; the per-row weights sum to ~1.
    weights = [r["weight_num"] for r in rows]
    assert all(w is not None for w in weights)
    assert abs(sum(weights) - 1.0) < 1e-9
    # The larger holding (VTI, 10×230) outweighs the smaller (BND, 20×75).
    vti = next(r for r in rows if r["symbol"] == "VTI")
    bnd = next(r for r in rows if r["symbol"] == "BND")
    assert vti["weight_num"] > bnd["weight_num"]


def test_position_rows_as_of_date_from_freshness(session: Session, seeded: None) -> None:
    from investment_dashboard.ui.pages._overview_query import holding_freshness

    positions = get_positions(session)
    fresh = holding_freshness(session, positions)
    rows = position_rows(positions, freshness=fresh)
    vti = next(r for r in rows if r["symbol"] == "VTI")
    # Today's price is promoted to a live status word ("LIVE" while the market
    # trades, "TODAY" once it has closed) instead of the bare date.
    assert vti["price_as_of"] in {"LIVE", "TODAY"}
    assert "instrument_id" in vti


def test_position_rows_as_of_dash_without_freshness(session: Session, seeded: None) -> None:
    rows = position_rows(get_positions(session))
    assert all(r["price_as_of"] == "—" for r in rows)


def test_build_holding_cards_weight_and_sort(session: Session, seeded: None) -> None:
    from investment_dashboard.ui.pages._overview_query import (
        build_holding_cards,
        compute_instrument_metrics,
        holding_freshness,
    )

    positions = get_positions(session)
    metrics = compute_instrument_metrics(session, positions)
    fresh = holding_freshness(session, positions)
    cards = build_holding_cards(positions, metrics=metrics, freshness=fresh)
    # Sorted by EUR value, largest first.
    assert [c.symbol for c in cards] == ["VTI", "BND"]
    # Weights are a share of the total and sum to ~1.
    total_weight = sum((c.weight for c in cards if c.weight is not None), Decimal(0))
    assert abs(total_weight - Decimal(1)) < Decimal("0.0000001")
    # Freshness is carried through onto the card (today's print date).
    assert cards[0].price_as_of == date.today()
    assert cards[0].is_money_market is False


def test_holding_freshness_marks_money_market(session: Session) -> None:
    from investment_dashboard.ui.pages._overview_query import holding_freshness

    acct = accounts_repo.create_account(
        session,
        broker="vanguard",
        account_label="Settlement",
        native_currency="USD",
        account_type="brokerage",
    )
    vmfxx = instruments_repo.get_or_create(session, symbol="VMFXX", asset_class="mutual_fund")
    session.add(
        Transaction(
            account_id=acct.id,
            date=date(2024, 1, 5),
            kind="buy",
            instrument_id=vmfxx.id,
            quantity=Decimal("100"),
            price_native=Decimal("1"),
            net_native=Decimal("-100"),
            source=TransactionSource.MANUAL,
        )
    )
    session.flush()
    positions = get_positions(session)
    fresh = holding_freshness(session, positions)
    mm = fresh[vmfxx.id]
    assert mm.is_money_market is True
    assert mm.price_as_of is None
    assert mm.updated_at is None


def test_fmt_asof_live_when_market_open() -> None:
    from investment_dashboard.ui.pages._overview_query import (
        HoldingFreshness,
        _fmt_asof,
    )

    today = date(2024, 6, 19)
    fr = HoldingFreshness(
        price_as_of=today,
        updated_at=datetime(2024, 6, 19, 14, 0),
        is_money_market=False,
        market_open=True,
    )
    assert _fmt_asof(fr, today=today) == "LIVE"


def test_fmt_asof_today_when_market_closed() -> None:
    from investment_dashboard.ui.pages._overview_query import (
        HoldingFreshness,
        _fmt_asof,
    )

    today = date(2024, 6, 19)
    fr = HoldingFreshness(
        price_as_of=today,
        updated_at=datetime(2024, 6, 19, 14, 0),
        is_money_market=False,
        market_open=False,
    )
    assert _fmt_asof(fr, today=today) == "TODAY"


def test_fmt_asof_today_when_market_closed_even_if_pulled_today() -> None:
    from investment_dashboard.ui.pages._overview_query import (
        HoldingFreshness,
        _fmt_asof,
    )

    today = date(2024, 6, 19)
    # Market closed → today's price reads TODAY regardless of the pull time,
    # matching the Daily Growth caption's ``market_open and price is today`` rule.
    fr = HoldingFreshness(
        price_as_of=today,
        updated_at=datetime(2024, 6, 19, 22, 0),
        is_money_market=False,
        market_open=False,
    )
    assert _fmt_asof(fr, today=today) == "TODAY"


def test_fmt_asof_date_for_older_price() -> None:
    from investment_dashboard.ui.pages._overview_query import (
        HoldingFreshness,
        _fmt_asof,
    )

    today = date(2024, 6, 19)
    fr = HoldingFreshness(
        price_as_of=date(2024, 6, 14),
        updated_at=datetime(2024, 6, 14, 14, 0),
        is_money_market=False,
        market_open=True,
    )
    assert _fmt_asof(fr, today=today) == "14 Jun 2024"


def test_fmt_asof_money_market_keeps_par() -> None:
    from investment_dashboard.ui.pages._overview_query import (
        HoldingFreshness,
        _fmt_asof,
    )

    fr = HoldingFreshness(
        price_as_of=None, updated_at=None, is_money_market=True, market_open=False
    )
    assert _fmt_asof(fr, today=date(2024, 6, 19)) == "par"
    """MTD growth compares the current value to the start-of-month value
    (no flows this month), mirroring the YTD calculation but month-scoped."""
    from investment_dashboard.ui.pages._overview_query import compute_instrument_metrics

    today = date.today()
    month_start = date(today.year, today.month, 1)
    if today == month_start:
        import pytest

        pytest.skip("On the 1st there is no intra-month window to measure.")

    acct = accounts_repo.create_account(
        session,
        broker="fidelity",
        account_label="Fidelity",
        native_currency="USD",
        account_type="brokerage",
    )
    acme = instruments_repo.get_or_create(session, symbol="ACME", asset_class="etf")
    # Bought before this month; priced $200 at month start, $250 today.
    prices_repo.upsert_closes(
        session, acme.id, {month_start: Decimal("200.00"), today: Decimal("250.00")}
    )
    fx_repo.upsert_rates(
        session,
        {month_start: Decimal("1.25"), today: Decimal("1.25")},
    )
    session.add(
        Transaction(
            account_id=acct.id,
            date=date(today.year, 1, 5),
            kind="buy",
            instrument_id=acme.id,
            quantity=Decimal("10"),
            price_native=Decimal("100"),
            net_native=Decimal("-1000"),
            source=TransactionSource.MANUAL,
        )
    )
    session.flush()

    positions = get_positions(session)
    metrics = compute_instrument_metrics(session, positions)
    im = metrics[acme.id]
    # (250 - 200) / 200 = +25 % this month, no intra-month flows.
    assert im.mtd_growth_usd is not None
    assert abs(im.mtd_growth_usd - Decimal("0.25")) < Decimal("0.01")


def test_position_rows_carry_mtd(session: Session, seeded: None) -> None:
    from investment_dashboard.ui.pages._overview_query import compute_instrument_metrics

    positions = get_positions(session)
    metrics = compute_instrument_metrics(session, positions)
    rows = position_rows(positions, metrics=metrics)
    assert all("mtd_eur_signed" in r and "mtd_usd_signed" in r for r in rows)
