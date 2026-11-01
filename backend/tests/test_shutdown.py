"""Tests for clean shutdown + writer-lock handoff."""

from __future__ import annotations

import asyncio

import pytest

from investment_dashboard import boot, shutdown


class _FakeLock:
    """Stand-in WriteLock that records whether it was released."""

    def __init__(self) -> None:
        self.released = False

    def release(self) -> None:
        self.released = True


@pytest.fixture(autouse=True)
def _restore_boot_state() -> None:
    saved = dict(boot._boot_state)
    shutdown._state["shutting_down"] = False
    shutdown._state["auto_shutdown"] = False
    yield
    boot._boot_state.update(saved)
    shutdown._state["shutting_down"] = False
    shutdown._state["auto_shutdown"] = False


def test_release_writer_lock_releases_and_flips_read_only() -> None:
    lock = _FakeLock()
    boot._boot_state["held_lock"] = lock
    boot._boot_state["read_only"] = False

    assert boot.holds_writer_lock() is True
    assert boot.release_writer_lock() is True
    assert lock.released is True
    assert boot.holds_writer_lock() is False
    assert boot.is_read_only() is True


def test_release_writer_lock_is_idempotent() -> None:
    lock = _FakeLock()
    boot._boot_state["held_lock"] = lock
    boot._boot_state["read_only"] = False

    assert boot.release_writer_lock() is True
    # Second call has nothing to release.
    assert boot.release_writer_lock() is False


def test_release_writer_lock_noop_when_read_only() -> None:
    boot._boot_state["held_lock"] = None
    boot._boot_state["read_only"] = True
    assert boot.release_writer_lock() is False
    assert boot.is_read_only() is True


