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


def test_delete_key(session: Session) -> None:
    app_config_repo.set_value(session, "test_key", "val")
    assert app_config_repo.delete_key(session, "test_key") is True
    assert app_config_repo.get(session, "test_key") is None
    assert app_config_repo.delete_key(session, "test_key") is False


def test_delete_by_prefix(session: Session) -> None:
    app_config_repo.set_value(session, "prefix_1", "a")
    app_config_repo.set_value(session, "prefix_2", "b")
    app_config_repo.set_value(session, "other", "c")
    assert app_config_repo.delete_by_prefix(session, "prefix_") == 2
    assert app_config_repo.get(session, "prefix_1") is None
    assert app_config_repo.get(session, "prefix_2") is None
    assert app_config_repo.get(session, "other") == "c"
