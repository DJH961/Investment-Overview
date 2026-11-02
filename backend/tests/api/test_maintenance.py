"""``/api/maintenance``: jobs (session-only, typed confirm, single flight), market data, logs."""

from __future__ import annotations

import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.api import guards, security
from investment_dashboard.api.security import Principal
from investment_dashboard.config import get_settings
from investment_dashboard.db import ledger_session_scope
from investment_dashboard.models import Instrument
from investment_dashboard.services import job_runner, scheduler
from investment_dashboard.services import maintenance_service as ms


@pytest.fixture(autouse=True)
def _clean() -> Iterator[None]:
    job_runner.reset_for_tests()
    scheduler.reset_pauses_for_tests()
    yield
    job_runner.reset_for_tests()
    scheduler.reset_pauses_for_tests()


def _as(monkeypatch: pytest.MonkeyPatch, kind: str) -> None:
    async def principal(_r: object) -> Principal:
        return Principal(kind=kind, session_id="0123456789abcdef" if kind == "session" else None)

    monkeypatch.setattr(guards, "_principal", principal)
    monkeypatch.setattr(guards, "require_fresh_session", principal)  # signed in just now


def _fake(monkeypatch: pytest.MonkeyPatch, job_id: str, fn: Any) -> None:
    spec = ms.BY_ID[job_id]
    monkeypatch.setitem(ms.BY_ID, job_id, ms.JobSpec(**{**spec.__dict__, "run": fn}))


def _wait(client: TestClient, run_id: str) -> dict[str, Any]:
    for _ in range(200):
        run = client.get(f"/api/maintenance/runs/{run_id}").json()
        if run["status"] != "running":
            return run
        threading.Event().wait(0.02)
    raise AssertionError("run did not finish")


def test_catalogue(api_client: TestClient) -> None:
    data = api_client.get("/api/maintenance/jobs").json()
    ids = {j["id"] for j in data["jobs"]}
    assert {"prices.refresh", "cache.reset", "backup.now"} <= ids
    reset = next(j for j in data["jobs"] if j["id"] == "cache.reset")
    assert reset["danger"] == "typed"
    assert reset["confirm_word"] == "RESET"


