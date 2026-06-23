"""Tests for the Overview "1 Day" intraday value curve (capture + reconstruct)."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.repositories import (
    accounts_repo,
    fx_repo,
    instruments_repo,
    intraday_repo,
    prices_repo,
)
from investment_dashboard.services import intraday_snapshots_service as iss
from investment_dashboard.ui.pages._overview_query import build_intraday_value_series

# A fixed Monday session so weekday/weekend logic is deterministic.
_SESSION_DAY = date(2024, 6, 3)
_NOW = datetime(2024, 6, 3, 20, 0, tzinfo=UTC)  # 16:00 ET, market just closed


def _seed_eur_holding(session: Session, *, close: Decimal = Decimal("100.00")) -> None:
    account = accounts_repo.create_account(
        session,
        broker="vanguard",
        account_label="EUR Brokerage",
        native_currency="EUR",
        account_type="brokerage",
    )
    instr = instruments_repo.get_or_create(session, symbol="ACME", native_currency="EUR")
    session.add(
        Transaction(
            account_id=account.id,
            instrument_id=instr.id,
            date=_SESSION_DAY,
            kind="buy",
            quantity=Decimal("10"),
            price_native=close,
            net_native=Decimal("-1000.00"),
            net_eur=Decimal("-1000.00"),
            source="manual",
        )
    )
    prices_repo.upsert_closes(session, instr.id, {_SESSION_DAY: close})
    session.flush()


def _seed_mutual_fund(session: Session, *, nav: Decimal = Decimal("200.00")) -> None:
    """Seed a €1,000 mutual-fund (NAV) holding — a once-a-day-priced position."""
    account = accounts_repo.create_account(
        session,
        broker="vanguard",
        account_label="EUR Funds",
        native_currency="EUR",
        account_type="brokerage",
    )
    instr = instruments_repo.get_or_create(
        session, symbol="EURFUND", asset_class="mutual_fund", native_currency="EUR"
    )
    session.add(
        Transaction(
            account_id=account.id,
            instrument_id=instr.id,
            date=_SESSION_DAY,
            kind="buy",
            quantity=Decimal("5"),
            price_native=nav,
            net_native=Decimal("-1000.00"),
            net_eur=Decimal("-1000.00"),
            source="manual",
        )
    )
    prices_repo.upsert_closes(session, instr.id, {_SESSION_DAY: nav})
    session.flush()


def _seed_usd_holding(
    session: Session,
    *,
    close: Decimal = Decimal("100.00"),
    settled_fx: Decimal = Decimal("1.00"),
) -> None:
    """Seed a USD-booked stock holding plus a flat EUR→USD rate on the session day.

    USD is the booked currency, so this is the case the per-timestamp FX feature
    exists for: the EUR pivot of this holding tracks the intraday rate while its
    native USD value stays purely price-driven.
    """
    account = accounts_repo.create_account(
        session,
        broker="vanguard",
        account_label="USD Brokerage",
        native_currency="USD",
        account_type="brokerage",
    )
    instr = instruments_repo.get_or_create(session, symbol="USDSTK", native_currency="USD")
    session.add(
        Transaction(
            account_id=account.id,
            instrument_id=instr.id,
            date=_SESSION_DAY,
            kind="buy",
            quantity=Decimal("10"),
            price_native=close,
            net_native=Decimal("-1000.00"),
            net_eur=Decimal("-1000.00"),
            source="manual",
        )
    )
    prices_repo.upsert_closes(session, instr.id, {_SESSION_DAY: close})
    # The settled rate the position's EUR value is expressed at (session day +
    # today, so "now" resolves it too).
    fx_repo.upsert_rates(session, {_SESSION_DAY: settled_fx, date.today(): settled_fx})
    session.flush()


def _fake_fx_fetcher(bars: dict[datetime, Decimal]):
    """Stub for ``yfinance_client.fetch_eur_usd_intraday`` returning fixed bars."""

    def fetch(day, *, interval):  # type: ignore[no-untyped-def]
        assert interval == iss.RECONSTRUCT_INTERVAL
        return dict(bars)

    return fetch


# Two 15-min bars at a flat stock price ($100) but a moving rate (1.00 → 1.25,
# the euro weakening) so the per-timestamp FX tests isolate FX from price.
_PER_TS_STOCK_BARS = {
    datetime(2024, 6, 3, 13, 30): Decimal("100"),
    datetime(2024, 6, 3, 14, 0): Decimal("100"),
}
_PER_TS_FX_BARS = {
    datetime(2024, 6, 3, 13, 30): Decimal("1.00"),
    datetime(2024, 6, 3, 14, 0): Decimal("1.25"),
}


class TestSessionWindow:
    def test_last_session_date_rolls_back_over_weekend(self) -> None:
        saturday = datetime(2024, 6, 8, 18, 0, tzinfo=UTC)
        sunday = datetime(2024, 6, 9, 18, 0, tzinfo=UTC)
        assert iss.last_session_date(saturday) == date(2024, 6, 7)  # Friday
        assert iss.last_session_date(sunday) == date(2024, 6, 7)  # Friday

    def test_last_session_date_keeps_weekday(self) -> None:
        assert iss.last_session_date(_NOW) == _SESSION_DAY

    def test_last_session_date_holds_prior_day_before_the_open(self) -> None:
        # Early Monday morning (08:00 ET), before the 09:30 open: the new session
        # has not started, so the last *started* session is still Friday — the
        # "1 Day" curve keeps showing Friday rather than blanking on an empty
        # Monday.
        before_open = datetime(2024, 6, 3, 12, 0, tzinfo=UTC)  # 08:00 ET
        assert iss.last_session_date(before_open) == date(2024, 5, 31)  # prior Friday

    def test_last_session_date_takes_today_once_open(self) -> None:
        # 09:45 ET, just after the open: Monday is now the current session.
        after_open = datetime(2024, 6, 3, 13, 45, tzinfo=UTC)  # 09:45 ET
        assert iss.last_session_date(after_open) == _SESSION_DAY

    def test_last_session_date_skips_holidays(self) -> None:
        # Thursday 2024-07-04 (Independence Day) is a full-day NYSE holiday, so an
        # afternoon open that day rolls back to Wednesday 2024-07-03.
        july_4 = datetime(2024, 7, 4, 18, 0, tzinfo=UTC)
        assert iss.last_session_date(july_4) == date(2024, 7, 3)

    def test_previous_trading_session_skips_holiday(self) -> None:
        # The session before Friday 2024-07-05 is Wednesday 2024-07-03, because
        # Thursday 2024-07-04 (Independence Day) is a full-day NYSE holiday.
        assert iss.previous_trading_session(date(2024, 7, 5)) == date(2024, 7, 3)

    def test_previous_trading_session_skips_weekend(self) -> None:
        # The session before Monday 2024-06-03 is the prior Friday 2024-05-31.
        assert iss.previous_trading_session(date(2024, 6, 3)) == date(2024, 5, 31)

    def test_window_bounds_a_single_session(self) -> None:
        start, end = iss.session_window_utc(_NOW)
        assert start < end
        # 00:00 ET on the session day, expressed in UTC (EDT = UTC-4).
        assert start == datetime(2024, 6, 3, 4, 0)

    def test_session_close_utc_is_16_00_et(self) -> None:
        # 16:00 ET on the Monday session == 20:00 UTC (EDT = UTC-4), naive.
        assert iss.session_close_utc(_NOW) == datetime(2024, 6, 3, 20, 0)
        # After the close (19:00 ET) still resolves to the same day's 16:00 ET.
        after = datetime(2024, 6, 3, 23, 0, tzinfo=UTC)
        assert iss.session_close_utc(after) == datetime(2024, 6, 3, 20, 0)

    def test_session_close_utc_rolls_back_over_weekend(self) -> None:
        saturday = datetime(2024, 6, 8, 18, 0, tzinfo=UTC)
        # Friday 2024-06-07 16:00 ET == 20:00 UTC.
        assert iss.session_close_utc(saturday) == datetime(2024, 6, 7, 20, 0)


class TestForwardFill:
    def test_picks_latest_bar_at_or_before(self) -> None:
        bars = {
            datetime(2024, 6, 3, 13, 30): Decimal("100"),
            datetime(2024, 6, 3, 14, 0): Decimal("110"),
        }
        assert iss._forward_filled(bars, datetime(2024, 6, 3, 13, 45)) == Decimal("100")
        assert iss._forward_filled(bars, datetime(2024, 6, 3, 14, 30)) == Decimal("110")
        # Before the first bar → earliest available, never None.
        assert iss._forward_filled(bars, datetime(2024, 6, 3, 13, 0)) == Decimal("100")
        assert iss._forward_filled({}, datetime(2024, 6, 3, 14, 0)) is None


def _fake_fetcher(bars: dict[datetime, Decimal]):
    def fetch(symbols, day, *, interval):  # type: ignore[no-untyped-def]
        assert interval == iss.RECONSTRUCT_INTERVAL
        return {sym: dict(bars) for sym in symbols}

    return fetch


class TestReconstruct:
    def test_reconstructs_anchored_to_daily_total(self, session: Session) -> None:
        _seed_eur_holding(session)
        bars = {
            datetime(2024, 6, 3, 13, 30): Decimal("100"),  # +0%
            datetime(2024, 6, 3, 14, 0): Decimal("110"),  # +10%
        }
        written = iss.reconstruct_last_session(session, now=_NOW, fetcher=_fake_fetcher(bars))
        session.flush()
        assert written == 2
        series = iss.day_series_market_eur(session, now=_NOW)
        assert [v for _, v in series] == [Decimal("1000.00"), Decimal("1100.00")]

    def test_skips_bars_already_covered_by_live_samples(self, session: Session) -> None:
        # A live sample captured during the session (at the unreleased/higher
        # price) must survive reconstruction: the 30-min bar landing on it is
        # skipped rather than overwritten by a point revalued to a lower price,
        # which would otherwise draw a downward spike at that mark.
        _seed_eur_holding(session)
        live_at = datetime(2024, 6, 3, 14, 0)  # 10:00 ET, mid-session
        intraday_repo.insert_sample(session, live_at, Decimal("1234.00"))
        session.flush()
        bars = {
            datetime(2024, 6, 3, 13, 30): Decimal("100"),  # 09:30 ET — backfilled
            datetime(2024, 6, 3, 14, 0): Decimal("90"),  # 10:00 ET — covered live
        }
        written = iss.reconstruct_last_session(session, now=_NOW, fetcher=_fake_fetcher(bars))
        session.flush()
        # Only the uncovered 09:30 bar is written; the live 10:00 point is kept.
        assert written == 1
        series = dict(iss.day_series_market_eur(session, now=_NOW))
        assert series[live_at] == Decimal("1234.00")  # untouched live value
        assert datetime(2024, 6, 3, 13, 30) in series  # gap was backfilled

    def test_is_guarded_to_one_fetch_per_session(self, session: Session) -> None:
        _seed_eur_holding(session)
        calls = {"n": 0}

        def fetch(symbols, day, *, interval):  # type: ignore[no-untyped-def]
            calls["n"] += 1
            return {sym: {datetime(2024, 6, 3, 13, 30): Decimal("100")} for sym in symbols}

        iss.reconstruct_last_session(session, now=_NOW, fetcher=fetch)
        session.flush()
        iss.reconstruct_last_session(session, now=_NOW, fetcher=fetch)
        session.flush()
        assert calls["n"] == 1  # second call short-circuits on the app_config guard


class TestNavDecomposition:
    def test_nav_holding_rides_in_base_not_intraday_samples(self, session: Session) -> None:
        # A stock (intraday-priced) plus a mutual fund (once-a-day NAV). The fund
        # must NOT appear in the stored intraday samples — it belongs to the
        # constant base added at render — so its post-close NAV revaluation can
        # never spike the curve at the points captured before it.
        _seed_eur_holding(session)  # ACME 10@€100 = €1,000 (intraday-priced)
        _seed_mutual_fund(session)  # EURFUND 5@€200 = €1,000 (NAV, in the base)
        bars = {
            datetime(2024, 6, 3, 13, 30): Decimal("100"),  # +0%
            datetime(2024, 6, 3, 14, 0): Decimal("110"),  # +10%
        }
        written = iss.reconstruct_last_session(session, now=_NOW, fetcher=_fake_fetcher(bars))
        session.flush()
        assert written == 2

        # Stored samples carry ONLY the stock's market component (no €1,000 fund).
        market = [v for _, v in iss.day_series_market_eur(session, now=_NOW)]
        assert market == [Decimal("1000.00"), Decimal("1100.00")]

        # The rendered curve adds the constant €1,000 fund base to every point.
        points = build_intraday_value_series(session, currency="EUR", now=_NOW)
        assert points[0].value == Decimal("2000.00")  # €1,000 stock + €1,000 fund
        assert points[1].value == Decimal("2100.00")  # stock +10%, fund unchanged

    def test_part_day_live_then_offline_keeps_one_basis(self, session: Session) -> None:
        # The user's scenario: watch the open live (dense points captured at the
        # stock prices actually seen), go offline, reopen later. Reconstruction
        # backfills the rest of the session; because the NAV fund is always in the
        # base, the live stretch and the reconstructed remainder share one basis —
        # no step where they meet.
        _seed_eur_holding(session)
        _seed_mutual_fund(session)
        # Two live captures early in the session (stock-only market component).
        intraday_repo.insert_sample(session, datetime(2024, 6, 3, 14, 0), Decimal("1000.00"))
        intraday_repo.insert_sample(session, datetime(2024, 6, 3, 14, 30), Decimal("1050.00"))
        session.flush()
        # Reconstruction fills the whole session at 30-min granularity.
        bars = {
            datetime(2024, 6, 3, 14, 0): Decimal("100"),
            datetime(2024, 6, 3, 15, 0): Decimal("90"),
            datetime(2024, 6, 3, 15, 30): Decimal("95"),
        }
        iss.reconstruct_last_session(session, now=_NOW, fetcher=_fake_fetcher(bars))
        session.flush()

        points = build_intraday_value_series(session, currency="EUR", now=_NOW)
        # Every point carries the same constant €1,000 NAV base: subtracting the
        # base must leave a strictly positive stock component on every point, and
        # the live 14:00 capture (€1,000 + €1,000 base) is preserved unchanged.
        base = Decimal("1000.00")
        assert all(p.value - base > 0 for p in points)
        assert any(p.value == Decimal("2000.00") for p in points)  # the live 14:00 point


class TestBuildIntradaySeries:
    def test_merges_dense_live_points_with_reconstruction(self, session: Session) -> None:
        _seed_eur_holding(session)
        # Coarse reconstructed bars …
        iss.reconstruct_last_session(
            session,
            now=_NOW,
            fetcher=_fake_fetcher({datetime(2024, 6, 3, 13, 30): Decimal("100")}),
        )
        # … plus several dense live captures within the same session window.
        for minute in (40, 41, 42):
            intraday_repo.insert_sample(
                session, datetime(2024, 6, 3, 19, minute), Decimal("1050.00")
            )
        session.flush()

        points = build_intraday_value_series(session, currency="EUR", now=_NOW)
        # 1 reconstructed + 3 live + 1 live "now" tip — the dense hour is kept.
        assert len(points) >= 5
        assert points[0].value == Decimal("1000.00")
        # Strictly increasing timestamps (sorted, merged).
        stamps = [p.date for p in points]
        assert stamps == sorted(stamps)

    def test_empty_portfolio_has_no_points(self, session: Session) -> None:
        assert build_intraday_value_series(session, currency="EUR", now=_NOW) == []

    def test_live_tip_is_capped_at_market_close(self, session: Session) -> None:
        _seed_eur_holding(session)
        iss.reconstruct_last_session(
            session,
            now=_NOW,
            fetcher=_fake_fetcher({datetime(2024, 6, 3, 13, 30): Decimal("100")}),
        )
        session.flush()
        # Build well after the close (19:00 ET) — the curve must end at 16:00 ET
        # (20:00 UTC), not trail a flat line out to "now".
        after_close = datetime(2024, 6, 3, 23, 0, tzinfo=UTC)
        points = build_intraday_value_series(session, currency="EUR", now=after_close)
        assert points[-1].date == datetime(2024, 6, 3, 20, 0)

    def test_weekend_curve_ends_on_friday_close(self, session: Session) -> None:
        _seed_eur_holding(session)
        # The Friday before the seeded Monday — reconstruct + build over the weekend.
        friday_now = datetime(2024, 6, 7, 19, 0, tzinfo=UTC)  # 15:00 ET Friday
        prices_repo.upsert_closes(
            session,
            instruments_repo.get_or_create(session, symbol="ACME", native_currency="EUR").id,
            {date(2024, 6, 7): Decimal("100.00")},
        )
        session.flush()
        iss.reconstruct_last_session(
            session,
            now=friday_now,
            fetcher=_fake_fetcher({datetime(2024, 6, 7, 17, 30): Decimal("100")}),
        )
        session.flush()
        saturday = datetime(2024, 6, 8, 18, 0, tzinfo=UTC)
        points = build_intraday_value_series(session, currency="EUR", now=saturday)
        # Last point pinned to Friday's 16:00 ET close, never bleeding into Saturday.
        assert points[-1].date == datetime(2024, 6, 7, 20, 0)


class TestPerTimestampFx:
    """Per-minute EUR/USD: the USD line stays price-only, the EUR line tracks FX."""

    # Two 15-min bars at a flat stock price ($100) but a moving rate: 1.00 then
    # 1.25 (the euro weakens — more USD per EUR). With price flat, any movement in
    # the curve is pure FX, which isolates the behaviour under test.
    _STOCK_BARS = _PER_TS_STOCK_BARS
    _FX_BARS = _PER_TS_FX_BARS

    def _reconstruct(self, session: Session) -> None:
        iss.reconstruct_last_session(
            session,
            now=_NOW,
            fetcher=_fake_fetcher(self._STOCK_BARS),
            fx_fetcher=_fake_fx_fetcher(self._FX_BARS),
        )
        session.flush()

    def test_stores_per_minute_fx_and_rebases_eur_pivot(self, session: Session) -> None:
        _seed_usd_holding(session)  # 10 @ $100, settled EUR/USD = 1.00 ⇒ €1,000
        self._reconstruct(session)
        series = iss.day_series_with_fx(session, now=_NOW)
        by_time = {at: (eur, fx) for at, eur, fx in series}
        # 13:30 at rate 1.00: pivot unchanged €1,000, rate stored.
        eur_1330, fx_1330 = by_time[datetime(2024, 6, 3, 13, 30)]
        assert eur_1330 == Decimal("1000.00")
        assert fx_1330 == Decimal("1.00")
        # 14:00 at rate 1.25: same $1,000 native ⇒ €800 pivot, rate stored.
        eur_1400, fx_1400 = by_time[datetime(2024, 6, 3, 14, 0)]
        assert eur_1400 == Decimal("800.00")
        assert fx_1400 == Decimal("1.25")

    def test_eur_line_diverges_while_usd_line_stays_flat(self, session: Session) -> None:
        _seed_usd_holding(session)
        self._reconstruct(session)
        eur = build_intraday_value_series(session, currency="EUR", now=_NOW)
        usd = build_intraday_value_series(session, currency="USD", now=_NOW)
        # EUR moves purely on FX (price was flat): €1,000 → €800.
        assert [p.value for p in eur[:2]] == [Decimal("1000.00"), Decimal("800.00")]
        # USD is the booked currency — FX-free / price-only — so it stays flat at
        # $1,000 across the same two points despite the rate moving 1.00 → 1.25.
        assert usd[0].value == Decimal("1000.00")
        assert usd[1].value == Decimal("1000.00")

    def test_falls_back_to_today_rate_when_fx_bars_missing(self, session: Session) -> None:
        # No intraday FX feed (empty bars): the EUR pivot stays at the settled
        # rate (uniform), and USD is still price-only — a graceful degradation.
        _seed_usd_holding(session)
        iss.reconstruct_last_session(
            session,
            now=_NOW,
            fetcher=_fake_fetcher(self._STOCK_BARS),
            fx_fetcher=_fake_fx_fetcher({}),
        )
        session.flush()
        series = iss.day_series_with_fx(session, now=_NOW)
        # Both points keep the €1,000 settled-rate pivot (no per-minute re-mark).
        assert [eur for _, eur, _ in series] == [Decimal("1000.00"), Decimal("1000.00")]
        # The stored rate falls back to the settled spot (1.00), never NULL here.
        assert all(fx == Decimal("1.00") for _, _, fx in series)


def _seed_eur_holding_for_week(session: Session) -> None:
    """An EUR holding bought before the week, with a close on every session day."""
    account = accounts_repo.create_account(
        session,
        broker="vanguard",
        account_label="EUR Brokerage",
        native_currency="EUR",
        account_type="brokerage",
    )
    instr = instruments_repo.get_or_create(session, symbol="ACME", native_currency="EUR")
    session.add(
        Transaction(
            account_id=account.id,
            instrument_id=instr.id,
            date=date(2024, 5, 20),
            kind="buy",
            quantity=Decimal("10"),
            price_native=Decimal("100.00"),
            net_native=Decimal("-1000.00"),
            net_eur=Decimal("-1000.00"),
            source="manual",
        )
    )
    prices_repo.upsert_closes(
        session,
        instr.id,
        {d: Decimal("100.00") for d in iss.recent_trading_sessions(_NOW)},
    )
    session.flush()


def _fake_week_fetcher(per_day_bars):  # type: ignore[no-untyped-def]
    """Stub for ``fetch_intraday_closes_range`` returning the same bars each day."""

    def fetch(symbols, start_day, end_day, *, interval):  # type: ignore[no-untyped-def]
        assert interval == iss.WEEK_INTERVAL
        assert start_day <= end_day
        bars: dict[datetime, Decimal] = {}
        day = start_day
        while day <= end_day:
            for hour_min, price in per_day_bars:
                bars[datetime(day.year, day.month, day.day, *hour_min)] = price
            day += timedelta(days=1)
        return {sym: dict(bars) for sym in symbols}

    return fetch


_WEEK_DAY_BARS = [
    ((13, 30), Decimal("100")),  # start
    ((15, 0), Decimal("110")),
    ((17, 0), Decimal("120")),  # nearest the session midpoint → midday
    ((19, 30), Decimal("130")),  # close
]


class TestWeekSeries:
    # Four bars per session day; _pick_open_mid_close keeps start / midday / close.
    _DAY_BARS = _WEEK_DAY_BARS

    def test_three_points_per_session(self, session: Session) -> None:
        _seed_eur_holding_for_week(session)
        samples = iss.week_series_with_fx(
            session, now=_NOW, fetcher=_fake_week_fetcher(self._DAY_BARS)
        )
        sessions = iss.recent_trading_sessions(_NOW)
        assert len(sessions) == iss.WEEK_SESSIONS
        # Start / midday / close kept for each of the week's sessions.
        assert len(samples) == 3 * len(sessions)
        # Oldest-first and the market component scales with the intraday price.
        first_day = [s for s in samples if s[0].date() == sessions[0]]
        assert [eur for _, eur, _ in first_day] == [
            Decimal("1000.00"),  # 100/100 × €1,000
            Decimal("1200.00"),  # 120/100 (midday)
            Decimal("1300.00"),  # 130/100 (close)
        ]

    def test_empty_when_feed_has_no_bars(self, session: Session) -> None:
        _seed_eur_holding_for_week(session)
        samples = iss.week_series_with_fx(session, now=_NOW, fetcher=_fake_week_fetcher([]))
        assert samples == []

    def test_empty_when_no_positions(self, session: Session) -> None:
        samples = iss.week_series_with_fx(
            session, now=_NOW, fetcher=_fake_week_fetcher(self._DAY_BARS)
        )
        assert samples == []

    def test_recent_trading_sessions_are_sorted_and_skip_weekends(self) -> None:
        sessions = iss.recent_trading_sessions(_NOW)
        assert sessions == sorted(sessions)
        assert sessions[-1] == date(2024, 6, 3)
        assert all(s.weekday() < 5 for s in sessions)

    def test_week_window_start_is_the_oldest_session_start(self) -> None:
        sessions = iss.recent_trading_sessions(_NOW)
        assert iss.week_window_start_utc(_NOW) == iss._session_start_utc(sessions[0])

    def test_reconstruct_retains_a_rolling_week_not_just_today(self, session: Session) -> None:
        # Widened retention: pruning is to the *week* window start, so a sample
        # from an earlier session this week survives reconstructing today, while
        # one older than the whole window is pruned away.
        _seed_eur_holding(session)
        sessions = iss.recent_trading_sessions(_NOW)
        within_week = iss._session_start_utc(sessions[0]) + timedelta(hours=16)
        before_week = iss.week_window_start_utc(_NOW) - timedelta(days=3)
        intraday_repo.insert_sample(session, within_week, Decimal("999.00"))
        intraday_repo.insert_sample(session, before_week, Decimal("111.00"))
        session.flush()
        iss.reconstruct_last_session(
            session,
            now=_NOW,
            fetcher=_fake_fetcher({datetime(2024, 6, 3, 13, 30): Decimal("100")}),
        )
        session.flush()
        rows = intraday_repo.list_in_range(
            session, before_week - timedelta(days=1), _NOW.replace(tzinfo=None)
        )
        times = [r.captured_at for r in rows]
        assert within_week in times  # kept: inside the rolling week
        assert before_week not in times  # pruned: older than the week window

    def test_persists_fetched_bars_and_reuses_them_without_refetch(self, session: Session) -> None:
        _seed_eur_holding_for_week(session)
        calls = {"n": 0}
        base = _fake_week_fetcher(self._DAY_BARS)

        def fetch(symbols, start_day, end_day, *, interval):  # type: ignore[no-untyped-def]
            calls["n"] += 1
            return base(symbols, start_day, end_day, interval=interval)

        first = iss.week_series_with_fx(session, now=_NOW, fetcher=fetch)
        session.flush()
        second = iss.week_series_with_fx(session, now=_NOW, fetcher=fetch)
        # The whole week is now cached, so the second render does not refetch.
        assert calls["n"] == 1
        assert [(at, eur) for at, eur, _ in second] == [(at, eur) for at, eur, _ in first]

    def test_fetches_only_uncovered_sessions(self, session: Session) -> None:
        _seed_eur_holding_for_week(session)
        sessions = iss.recent_trading_sessions(_NOW)
        # A live capture covering today's session — it must be reused, not
        # re-fetched, and the network fetch must stop at the prior session.
        live_at = datetime(2024, 6, 3, 15, 0)
        intraday_repo.insert_sample(session, live_at, Decimal("5555.00"))
        session.flush()
        seen: dict[str, date] = {}
        base = _fake_week_fetcher(self._DAY_BARS)

        def fetch(symbols, start_day, end_day, *, interval):  # type: ignore[no-untyped-def]
            seen["start"] = start_day
            seen["end"] = end_day
            return base(symbols, start_day, end_day, interval=interval)

        out = iss.week_series_with_fx(session, now=_NOW, fetcher=fetch)
        # Today was covered by the live sample → fetch range excludes it.
        assert seen["start"] == sessions[0]
        assert seen["end"] == sessions[-2]
        # The cached live point survives and is the only point for today.
        today_points = [(at, eur) for at, eur, _ in out if at.date() == date(2024, 6, 3)]
        assert today_points == [(live_at, Decimal("5555.00"))]

    def test_build_week_value_series_empty_for_empty_portfolio(self, session: Session) -> None:
        # With nothing to price intraday there is nothing to cache or fetch, so
        # the series is empty and the page falls back to the daily snapshots.
        from investment_dashboard.ui.pages._overview_query import build_week_value_series

        assert build_week_value_series(session, currency="EUR", now=_NOW) == []
