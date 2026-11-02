"""``/api/refresh`` single-flight trigger and ``/api/backup`` download."""

from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterator
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.api import ops, security
from investment_dashboard.config import get_settings
from investment_dashboard.db import config_session_scope
from investment_dashboard.repositories import app_config_repo
from investment_dashboard.services import auth_service, auto_refresh, refresh_status

ORIGIN = "http://localhost:5173"
PASSWORD = "correct horse battery"
TOKEN = "s3cret-token-value-0123456789-abcdefghij"


@pytest.fixture(autouse=True)
def _reset_flight() -> None:
    refresh_status.reset()
    ops._flight_running = False


async def _fresh() -> None:
    return None


@pytest.fixture
def backup_client(api_client: TestClient) -> TestClient:
    """``api_client`` that also passes the fresh-session rule on ``/api/backup``."""
    api_client.app.dependency_overrides[security.require_fresh_session] = _fresh  # type: ignore[attr-defined]
    return api_client


def test_refresh_runs_once_and_refuses_concurrent(
    api_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    started = threading.Event()
    release = threading.Event()
    calls: list[tuple[str, bool]] = []

    def fake_tick(source: str = "x", *, force: bool = False) -> bool:
        calls.append((source, force))
        started.set()
        release.wait(5)
        return True

    monkeypatch.setattr(auto_refresh, "tick_refresh", fake_tick)
    first = api_client.post("/api/refresh")
    assert first.status_code == 202
    assert first.json()["running"] is True
    assert started.wait(5)

    assert api_client.post("/api/refresh").status_code == 409
    assert api_client.get("/api/refresh/status").json()["running"] is True

    release.set()
    for _ in range(100):
        if not api_client.get("/api/refresh/status").json()["running"]:
            break
        threading.Event().wait(0.05)
    assert api_client.get("/api/refresh/status").json()["running"] is False
    assert calls == [("Manual refresh", True)]
    assert api_client.post("/api/refresh", params={"force": "false"}).status_code in (202, 409)


def test_backup_is_a_consistent_snapshot_without_secrets(
    backup_client: TestClient, api_db: Path, tmp_path: Path
) -> None:
    api_client = backup_client
    with config_session_scope() as s:
        app_config_repo.set_value(s, "theme", "dark")
        app_config_repo.set_value(s, "tiingo_token", "SECRET-VALUE")
    resp = api_client.get("/api/backup", params={"kind": "db"})
    assert resp.status_code == 200
    assert "attachment" in resp.headers["content-disposition"]
    assert resp.headers["content-disposition"].endswith('.sqlite"')
    out = tmp_path / "restored.sqlite"
    out.write_bytes(resp.content)
    with sqlite3.connect(out) as conn:
        keys = {r[0] for r in conn.execute("SELECT key FROM app_config")}
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert "theme" in keys
    assert "tiingo_token" not in keys
    assert b"SECRET-VALUE" not in resp.content


def test_requires_auth(anon_client: TestClient) -> None:
    assert anon_client.post("/api/refresh").status_code == 401
    assert anon_client.get("/api/refresh/status").status_code == 401
    assert anon_client.get("/api/backup").status_code == 401


def test_backup_defaults_to_sealed(
    backup_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    api_client = backup_client
    monkeypatch.setenv("INV_DASHBOARD_BACKUP_PASSPHRASE", "test-passphrase")
    resp = api_client.get("/api/backup")
    assert resp.status_code == 200
    assert resp.headers["content-disposition"].endswith('.sealed.json"')


# ------------------------------------------------------------------ fresh-session rule


class _Clock:
    def __init__(self) -> None:
        self.t = datetime(2026, 1, 1, 12, 0, 0)

    def __call__(self) -> datetime:
        return self.t


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> _Clock:
    c = _Clock()
    monkeypatch.setattr(auth_service, "_clock", c)
    return c


@pytest.fixture
def real_client(anon_client: TestClient) -> Iterator[TestClient]:
    auth_service.reset_limiters()
    with config_session_scope() as s:
        auth_service.set_password(s, PASSWORD)
    anon_client.headers["Origin"] = ORIGIN
    yield anon_client
    auth_service.reset_limiters()


def test_backup_needs_a_fresh_session(
    real_client: TestClient, clock: _Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("INV_DASHBOARD_BACKUP_PASSPHRASE", "test-passphrase")
    assert real_client.post("/api/auth/login", json={"password": PASSWORD}).status_code == 204
    assert real_client.get("/api/backup").status_code == 200
    # Reads keep the session alive, but it is no longer "fresh".
    clock.t += timedelta(minutes=get_settings().fresh_session_minutes - 1)
    assert real_client.get("/api/refresh/status").status_code == 200
    clock.t += timedelta(minutes=2)
    stale = real_client.get("/api/backup", params={"kind": "db"})
    assert stale.status_code == 403
    assert stale.json()["detail"]["code"] == "reauth_required"
    assert real_client.get("/api/refresh/status").status_code == 200  # still signed in
    # Signing in again issues a fresh session.
    assert real_client.post("/api/auth/login", json={"password": PASSWORD}).status_code == 204
    assert real_client.get("/api/backup", params={"kind": "db"}).status_code == 200


def test_api_token_cannot_download_backup(
    real_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("INV_DASHBOARD_API_TOKEN", TOKEN)
    get_settings.cache_clear()
    headers = {"Authorization": f"Bearer {TOKEN}"}
    assert real_client.get("/api/refresh/status", headers=headers).status_code == 200
    resp = real_client.get("/api/backup", params={"kind": "db"}, headers=headers)
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "session_required"
