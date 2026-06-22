"""Tests for the persisted Analytics lookback-window preference."""

from __future__ import annotations

from sqlalchemy.orm import Session

from investment_dashboard.repositories import app_config_repo
from investment_dashboard.services import analytics_prefs_service


def test_default_is_one_year(session: Session) -> None:
    # No stored value -> 365 days (1Y) to preserve prior behaviour.
    assert analytics_prefs_service.get_lookback_days(session) == 365


def test_set_and_persist_round_trip(session: Session) -> None:
    assert analytics_prefs_service.set_lookback_days(session, 91) == 91
    assert analytics_prefs_service.get_lookback_days(session) == 91

    assert analytics_prefs_service.set_lookback_days(session, 30) == 30
    assert analytics_prefs_service.get_lookback_days(session) == 30


def test_set_clamps_out_of_range(session: Session) -> None:
    assert analytics_prefs_service.set_lookback_days(session, 1) == (
        analytics_prefs_service.MIN_LOOKBACK_DAYS
    )
    assert analytics_prefs_service.set_lookback_days(session, 10_000) == (
        analytics_prefs_service.MAX_LOOKBACK_DAYS
    )


def test_set_persists_string_value(session: Session) -> None:
    analytics_prefs_service.set_lookback_days(session, 182)
    assert app_config_repo.get(session, "analytics_lookback_days") == "182"


def test_corrupt_stored_value_falls_back_to_default(session: Session) -> None:
    app_config_repo.set_value(session, "analytics_lookback_days", "not-a-number")
    assert analytics_prefs_service.get_lookback_days(session) == 365


def test_stored_value_is_clamped_on_read(session: Session) -> None:
    app_config_repo.set_value(session, "analytics_lookback_days", "99999")
    assert analytics_prefs_service.get_lookback_days(session) == (
        analytics_prefs_service.MAX_LOOKBACK_DAYS
    )
