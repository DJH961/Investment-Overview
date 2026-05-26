"""Tests for the typed app_config key/value helpers added in v1.3."""

from __future__ import annotations

from sqlalchemy.orm import Session

from investment_dashboard.repositories import app_config_repo


def test_get_returns_none_when_missing(session: Session) -> None:
    assert app_config_repo.get(session, "missing") is None


def test_set_then_get(session: Session) -> None:
    app_config_repo.set_value(session, "display_currency", "USD")
    assert app_config_repo.get(session, "display_currency") == "USD"


def test_set_is_upsert(session: Session) -> None:
    app_config_repo.set_value(session, "k", "1")
    app_config_repo.set_value(session, "k", "2")
    assert app_config_repo.get(session, "k") == "2"
