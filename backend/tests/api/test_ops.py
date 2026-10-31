"""``/api/refresh`` single-flight trigger and ``/api/backup`` download."""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.api import ops
from investment_dashboard.db import config_session_scope
from investment_dashboard.repositories import app_config_repo
from investment_dashboard.services import auto_refresh, refresh_status


@pytest.fixture(autouse=True)
def _reset_flight() -> None:
    refresh_status.reset()
    ops._flight_running = False


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
    api_client: TestClient, api_db: Path, tmp_path: Path
) -> None:
    with config_session_scope() as s:
        app_config_repo.set_value(s, "theme", "dark")
        app_config_repo.set_value(s, "tiingo_token", "SECRET-VALUE")
    resp = api_client.get("/api/backup")
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
