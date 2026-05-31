"""Tests for the header timezone service introduced in v2.8.1."""

from __future__ import annotations

from datetime import UTC
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy.orm import Session

from investment_dashboard.services import timezone_service


def test_default_is_local(session: Session) -> None:
    assert timezone_service.get_timezone(session) == timezone_service.LOCAL


def test_set_and_persist_iana_zone(session: Session) -> None:
    timezone_service.set_timezone(session, "Asia/Tokyo")
    assert timezone_service.get_timezone(session) == "Asia/Tokyo"
    timezone_service.set_timezone(session, "UTC")
    assert timezone_service.get_timezone(session) == "UTC"


def test_rejects_unknown_zone(session: Session) -> None:
    with pytest.raises(ValueError, match="Unknown timezone"):
        timezone_service.set_timezone(session, "Not/AZone")


def test_corrupt_stored_value_falls_back_to_default(session: Session) -> None:
    from investment_dashboard.repositories import app_config_repo

    app_config_repo.set_value(session, "display_timezone", "Bogus/Zone")
    assert timezone_service.get_timezone(session) == timezone_service.DEFAULT_TIMEZONE


def test_resolve_tzinfo_known_and_sentinels() -> None:
    assert timezone_service.resolve_tzinfo("UTC") is UTC
    assert timezone_service.resolve_tzinfo("Europe/Berlin") == ZoneInfo("Europe/Berlin")
    # Unknown names degrade to the machine-local tzinfo rather than raising.
    assert timezone_service.resolve_tzinfo("Bogus/Zone") is not None


def test_now_uses_persisted_zone(session: Session) -> None:
    timezone_service.set_timezone(session, "Asia/Tokyo")
    assert timezone_service.now(session).tzinfo == ZoneInfo("Asia/Tokyo")


def test_supported_timezones_lists_sentinels_first(session: Session) -> None:
    zones = timezone_service.supported_timezones()
    assert zones[0] == timezone_service.LOCAL
    assert zones[1] == "UTC"
    assert "Europe/Berlin" in zones
