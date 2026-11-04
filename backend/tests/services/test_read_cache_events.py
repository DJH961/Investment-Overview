"""Which live events throw cached reads away (and which must not)."""

from __future__ import annotations

from investment_dashboard.services import read_cache
from investment_dashboard.services.live_bus import LiveBus


def _bumped(event: dict[str, object]) -> bool:
    before = read_cache.generations()
    LiveBus().publish(event)  # type: ignore[arg-type]
    return read_cache.generations() != before


def test_unchanged_checks_keep_the_cache() -> None:
    assert not _bumped({"type": "tick", "unchanged": True})
    assert not _bumped({"type": "fx", "unchanged": True})
    assert _bumped({"type": "tick"})
    assert _bumped({"type": "fx"})


def test_presentation_settings_keep_the_cache() -> None:
    # Switching EUR/USD or the theme changes no server read (/both answers both).
    assert not _bumped({"type": "settings", "keys": ["display_currency"]})
    assert not _bumped({"type": "settings", "keys": ["display_currency", "theme"]})
    # Anything else (timezone, lookback...) still recomputes.
    assert _bumped({"type": "settings", "keys": ["display_currency", "display.timezone"]})
    assert _bumped({"type": "settings"})


def test_job_progress_keeps_the_cache_until_the_job_finishes() -> None:
    assert not _bumped({"type": "job", "status": "running"})
    assert _bumped({"type": "job", "status": "succeeded"})
    assert _bumped({"type": "job", "status": "failed"})


def test_restart_notice_keeps_the_cache() -> None:
    assert not _bumped({"type": "server", "state": "restarting"})
