"""Tests for the persisted 12h/24h/auto clock-format service."""

from __future__ import annotations

from datetime import datetime

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.repositories import app_config_repo
from investment_dashboard.services import clock_format_service


def test_default_is_auto(session: Session) -> None:
    assert clock_format_service.get_clock_format(session) == "auto"


def test_set_and_persist_round_trip(session: Session) -> None:
    assert clock_format_service.set_clock_format(session, "12h") == "12h"
    assert clock_format_service.get_clock_format(session) == "12h"

    assert clock_format_service.set_clock_format(session, "24h") == "24h"
    assert clock_format_service.get_clock_format(session) == "24h"

    assert clock_format_service.set_clock_format(session, "auto") == "auto"
    assert clock_format_service.get_clock_format(session) == "auto"


def test_set_persists_normalised_token(session: Session) -> None:
    clock_format_service.set_clock_format(session, "  12H  ")
    assert app_config_repo.get(session, "clock_format") == "12h"


def test_unknown_stored_value_falls_back_to_auto(session: Session) -> None:
    app_config_repo.set_value(session, "clock_format", "swatch")
    assert clock_format_service.get_clock_format(session) == "auto"


def test_set_rejects_unsupported(session: Session) -> None:
    with pytest.raises(ValueError, match="Unsupported clock format"):
        clock_format_service.set_clock_format(session, "13h")


def test_format_clock_12h_vs_24h() -> None:
    when = datetime(2026, 1, 2, 15, 4)
    assert clock_format_service.format_clock(when, "24h") == "2026-01-02 15:04"
    twelve = clock_format_service.format_clock(when, "12h")
    assert twelve.startswith("2026-01-02 03:04")
    assert twelve.endswith(("AM", "PM"))


def test_format_clock_auto_falls_back_to_24h() -> None:
    when = datetime(2026, 1, 2, 15, 4)
    # "auto" / unexpected values use the stable 24-hour rendering.
    assert clock_format_service.format_clock(when, "auto") == "2026-01-02 15:04"
    assert clock_format_service.format_clock(when, "bogus") == "2026-01-02 15:04"
