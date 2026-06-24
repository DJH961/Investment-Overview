"""Tests for the logging-verbosity service (Settings → Logging)."""

from __future__ import annotations

import logging

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.repositories import app_config_repo
from investment_dashboard.services import logging_service


def test_default_level_is_info(session: Session) -> None:
    assert logging_service.get_log_level(session) == "INFO"


def test_set_persists_and_applies_to_root_logger(session: Session) -> None:
    previous = logging.getLogger().level
    try:
        logging_service.set_log_level(session, "DEBUG")
        assert logging_service.get_log_level(session) == "DEBUG"
        assert logging.getLogger().level == logging.DEBUG
    finally:
        logging.getLogger().setLevel(previous)


def test_set_normalises_case(session: Session) -> None:
    previous = logging.getLogger().level
    try:
        logging_service.set_log_level(session, "debug")
        assert app_config_repo.get(session, "log_level") == "DEBUG"
    finally:
        logging.getLogger().setLevel(previous)


def test_set_rejects_unknown_level(session: Session) -> None:
    with pytest.raises(ValueError, match="Unknown log level"):
        logging_service.set_log_level(session, "CHATTY")


def test_corrupt_stored_value_falls_back_to_default(session: Session) -> None:
    app_config_repo.set_value(session, "log_level", "NONSENSE")
    # Falls through to Settings.log_level (INFO by default in tests).
    assert logging_service.get_log_level(session) == "INFO"
