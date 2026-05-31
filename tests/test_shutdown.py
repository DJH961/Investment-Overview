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

    monkeypatch.setattr(main, "_resolve_auto_shutdown", main._resolve_auto_shutdown)
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
