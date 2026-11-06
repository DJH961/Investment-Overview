"""Twin estimates: one number everywhere, exact identities, retention and the tick.

A EUR book (€1,000 flat stock + 5 sh of a mutual fund, NAV 200 on Fri 31 May 2024)
whose fund has the ETF twin TWN. Mon 3 Jun 2024 trades 13:30-20:00 UTC; the twin
closed Friday at 100 and is at 102 at 17:00 UTC, 105 at the close.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from hypothesis import given
from hypothesis import strategies as st
from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.readmodels.overview import build_overview
from investment_dashboard.readmodels.queries.overview_query import build_intraday_value_series
from investment_dashboard.repositories import (
    accounts_repo,
    instrument_overrides_repo,
    instruments_repo,
    intraday_repo,
    prices_repo,
    twin_prices_repo,
)
from investment_dashboard.services import (
    app_config_service,
    positions_service,
    scheduler,
)
from investment_dashboard.services import intraday_snapshots_service as iss
from investment_dashboard.services.intraday_snapshots_service import (
    EstimateLeg,
    TwinEstimate,
    estimate_adjustment,
    estimate_move_pct,
)

D = Decimal
FRI, MON = date(2024, 5, 31), date(2024, 6, 3)
OPEN, MID, CLOSE = (
    datetime(2024, 6, 3, 13, 30),
    datetime(2024, 6, 3, 17, 0),
    datetime(2024, 6, 3, 20, 0),
)
DURING = datetime(2024, 6, 3, 17, 30, tzinfo=UTC)
AFTER = datetime(2024, 6, 3, 22, 0, tzinfo=UTC)
FX = D("1.10")
TWIN_ROWS = {
    datetime(2024, 5, 31, 20, 0): D("100"),
    OPEN: D("100"),
    MID: D("102"),
    CLOSE: D("105"),
}


def _seed(session: Session, *, official_nav: Decimal | None, twin: str | None = "TWN") -> int:
    account = accounts_repo.create_account(
        session,
        broker="vanguard",
        account_label="EUR Brokerage",
        native_currency="EUR",
        account_type="brokerage",
    )
    stock = instruments_repo.get_or_create(session, symbol="ACME", native_currency="EUR")
    fund = instruments_repo.get_or_create(
        session, symbol="EURFUND", asset_class="mutual_fund", native_currency="EUR"
    )
    for inst, qty, price in ((stock, D("10"), D("100")), (fund, D("5"), D("200"))):
        session.add(
            Transaction(
                account_id=account.id,
                instrument_id=inst.id,
                date=FRI,
                kind="buy",
                quantity=qty,
                price_native=price,
                net_native=-qty * price,
                net_eur=-qty * price,
                source="manual",
            )
        )
    prices_repo.upsert_closes(session, stock.id, {FRI: D("100"), MON: D("100")})
    closes = {FRI: D("200")}
    if official_nav is not None:
        closes[MON] = official_nav
    prices_repo.upsert_closes(session, fund.id, closes)
    if twin:
        instrument_overrides_repo.upsert(session, fund.id, intraday_twin=twin)
        twin_prices_repo.upsert_prices(session, twin, TWIN_ROWS)
    for at in (OPEN, datetime(2024, 6, 3, 15, 0), MID):
        intraday_repo.insert_sample(session, at, D("1000"), fx_eur_usd=FX)
    session.flush()
    return fund.id


# -- one number: overview estimate == tick point == 1D graph's last point ---------------


def test_overview_estimate_equals_tick_point_equals_graph_tip(session: Session) -> None:
    fund_id = _seed(session, official_nav=None)
    official = positions_service.total_portfolio_value(session, as_of=MON)
    assert official == D("2000")

    # Twin at 102 at 17:00 (the newest price at 17:30): estimate 204 x 5 sh = 1,020.
    overview = build_overview(session, ccy="EUR", as_of=MON, now=DURING)
    estimate = overview["kpis"]["estimate"]
    assert D(overview["kpis"]["total_value"]) == D("2000")
    assert D(estimate["total_value"]) == D("2020")
    assert D(estimate["adjustment"]) == D("20")

    line = build_intraday_value_series(session, currency="EUR", now=DURING)
    assert line[-1].value == D(estimate["total_value"])

    # The tick: the point on the sample at 17:00 and the estimated total of the tick.
    adjustment = iss.live_point_adjustment_eur(session, at=MID, fx=FX, now=DURING)
    assert official + adjustment == D(estimate["total_value"])
    tick = scheduler._tick_estimates(session, official, FX, now=DURING)
    assert D(tick["total_value_est_eur"]) == D(estimate["total_value"])
    assert D(tick["total_value_est_usd"]) == D("2020") * FX
    row = tick["estimates"][str(fund_id)]
    assert (D(row["est_px"]), D(row["prev_nav"])) == (D("204"), D("200"))
    assert D(row["pct"]["EUR"]) == D("0.02")
    assert row["at"].startswith("2024-06-03T17:00:00")


def test_adjustment_is_zero_once_the_nav_posts(session: Session) -> None:
    _seed(session, official_nav=D("210"))
    assert iss.twin_estimates(session, AFTER) == {}
    assert estimate_adjustment(iss.twin_estimates(session, AFTER).values(), FX) == (D(0), D(0))
    assert iss.live_point_adjustment_eur(session, at=CLOSE, fx=FX, now=AFTER) == D(0)
    overview = build_overview(session, ccy="EUR", as_of=MON, now=AFTER)
    assert overview["kpis"]["estimate"] is None
    tick = scheduler._tick_estimates(session, D("2050"), FX, now=AFTER)
    assert tick == {"total_value_est_eur": None, "total_value_est_usd": None, "estimates": None}


def test_only_funds_with_twin_data_estimate(session: Session) -> None:
    _seed(session, official_nav=None, twin=None)
    assert iss.twin_estimates(session, DURING) == {}
    assert build_overview(session, ccy="EUR", as_of=MON, now=DURING)["kpis"]["estimate"] is None


def test_estimates_are_memoised_per_session(session: Session) -> None:
    _seed(session, official_nav=None)
    first = iss.twin_estimates(session, DURING)
    assert iss.twin_estimates(session, DURING + timedelta(milliseconds=300)) is first


# -- the tick's prices: a stale NAV must not zero the client's day move ------------------


def test_stale_nav_fund_is_flagged_and_has_no_previous_close(session: Session) -> None:
    fund_id = _seed(session, official_nav=None)
    prices = scheduler._tick_prices(session, MON, now=DURING)
    assert prices is not None
    stale = prices[str(fund_id)]
    assert stale["stale_nav"] is True
    assert stale["prev_close"] is None  # px (= Friday's NAV) must not equal prev_close
    assert D(stale["px"]) == D("200")
    stock = next(v for k, v in prices.items() if k != str(fund_id))
    assert stock["stale_nav"] is False
    assert D(stock["prev_close"]) == D("100")


def test_posted_nav_is_a_normal_price_row(session: Session) -> None:
    fund_id = _seed(session, official_nav=D("210"))
    prices = scheduler._tick_prices(session, MON, now=AFTER)
    assert prices is not None
    row = prices[str(fund_id)]
    assert row["stale_nav"] is False
    assert (D(row["px"]), D(row["prev_close"])) == (D("210"), D("200"))


def test_estimate_changes_count_as_a_tick_change() -> None:
    assert "estimates" in scheduler._CHANGE_KEYS
    assert "total_value_est_eur" in scheduler._CHANGE_KEYS


# -- exact identities (property tests) -------------------------------------------------

shares = st.decimals(min_value="0.001", max_value="5000", places=3)
nav = st.decimals(min_value="1", max_value="2000", places=4)
rate = st.decimals(min_value="0.5", max_value="2", places=6)
currencies = st.sampled_from(["USD", "EUR"])


def _estimate(ccy: str, qty: Decimal, prev: Decimal, est: Decimal, *legs: Decimal) -> TwinEstimate:
    all_legs = tuple(EstimateLeg(ccy, q, D(1)) for q in (qty, *legs))
    return TwinEstimate(
        instrument_id=1,
        symbol="F",
        twin_symbol="T",
        tier="manual",
        currency=ccy,
        session_date=MON,
        prev_nav=prev,
        est_px=est,
        twin_now=D(1),
        twin_prev_close=D(1),
        at=DURING,
        legs=all_legs,
    )


@given(ccy=currencies, qty=shares, prev=nav, est=nav, fx=rate)
def test_adjustment_is_shares_times_price_step_at_one_rate(
    ccy: str, qty: Decimal, prev: Decimal, est: Decimal, fx: Decimal
) -> None:
    adjustment = estimate_adjustment([_estimate(ccy, qty, prev, est)], fx)
    assert adjustment is not None
    eur, usd = adjustment
    native = qty * (est - prev)
    if ccy == "USD":
        assert usd == native
        assert abs(eur - native / fx) < D("1e-18")
    else:
        assert eur == native
        assert abs(usd - native * fx) < D("1e-18")
    # One instant, one rate: the two currencies agree.
    assert abs(eur * fx - usd) < D("1e-15") * (1 + abs(usd))


@given(
    funds=st.lists(st.tuples(currencies, shares, nav, nav), min_size=1, max_size=5),
    fx=rate,
    official=st.decimals(min_value="1000", max_value="1000000", places=2),
)
def test_estimated_total_is_official_plus_the_sum_of_pending_steps(
    funds: list[tuple[str, Decimal, Decimal, Decimal]], fx: Decimal, official: Decimal
) -> None:
    estimates = [_estimate(c, q, p, e) for c, q, p, e in funds]
    adjustment = estimate_adjustment(estimates, fx)
    assert adjustment is not None
    expected = D(0)
    for ccy, qty, prev, est in funds:
        step = qty * (est - prev)
        expected += step / fx if ccy == "USD" else step
    assert abs((official + adjustment[0]) - (official + expected)) < D("1e-15") * (1 + official)
    # A posted NAV drops the fund out of the estimates: its adjustment is exactly 0.
    assert estimate_adjustment([], fx) == (D(0), D(0))


@given(ccy=currencies, qty=shares, prev=nav, est=nav, fx_now=rate, fx_prev=rate)
def test_move_pct_is_a_value_ratio_per_currency_never_a_converted_return(
    ccy: str, qty: Decimal, prev: Decimal, est: Decimal, fx_now: Decimal, fx_prev: Decimal
) -> None:
    pct = estimate_move_pct(_estimate(ccy, qty, prev, est), fx_now, fx_prev)
    native = est / prev - 1
    if ccy == "USD":
        assert abs(pct["USD"] - native) < D("1e-18")
        assert abs((1 + pct["EUR"]) - (est / fx_now) / (prev / fx_prev)) < D("1e-18")
    else:
        assert abs(pct["EUR"] - native) < D("1e-18")
        assert abs((1 + pct["USD"]) - (est * fx_now) / (prev * fx_prev)) < D("1e-18")
    # With an unchanged rate the two currencies agree.
    same = estimate_move_pct(_estimate(ccy, qty, prev, est), fx_now, fx_now)
    assert abs(same["EUR"] - same["USD"]) < D("1e-18")


def test_estimate_golden_values() -> None:
    # 10 USD-booked shares, NAV 200 -> 210 at 1.25 USD per EUR: +100 USD = +80 EUR.
    est = _estimate("USD", D("10"), D("200"), D("210"))
    assert estimate_adjustment([est], D("1.25")) == (D("80"), D("100"))
    pct = estimate_move_pct(est, D("1.25"), D("1.00"))
    assert pct["USD"] == D("0.05")
    assert pct["EUR"] == D("0.05") * 0 + (D("210") / D("1.25")) / (D("200") / D("1.00")) - 1
    assert estimate_adjustment([est], None) == (None, None)
    # Without a rate an all-EUR book still has its EUR figure, never a USD one.
    eur_fund = _estimate("EUR", D("10"), D("200"), D("210"))
    assert estimate_adjustment([eur_fund], None) == (D("100"), None)
    # Two accounts of one fund: shares add up.
    both = _estimate("USD", D("10"), D("200"), D("210"), D("5"))
    assert both.shares == D("15")
    assert estimate_adjustment([both], D("1.25")) == (D("120"), D("150"))


# -- twin close retention + the one-time one-year backfill --------------------------------


def _close_instant(day: date) -> datetime:
    return iss._session_close_utc(day)


def test_prune_keeps_closes_for_400_days_and_drops_old_bars(session: Session) -> None:
    now = datetime(2024, 6, 3, 22, 0, tzinfo=UTC)
    old_day = date(2024, 1, 10)  # a Wednesday, ~5 months back
    ancient_day = date(2022, 12, 14)  # more than 400 days back
    old_bar = datetime(2024, 1, 10, 15, 0)
    twin_prices_repo.upsert_prices(
        session,
        "TWN",
        {
            _close_instant(old_day): D("100"),  # kept (a session close)
            old_bar: D("99"),  # dropped (an intraday bar outside the 1W window)
            _close_instant(ancient_day): D("90"),  # dropped (past 400 days)
            CLOSE: D("105"),  # the current week: untouched
            MID: D("102"),
        },
    )
    session.flush()
    iss.prune_twin_prices(session, now=now)
    left = twin_prices_repo.prices_in_range(
        session, ["TWN"], datetime(2020, 1, 1), datetime(2030, 1, 1)
    )["TWN"]
    assert set(left) == {_close_instant(old_day), CLOSE, MID}


def test_year_backfill_runs_once_per_twin_and_stores_session_closes(session: Session) -> None:
    _seed(session, official_nav=None)
    iss._year_attempts.clear()
    calls: list[tuple[list[str], date, date]] = []

    def fetcher(symbols: list[str], start: date, end: date) -> dict[str, dict[date, Decimal]]:
        calls.append((list(symbols), start, end))
        return {
            "TWN": {
                date(2024, 5, 29): D("98"),
                date(2024, 5, 30): D("99"),
                date(2024, 6, 1): D("1"),  # a Saturday: never a session
                MON: D("102"),  # Monday is still running (13:30 ET): not a close yet
            }
        }

    written = iss.backfill_twin_year_closes(session, ["TWN"], now=DURING, fetcher=fetcher)
    assert written == 2
    assert len(calls) == 1
    assert calls[0][1] == MON - timedelta(days=365)
    stored = twin_prices_repo.prices_in_range(
        session, ["TWN"], datetime(2024, 5, 28), datetime(2024, 5, 31)
    )
    assert stored["TWN"][_close_instant(date(2024, 5, 29))] == D("98")
    assert app_config_service.get(session, "intraday_twin_year_closes:TWN") == "1"
    # Done: the next tick does not ask again.
    iss._year_attempts.clear()
    assert iss.backfill_twin_year_closes(session, ["TWN"], now=DURING, fetcher=fetcher) == 0
    assert len(calls) == 1


def test_year_backfill_retry_is_throttled_when_nothing_comes_back(session: Session) -> None:
    iss._year_attempts.clear()
    calls: list[int] = []

    def empty(symbols: list[str], start: date, end: date) -> dict[str, dict[date, Decimal]]:
        calls.append(1)
        return {}

    assert iss.backfill_twin_year_closes(session, ["TWN"], now=DURING, fetcher=empty) == 0
    assert iss.backfill_twin_year_closes(session, ["TWN"], now=DURING, fetcher=empty) == 0
    assert len(calls) == 1
    assert app_config_service.get(session, "intraday_twin_year_closes:TWN") is None


def test_divergence_window_setting_default() -> None:
    from investment_dashboard.domain.late_data import DEFAULT_DIVERGENCE_WINDOW
    from investment_dashboard.services import settings_registry

    d = settings_registry.BY_KEY["twin.divergence_window"]
    assert d.default == DEFAULT_DIVERGENCE_WINDOW == 20
    assert d.section == "data_refresh"
    assert d.level != "advanced"
    assert iss.divergence_window() == 20