def test_jobs_need_a_browser_session(
    api_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _as(monkeypatch, "token")
    resp = api_client.post("/api/maintenance/jobs/cache.janitor", json={})
    assert resp.status_code == 403


def test_typed_confirm_and_single_flight(
    api_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _as(monkeypatch, "session")
    gate = threading.Event()
    _fake(monkeypatch, "cache.reset", lambda _p: gate.wait(5) and {"deleted_rows": 1})
    no = api_client.post("/api/maintenance/jobs/cache.reset", json={"confirm": "reset"})
    assert no.status_code == 422
    assert "confirm" in no.json()["errors"]
    first = api_client.post("/api/maintenance/jobs/cache.reset", json={"confirm": "RESET"})
    assert first.status_code == 202, first.text
    assert first.json()["actor"] == "session:01234567"
    again = api_client.post("/api/maintenance/jobs/cache.reset", json={"confirm": "RESET"})
    assert again.status_code == 409
    other_heavy = api_client.post("/api/maintenance/jobs/fx.refresh", json={})
    assert other_heavy.status_code == 409
    gate.set()
    done = _wait(api_client, first.json()["id"])
    assert done["status"] == "succeeded"
    assert done["result"]["backup"] is None  # no backup passphrase in tests


def test_bad_params_and_unknown_job(
    api_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _as(monkeypatch, "session")
    resp = api_client.post("/api/maintenance/jobs/graphs.reload", json={"params": {"which": "x"}})
    assert resp.status_code == 422
    assert resp.json()["errors"] == {"which": "must be one of day, week, all"}
    assert api_client.post("/api/maintenance/jobs/nope", json={}).status_code == 404
    assert api_client.get("/api/maintenance/runs/missing").status_code == 404


def test_scheduler_disabled_and_pause(
    api_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _as(monkeypatch, "session")
    monkeypatch.setattr(scheduler, "_save_pauses", lambda: None)
    assert api_client.get("/api/maintenance/scheduler").json()["enabled"] is False
    assert api_client.post("/api/maintenance/scheduler/tick/run").status_code == 409
    resp = api_client.put("/api/maintenance/scheduler/pause", json={"jobs": ["fx"], "paused": True})
    assert resp.status_code == 200
    from datetime import UTC, datetime

    pauses = scheduler.paused(datetime.now(UTC))
    assert set(pauses) == {"fx"}
    hours = (pauses["fx"] - datetime.now(UTC)).total_seconds() / 3600
    assert 23 < hours <= 24  # default pause_default_hours
    api_client.put("/api/maintenance/scheduler/pause", json={"jobs": ["fx"], "paused": False})
    assert scheduler.paused(datetime.now(UTC)) == {}


def test_scheduler_snapshot_and_run_now(
    api_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _as(monkeypatch, "session")
    sched = scheduler.Scheduler()
    api_client.app.state.scheduler = sched  # type: ignore[attr-defined]
    try:
        snap = api_client.get("/api/maintenance/scheduler").json()
        assert snap["enabled"] is True
        assert [j["name"] for j in snap["jobs"]] == ["tick", "fx", "eod", "backup"]
        resp = api_client.post("/api/maintenance/scheduler/fx/run")
        assert next(j for j in resp.json()["jobs"] if j["name"] == "fx")["requested"] is True
        assert api_client.post("/api/maintenance/scheduler/nope/run").status_code == 404
    finally:
        api_client.app.state.scheduler = None  # type: ignore[attr-defined]


def test_manual_close_routes(api_client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    _as(monkeypatch, "session")
    with ledger_session_scope() as s:
        instr = Instrument(symbol="AAA", name="A", asset_class="etf", native_currency="USD")
        s.add(instr)
        s.flush()
        iid = instr.id
    put = api_client.put(f"/api/maintenance/prices/{iid}/2026-01-05", json={"close": "12.5"})
    assert put.status_code == 200, put.text
    assert put.json()["closes"] == [
        {"date": "2026-01-05", "close": "12.500000", "source": "manual"}
    ]
    assert (
        api_client.get(f"/api/maintenance/prices/{iid}").json()["closes"][0]["source"] == "manual"
    )
    assert (
        api_client.put(
            f"/api/maintenance/prices/{iid}/2026-01-05", json={"close": "-1"}
        ).status_code
        == 422
    )
    assert api_client.delete(f"/api/maintenance/prices/{iid}/2026-01-05").status_code == 204
    assert api_client.delete(f"/api/maintenance/prices/{iid}/2026-01-05").status_code == 404
    assert api_client.get("/api/maintenance/prices/999").status_code == 404
    assert api_client.get("/api/maintenance/prices/anomalies").json() == {"instrument_ids": []}

    fx = api_client.put("/api/maintenance/fx/usd/2026-01-05", json={"rate": "1.08"})
    assert fx.json()["rates"][0]["source"] == "manual"
    assert api_client.delete("/api/maintenance/fx/USD/2026-01-05").status_code == 204
    split = api_client.put(f"/api/maintenance/splits/{iid}/2026-01-05", json={"ratio": "2"})
    assert split.json()["splits"][0]["ratio"] == "2.00000000"
    assert api_client.delete(f"/api/maintenance/splits/{iid}/2026-01-05").status_code == 204

    _as(monkeypatch, "token")
    assert (
        api_client.put(f"/api/maintenance/prices/{iid}/2026-01-06", json={"close": "1"}).status_code
        == 403
    )


def test_logs_are_redacted(
    api_client: TestClient, monkeypatch: pytest.MonkeyPatch, api_db: Path
) -> None:
    _as(monkeypatch, "token")
    log_file = get_settings().log_file_path
    log_file.parent.mkdir(parents=True, exist_ok=True)
    log_file.write_text(
        "2026-01-01 10:00:00 INFO    investment_dashboard.x — hello Bearer abcdefghijklmnop\n"
        "2026-01-01 10:00:01 ERROR   investment_dashboard.y — failed\n"
        "Traceback (most recent call last):\n"
        '  File "x.py", line 1\n'
        "2026-01-01 10:00:02 DEBUG   investment_dashboard.z — noisy\n",
        encoding="utf-8",
    )
    data = api_client.get("/api/maintenance/logs").json()
    assert [e["logger"] for e in data["entries"]] == [
        "investment_dashboard.y",
        "investment_dashboard.x",
    ]
    assert "abcdefghijklmnop" not in str(data)
    assert data["entries"][0]["traceback"] is None
    errors = api_client.get("/api/maintenance/logs", params={"level": "ERROR"}).json()["entries"]
    assert len(errors) == 1
    # Tracebacks only for a browser session.
    assert api_client.get("/api/maintenance/logs", params={"tracebacks": "true"}).status_code == 403
    _as(monkeypatch, "session")
    tb = api_client.get("/api/maintenance/logs", params={"tracebacks": "true"}).json()["entries"]
    assert "Traceback" in tb[0]["traceback"]
    assert api_client.get("/api/maintenance/logs", params={"source": "nope"}).status_code == 404


def test_backups_list_and_named_download(
    api_client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    folder = tmp_path / "backups"
    folder.mkdir()
    (folder / "snapshot-20260101-000000.sealed.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("INV_DASHBOARD_BACKUP_DIR", str(folder))

    async def _fresh() -> None:
        return None

    api_client.app.dependency_overrides[security.require_fresh_session] = _fresh  # type: ignore[attr-defined]
    data = api_client.get("/api/maintenance/backups").json()
    assert [s["name"] for s in data["snapshots"]] == ["snapshot-20260101-000000.sealed.json"]
    ok = api_client.get("/api/backup", params={"name": "snapshot-20260101-000000.sealed.json"})
    assert ok.status_code == 200
    assert ok.content == b"{}"
    assert api_client.get("/api/backup", params={"name": "../app.sqlite"}).status_code == 404


def test_system_info(api_client: TestClient) -> None:
    data = api_client.get("/api/system").json()
    assert data["version"]
    assert data["migrations"]["head"]
    assert data["api_token_enabled"] is False


def test_requires_auth(anon_client: TestClient) -> None:
    assert anon_client.get("/api/maintenance/jobs").status_code == 401
    assert anon_client.get("/api/system").status_code == 401