def test_request_shutdown_releases_lock_and_stops_server(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    lock = _FakeLock()
    boot._boot_state["held_lock"] = lock
    boot._boot_state["read_only"] = False

    calls: list[str] = []
    monkeypatch.setattr(shutdown.app, "shutdown", lambda: calls.append("shutdown"))

    shutdown.request_shutdown()
    assert lock.released is True
    assert calls == ["shutdown"]

    # Idempotent: a second request must not call shutdown again.
    shutdown.request_shutdown()
    assert calls == ["shutdown"]


def test_handoff_releases_without_stopping_server(monkeypatch: pytest.MonkeyPatch) -> None:
    lock = _FakeLock()
    boot._boot_state["held_lock"] = lock
    boot._boot_state["read_only"] = False

    calls: list[str] = []
    monkeypatch.setattr(shutdown.app, "shutdown", lambda: calls.append("shutdown"))

    assert shutdown.release_writer_lock_for_handoff() is True
    assert lock.released is True
    assert calls == []  # server keeps running
    assert boot.is_read_only() is True
    # Nothing left to hand off.
    assert shutdown.release_writer_lock_for_handoff() is False


def test_auto_shutdown_disabled_does_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    shutdown.set_auto_shutdown(False)
    called: list[str] = []
    monkeypatch.setattr(shutdown, "request_shutdown", lambda: called.append("x"))
    monkeypatch.setattr(shutdown, "GRACE_SECONDS", 0.0)

    asyncio.run(shutdown._on_disconnect())
    assert called == []


def test_auto_shutdown_triggers_when_no_clients(monkeypatch: pytest.MonkeyPatch) -> None:
    shutdown.set_auto_shutdown(True)
    called: list[str] = []
    monkeypatch.setattr(shutdown, "request_shutdown", lambda: called.append("x"))
    monkeypatch.setattr(shutdown, "GRACE_SECONDS", 0.0)
    monkeypatch.setattr(shutdown, "_connected_client_count", lambda: 0)

    asyncio.run(shutdown._on_disconnect())
    assert called == ["x"]


def test_auto_shutdown_skips_when_clients_remain(monkeypatch: pytest.MonkeyPatch) -> None:
    shutdown.set_auto_shutdown(True)
    called: list[str] = []
    monkeypatch.setattr(shutdown, "request_shutdown", lambda: called.append("x"))
    monkeypatch.setattr(shutdown, "GRACE_SECONDS", 0.0)
    # A tab reconnected during the grace window (e.g. in-app navigation).
    monkeypatch.setattr(shutdown, "_connected_client_count", lambda: 1)

    asyncio.run(shutdown._on_disconnect())
    assert called == []


def test_install_registers_on_shutdown_lock_release(monkeypatch: pytest.MonkeyPatch) -> None:
    shutdown_handlers: list[object] = []
    disconnect_handlers: list[object] = []
    monkeypatch.setattr(shutdown.app, "on_shutdown", shutdown_handlers.append)
    monkeypatch.setattr(shutdown.app, "on_disconnect", disconnect_handlers.append)

    shutdown.install(auto_shutdown=True)

    assert boot.release_writer_lock in shutdown_handlers
    assert shutdown._on_disconnect in disconnect_handlers
    assert shutdown.auto_shutdown_enabled() is True


def test_resolve_auto_shutdown_prefers_persisted_value(monkeypatch: pytest.MonkeyPatch) -> None:
    from investment_dashboard import main

    # Persisted "true" wins regardless of the setting default.
    monkeypatch.setattr(
        "investment_dashboard.repositories.app_config_repo.get",
        lambda _session, _key: "true",
    )
    assert main._resolve_auto_shutdown() is True

    monkeypatch.setattr(
        "investment_dashboard.repositories.app_config_repo.get",
        lambda _session, _key: "no",
    )
    assert main._resolve_auto_shutdown() is False


def test_resolve_auto_shutdown_falls_back_to_setting(monkeypatch: pytest.MonkeyPatch) -> None:
    from investment_dashboard import main
    from investment_dashboard.config import get_settings

    monkeypatch.setattr(
        "investment_dashboard.repositories.app_config_repo.get",
        lambda _session, _key: None,
    )
    monkeypatch.setenv("INV_DASHBOARD_SHUTDOWN_ON_TAB_CLOSE", "true")
    get_settings.cache_clear()
    try:
        assert main._resolve_auto_shutdown() is True
    finally:
        get_settings.cache_clear()


class _FakeUI:
    """Minimal stand-in for ``nicegui.ui`` capturing the shutdown sequence."""

    def __init__(self) -> None:
        self.notifications: list[tuple[str, str | None]] = []
        self.scripts: list[str] = []
        self.timers: list[tuple[float, object]] = []

    def notify(self, message: str, *, type: str | None = None) -> None:
        self.notifications.append((message, type))

    def run_javascript(self, script: str) -> None:
        self.scripts.append(script)

    def timer(self, interval: float, callback: object, *, once: bool = False) -> None:
        assert once is True
        self.timers.append((interval, callback))


def _install_fake_ui(monkeypatch: pytest.MonkeyPatch) -> _FakeUI:
    import nicegui

    fake = _FakeUI()
    monkeypatch.setattr(nicegui, "ui", fake, raising=False)
    return fake


def test_begin_graceful_shutdown_notifies_publish_and_defers_stop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from investment_dashboard.services import auto_publish

    fake = _install_fake_ui(monkeypatch)
    monkeypatch.setattr(
        auto_publish,
        "run_trigger",
        lambda trigger: auto_publish.PublishOutcome(trigger, "failed", detail="no token"),
    )
    stopped: list[str] = []
    monkeypatch.setattr(shutdown, "request_shutdown", lambda **kw: stopped.append(str(kw)))

    shutdown.begin_graceful_shutdown(delay=0.1)

    # The full-screen overlay is painted *immediately*, before any upload runs.
    assert any("__invBeginShutdown" in script for script in fake.scripts)
    # No publish/notify yet — the upload is deferred behind the overlay.
    assert fake.notifications == []
    # The upload + stop are deferred to a one-shot timer so the overlay paints first.
    assert len(fake.timers) == 1
    interval, publish_cb = fake.timers[0]
    assert interval == 0.1

    # Fire the deferred upload step.
    publish_cb()  # type: ignore[operator]
    # The publish outcome is surfaced to the user.
    assert fake.notifications == [("Live-web publish failed: no token", "negative")]
    # The overlay swaps to its final "shut down — close this tab" frame.
    assert any("__invFinishShutdown" in script for script in fake.scripts)
    # The server stop is itself deferred to a second one-shot timer.
    assert len(fake.timers) == 2
    _, stop_cb = fake.timers[1]
    assert stopped == []  # not stopped until the second timer fires
    stop_cb()  # type: ignore[operator]
    assert stopped == ["{'publish': False}"]


def test_begin_graceful_shutdown_skipped_publish_still_confirms(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from investment_dashboard.services import auto_publish

    fake = _install_fake_ui(monkeypatch)
    monkeypatch.setattr(
        auto_publish,
        "run_trigger",
        lambda trigger: auto_publish.PublishOutcome(trigger, "skipped"),
    )
    monkeypatch.setattr(shutdown, "request_shutdown", lambda **kw: None)

    shutdown.begin_graceful_shutdown(delay=0.1)
    # The overlay is shown immediately even when publishing is off.
    assert any("__invBeginShutdown" in script for script in fake.scripts)

    # Fire the deferred upload step.
    _, publish_cb = fake.timers[0]
    publish_cb()  # type: ignore[operator]

    # No publish note for a skipped/disabled upload, but the overlay still
    # transitions to its final "shut down" frame.
    assert fake.notifications == []
    assert any("__invFinishShutdown" in script for script in fake.scripts)
