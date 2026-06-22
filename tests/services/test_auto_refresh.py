"""Tests for the user-editable auto-update interval (services.auto_refresh)."""

from __future__ import annotations

from sqlalchemy.orm import Session

from investment_dashboard.services import auto_refresh


def test_interval_defaults_when_unset(session: Session) -> None:
    assert auto_refresh.get_interval_seconds(session) == auto_refresh.DEFAULT_INTERVAL_SECONDS


def test_interval_roundtrips_and_clamps(session: Session) -> None:
    # Normal value persists exactly.
    assert auto_refresh.set_interval_seconds(session, 120) == 120
    assert auto_refresh.get_interval_seconds(session) == 120
    # Below the floor clamps up.
    assert auto_refresh.set_interval_seconds(session, 1) == auto_refresh.MIN_INTERVAL_SECONDS
    # Above the ceiling clamps down.
    assert auto_refresh.set_interval_seconds(session, 99999) == auto_refresh.MAX_INTERVAL_SECONDS


def test_interval_ignores_corrupt_stored_value(session: Session) -> None:
    from investment_dashboard.repositories import app_config_repo

    app_config_repo.set_value(session, "live_refresh_interval_seconds", "not-a-number")
    assert auto_refresh.get_interval_seconds(session) == auto_refresh.DEFAULT_INTERVAL_SECONDS
