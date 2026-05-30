"""Tests for the Overview value-over-time series (v2.8 item 5)."""

from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction
from investment_dashboard.repositories import accounts_repo, instruments_repo, prices_repo
from investment_dashboard.ui.pages._overview_query import (
    VALUE_RANGES,
    build_value_series,
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
        assert resolve_range_days("Month") == ("Month", 30)
        assert resolve_range_days("Year") == ("Year", 365)
        assert resolve_range_days("All") == ("All", None)

    def test_unknown_defaults_to_year(self) -> None:
        assert resolve_range_days(None) == ("Year", 365)
        assert resolve_range_days("bogus") == ("Year", 365)

    def test_all_ranges_present(self) -> None:
        assert [name for name, _ in VALUE_RANGES] == ["Day", "Month", "Year", "All"]


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
