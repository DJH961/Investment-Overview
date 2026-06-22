"""Tests for the chart-preference service (per-graph range stickiness)."""

from __future__ import annotations

from sqlalchemy.orm import Session

from investment_dashboard.services import chart_prefs_service


def test_default_when_unset(session: Session) -> None:
    assert chart_prefs_service.get_pref(session, "overview_value_range", default="Year") == "Year"


def test_set_and_get_roundtrip(session: Session) -> None:
    chart_prefs_service.set_pref(session, "overview_value_range", "All")
    assert chart_prefs_service.get_pref(session, "overview_value_range", default="Year") == "All"


def test_value_outside_allowed_falls_back_to_default(session: Session) -> None:
    chart_prefs_service.set_pref(session, "analytics_lookback", "9999")
    got = chart_prefs_service.get_pref(
        session, "analytics_lookback", default="365", allowed=("30", "365")
    )
    assert got == "365"


def test_allowed_value_is_returned(session: Session) -> None:
    chart_prefs_service.set_pref(session, "analytics_lookback", "30")
    got = chart_prefs_service.get_pref(
        session, "analytics_lookback", default="365", allowed=("30", "365")
    )
    assert got == "30"


def test_keys_are_namespaced_and_independent(session: Session) -> None:
    chart_prefs_service.set_pref(session, "overview_value_range", "Month")
    chart_prefs_service.set_pref(session, "projection_granularity", "Monthly")
    assert chart_prefs_service.get_pref(session, "overview_value_range", default="Year") == "Month"
    assert (
        chart_prefs_service.get_pref(session, "projection_granularity", default="Yearly")
        == "Monthly"
    )
