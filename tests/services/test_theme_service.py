"""Tests for the persisted light/dark/auto theme service."""

from __future__ import annotations

from sqlalchemy.orm import Session

from investment_dashboard.repositories import app_config_repo
from investment_dashboard.services import theme_service


def test_default_is_auto(session: Session) -> None:
    # No stored value -> "auto" -> None (follow OS).
    assert theme_service.get_theme(session) is None


def test_set_and_persist_round_trip(session: Session) -> None:
    assert theme_service.set_theme(session, True) is True
    assert theme_service.get_theme(session) is True

    assert theme_service.set_theme(session, False) is False
    assert theme_service.get_theme(session) is False

    assert theme_service.set_theme(session, None) is None
    assert theme_service.get_theme(session) is None


def test_set_persists_normalised_token(session: Session) -> None:
    theme_service.set_theme(session, True)
    assert app_config_repo.get(session, "theme") == "dark"
    theme_service.set_theme(session, False)
    assert app_config_repo.get(session, "theme") == "light"
    theme_service.set_theme(session, None)
    assert app_config_repo.get(session, "theme") == "auto"


def test_unknown_stored_value_falls_back_to_auto(session: Session) -> None:
    # A corrupted / unexpected stored token degrades to the default.
    app_config_repo.set_value(session, "theme", "neon")
    assert theme_service.get_theme(session) is None


def test_stored_value_is_normalised_on_read(session: Session) -> None:
    # Whitespace and case are tolerated on read.
    app_config_repo.set_value(session, "theme", "  DARK  ")
    assert theme_service.get_theme(session) is True
