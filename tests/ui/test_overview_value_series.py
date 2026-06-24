"""Tests for the Overview value-over-time series (v2.8 item 5)."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.repositories import accounts_repo, instruments_repo, prices_repo
from investment_dashboard.ui.pages._overview_query import (
    MULTI_CCY_RANGES,
    VALUE_RANGES,
    build_value_series,
    range_start_date,
    resolve_range_days,
)


def _seed(session: Session) -> None:
    a = accounts_repo.create_account(
        session,
        broker="vanguard",
        account_label="EUR Brokerage",
        native_currency="EUR",
        account_type="brokerage",
    )
    instr = instruments_repo.get_or_create(session, symbol="ACME", native_currency="EUR")
    session.add(
        Transaction(
            account_id=a.id,
            instrument_id=instr.id,
            date=date(2024, 1, 2),
            kind="buy",
            quantity=Decimal("10"),
            price_native=Decimal("100.00"),
            net_native=Decimal("-1000.00"),
            net_eur=Decimal("-1000.00"),
            source="manual",
        )
    )
    prices_repo.upsert_closes(session, instr.id, {date(2024, 1, 2): Decimal("100.00")})
    session.flush()


class TestResolveRange:
    def test_known_labels(self) -> None:
        assert resolve_range_days("Day") == ("Day", 1)
        assert resolve_range_days("Week") == ("Week", 7)
        assert resolve_range_days("Month") == ("Month", 30)
        assert resolve_range_days("YTD") == ("YTD", None)
        assert resolve_range_days("Year") == ("Year", 365)
        assert resolve_range_days("All") == ("All", None)

    def test_matching_is_case_insensitive(self) -> None:
        assert resolve_range_days("ytd") == ("YTD", None)
        assert resolve_range_days("week") == ("Week", 7)

    def test_unknown_defaults_to_year(self) -> None:
        assert resolve_range_days(None) == ("Year", 365)
        assert resolve_range_days("bogus") == ("Year", 365)

    def test_all_ranges_present(self) -> None:
        assert [name for name, _ in VALUE_RANGES] == [
            "Day",
            "Week",
            "Month",
            "YTD",
            "Year",
            "All",
        ]

    def test_multi_ccy_ranges_include_all_ranges(self) -> None:
        # Every range now carries the secondary-currency line, including the
        # intraday "Day" curve.
        assert "Day" in MULTI_CCY_RANGES
        assert {"Day", "Week", "Month", "YTD", "Year", "All"} == MULTI_CCY_RANGES


class TestRangeStartDate:
    def test_ytd_starts_at_jan_first(self, session: Session) -> None:
        start = range_start_date(session, "YTD", date(2024, 6, 15))
        assert start == date(2024, 1, 1)

    def test_fixed_lookback(self, session: Session) -> None:
        assert range_start_date(session, "Week", date(2024, 6, 15)) == date(2024, 6, 8)

    def test_all_uses_first_transaction(self, session: Session) -> None:
        _seed(session)
        assert range_start_date(session, "All", date(2024, 6, 1)) == date(2024, 1, 2)

    def test_all_empty_ledger_is_none(self, session: Session) -> None:
        assert range_start_date(session, "All", date(2024, 6, 1)) is None


class TestBuildValueSeries:
    def test_day_range_has_two_points(self, session: Session) -> None:
        _seed(session)
        end = date(2024, 6, 1)
        points = build_value_series(session, currency="EUR", range_label="Day", as_of=end)
        assert [p.date for p in points] == [end - timedelta(days=1), end]
        # EUR holding valued at the as-of close (forward-filled) ⇒ 10 * 100.
        assert points[-1].value == Decimal("1000.00")

    def test_all_range_starts_at_first_transaction(self, session: Session) -> None:
        _seed(session)
        end = date(2024, 1, 5)
        points = build_value_series(session, currency="EUR", range_label="All", as_of=end)
        assert points[0].date == date(2024, 1, 2)
        assert points[-1].date == end

    def test_empty_ledger_returns_no_points(self, session: Session) -> None:
        assert build_value_series(session, currency="EUR", range_label="All") == []

    def test_ytd_range_starts_at_january_first(self, session: Session) -> None:
        _seed(session)
        end = date(2024, 3, 1)
        points = build_value_series(session, currency="EUR", range_label="YTD", as_of=end)
        # The YTD window opens on 1 Jan, but that is New Year's Day — a market
        # holiday — so the first *plotted* point is the first trading session of
        # the year (2 Jan). Non-trading days are dropped from value graphs.
        assert points[0].date == date(2024, 1, 2)
        assert points[-1].date == end

    def test_non_trading_days_are_dropped(self, session: Session) -> None:
        _seed(session)
        # A window spanning a weekend: 2024-06-07 (Fri) … 2024-06-12 (Wed).
        end = date(2024, 6, 12)
        points = build_value_series(session, currency="EUR", range_label="Week", as_of=end)
        plotted = {p.date for p in points}
        # Sat 8 Jun and Sun 9 Jun carry only Friday's close forward → dropped.
        assert date(2024, 6, 8) not in plotted
        assert date(2024, 6, 9) not in plotted
        # The surrounding trading days remain.
        assert date(2024, 6, 7) in plotted
        assert date(2024, 6, 10) in plotted

    def test_live_tip_kept_even_on_a_non_trading_day(self, session: Session) -> None:
        _seed(session)
        # 2024-06-15 is a Saturday: the headline "today" tip must still close the
        # curve so it ends at the current value, even though it is non-trading.
        end = date(2024, 6, 15)
        points = build_value_series(session, currency="EUR", range_label="Week", as_of=end)
        assert points[-1].date == end


class TestBuildWeekValueSeries:
    def test_composes_base_plus_market(self, session: Session, monkeypatch) -> None:
        """The week curve reapplies the cash + NAV base to each intraday sample."""
        from investment_dashboard.services import intraday_snapshots_service as iss
        from investment_dashboard.ui.pages import _overview_query

        _seed(session)  # one €1,000 EUR holding ⇒ base 0, market €1,000

        t0 = datetime(2024, 5, 28, 14, 0)
        t1 = datetime(2024, 5, 28, 18, 0)
        samples = [
            (t0, Decimal("1000.00"), None),  # flat
            (t1, Decimal("1100.00"), None),  # +10%
        ]
        monkeypatch.setattr(iss, "week_series_with_fx", lambda *a, **k: list(samples))

        points = _overview_query.build_week_value_series(
            session, currency="EUR", now=datetime(2024, 6, 3, 20, 0, tzinfo=UTC)
        )
        # base == 0 here, so the plotted values equal the market component.
        assert [p.value for p in points[:2]] == [Decimal("1000.00"), Decimal("1100.00")]

    def test_empty_samples_returns_no_points(self, session: Session, monkeypatch) -> None:
        from investment_dashboard.services import intraday_snapshots_service as iss
        from investment_dashboard.ui.pages import _overview_query

        _seed(session)
        monkeypatch.setattr(iss, "week_series_with_fx", lambda *a, **k: [])
        assert _overview_query.build_week_value_series(session, currency="EUR") == []


class TestPreviousSessionCloseValue:
    def test_returns_prior_trading_day_settled_value(self, session: Session) -> None:
        from datetime import datetime

        from investment_dashboard.ui.pages._overview_query import previous_session_close_value

        _seed(session)
        # A Wednesday: the "Day" session is 2024-06-05, so the reference is the
        # prior trading day's (2024-06-04) settled value (forward-filled 1000).
        now = datetime(2024, 6, 5, 18, 0)
        value = previous_session_close_value(session, currency="EUR", now=now)
        assert value == Decimal("1000.00")

    def test_returns_none_for_empty_ledger(self, session: Session) -> None:
        from datetime import datetime

        from investment_dashboard.ui.pages._overview_query import previous_session_close_value

        now = datetime(2024, 6, 5, 18, 0)
        assert previous_session_close_value(session, currency="EUR", now=now) is None


class TestMarketAwareRange:
    """The Overview range auto-switches to Day in-session and restores after close."""

    # Mon 2024-06-03: 14:00 UTC == 10:00 ET (open); 23:00 UTC == 19:00 ET (closed).
    OPEN = datetime(2024, 6, 3, 14, 0, tzinfo=UTC)
    CLOSED = datetime(2024, 6, 3, 23, 0, tzinfo=UTC)
    NEXT_OPEN = datetime(2024, 6, 4, 14, 0, tzinfo=UTC)

    def test_market_open_fresh_session_defaults_to_day(self, session: Session) -> None:
        from investment_dashboard.services import chart_prefs_service
        from investment_dashboard.ui.pages._overview_query import effective_overview_range

        # Even with a standard "Year" pref, an open (untouched) session opens on Day.
        chart_prefs_service.set_pref(session, "overview_value_range", "Year")
        assert effective_overview_range(session, now=self.OPEN) == "Day"

    def test_market_closed_uses_standard_selection(self, session: Session) -> None:
        from investment_dashboard.services import chart_prefs_service
        from investment_dashboard.ui.pages._overview_query import effective_overview_range

        chart_prefs_service.set_pref(session, "overview_value_range", "Month")
        assert effective_overview_range(session, now=self.CLOSED) == "Month"

    def test_market_closed_default_when_unset(self, session: Session) -> None:
        from investment_dashboard.ui.pages._overview_query import effective_overview_range

        assert effective_overview_range(session, now=self.CLOSED) == "Year"

    def test_mid_session_change_is_remembered_for_that_session(self, session: Session) -> None:
        from investment_dashboard.ui.pages._overview_query import (
            effective_overview_range,
            remember_overview_range,
        )

        remember_overview_range(session, "Year", now=self.OPEN)
        # Sticks for the rest of the same session …
        assert effective_overview_range(session, now=self.OPEN) == "Year"
        # … but resets to Day at the next session.
        assert effective_overview_range(session, now=self.NEXT_OPEN) == "Day"

    def test_mid_session_change_does_not_touch_standard(self, session: Session) -> None:
        from investment_dashboard.ui.pages._overview_query import (
            effective_overview_range,
            remember_overview_range,
        )

        remember_overview_range(session, "Month", now=self.OPEN)
        # After the close the standard (untouched, default Year) is restored.
        assert effective_overview_range(session, now=self.CLOSED) == "Year"

    def test_change_while_closed_updates_standard(self, session: Session) -> None:
        from investment_dashboard.ui.pages._overview_query import (
            effective_overview_range,
            remember_overview_range,
        )

        remember_overview_range(session, "All", now=self.CLOSED)
        assert effective_overview_range(session, now=self.CLOSED) == "All"
        # And the in-session view is unaffected (still Day).
        assert effective_overview_range(session, now=self.OPEN) == "Day"
