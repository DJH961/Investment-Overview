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
    assert {
        "prices.refresh",
        "fx.refresh_live",
        "fx.backfill_intraday",
        "cache.reset",
        "backup.now",
    } <= ids
    reset = next(j for j in data["jobs"] if j["id"] == "cache.reset")
    assert reset["danger"] == "typed"
    assert reset["confirm_word"] == "RESET"


def test_fx_refresh_live_job_backfills_live_spot(
    api_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from datetime import UTC, date, datetime
    from decimal import Decimal

    from investment_dashboard.services import fx_service

    _as(monkeypatch, "session")

    def fake_backfill(_session: object) -> Decimal:
        fx_service.set_live_spot(
            "USD",
            Decimal("1.1640"),
            observed_on=date(2026, 11, 6),
            observed_at=datetime(2026, 11, 6, 22, 0, tzinfo=UTC),
        )
        return Decimal("1.1640")

    monkeypatch.setattr(fx_service, "backfill_live_spot", fake_backfill)
    monkeypatch.setattr(
        fx_service,
        "eur_quote_as_of",
        lambda _s: fx_service.FxAsOf(
            as_of=date(2026, 11, 6),
            source="live",
            observed_at=datetime(2026, 11, 6, 22, 0, tzinfo=UTC),
        ),
    )
    run = api_client.post("/api/maintenance/jobs/fx.refresh_live", json={})
    assert run.status_code == 202, run.text
    done = _wait(api_client, run.json()["id"])
    assert done["status"] == "succeeded"
    assert done["result"]["rate"] == "1.1640"
    assert done["result"]["source"] == "live"
    fx_service.clear_live_spot()


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


# -- ETF twins: repair jobs + health endpoint ---------------------------------------


def test_twins_refresh_job_wraps_refresh_twin_prices(
    api_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from investment_dashboard.services import intraday_snapshots_service as iss

    _as(monkeypatch, "session")
    monkeypatch.setattr(iss, "refresh_twin_prices", lambda session: 7)
    run = api_client.post("/api/maintenance/jobs/twins.refresh", json={})
    assert run.status_code == 202, run.text
    done = _wait(api_client, run.json()["id"])
    assert done["status"] == "succeeded"
    assert done["result"] == {"rows_written": 7}


def test_twins_backfill_job_forces_the_year_backfill(
    api_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from investment_dashboard.services import intraday_snapshots_service as iss

    _as(monkeypatch, "session")
    monkeypatch.setattr(
        iss, "force_twin_year_backfill", lambda session: {"twins": ["TWN"], "written": 5}
    )
    run = api_client.post("/api/maintenance/jobs/twins.backfill", json={})
    assert run.status_code == 202, run.text
    done = _wait(api_client, run.json()["id"])
    assert done["status"] == "succeeded"
    assert done["result"] == {"twins": ["TWN"], "written": 5}


def test_twins_clear_job_needs_confirm_and_deletes_every_stored_row(
    api_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from datetime import datetime
    from decimal import Decimal

    from investment_dashboard.db import cache_write_session, ledger_session_scope
    from investment_dashboard.repositories import twin_prices_repo

    _as(monkeypatch, "session")
    with ledger_session_scope() as s, cache_write_session(s) as cache:
        twin_prices_repo.upsert_prices(
            cache,
            "TWN",
            {
                datetime(2024, 5, 31, 20, 0): Decimal("100"),
                datetime(2024, 6, 3, 20, 0): Decimal("105"),
            },
        )
    # No confirmation: the server refuses before running anything.
    no_confirm = api_client.post("/api/maintenance/jobs/twins.clear", json={})
    assert no_confirm.status_code == 422
    run = api_client.post("/api/maintenance/jobs/twins.clear", json={"confirm": "yes"})
    assert run.status_code == 202, run.text
    done = _wait(api_client, run.json()["id"])
    assert done["status"] == "succeeded"
    assert done["result"] == {"deleted": 2}
    with ledger_session_scope() as s:
        from investment_dashboard.db import cache_read_session

        with cache_read_session(s) as cache:
            left = twin_prices_repo.prices_in_range(
                cache, ["TWN"], datetime(2020, 1, 1), datetime(2030, 1, 1)
            )
    assert left == {"TWN": {}}


def test_twin_health_endpoint_shape(
    api_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from investment_dashboard.db import ledger_session_scope
    from investment_dashboard.repositories import instrument_overrides_repo

    _as(monkeypatch, "session")
    with ledger_session_scope() as s:
        fund = Instrument(
            symbol="EURFUND", name="Euro Fund", asset_class="mutual_fund", native_currency="EUR"
        )
        s.add(fund)
        s.flush()
        instrument_overrides_repo.upsert(s, fund.id, intraday_twin="TWN")
        fund_id = fund.id

    resp = api_client.get("/api/maintenance/twins")
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert set(data) == {"enabled", "window", "funds"}
    assert data["enabled"] is True
    assert data["window"] == 20
    assert len(data["funds"]) == 1
    entry = data["funds"][0]
    assert entry["instrument_id"] == fund_id
    assert entry["symbol"] == "EURFUND"
    assert entry["name"] == "Euro Fund"
    assert entry["twin_symbol"] == "TWN"
    assert entry["estimating"] is False  # not held: nothing to estimate
    assert entry["stored_sessions"] == 0
    assert entry["first_session"] is None
    assert entry["last_session"] is None
    assert entry["last_price_at"] is None
    assert entry["year_backfill_done"] is False
    assert entry["divergence"] is None


def test_twin_health_requires_auth(anon_client: TestClient) -> None:
    assert anon_client.get("/api/maintenance/twins").status_code == 401


def test_twin_health_reports_estimating_and_divergence(api_db: Path) -> None:
    """A held, currently-estimating fund with real divergence history.

    Calls the service directly (not over HTTP): the health page always reads
    *now*, so a fixture dated in the past needs an explicit ``now`` to land
    inside the twin-price retention window, which only the service call
    accepts (the router, correctly, never takes a caller-supplied "now").
    """
    from datetime import UTC, date, datetime
    from decimal import Decimal

    from investment_dashboard.db import cache_write_session, ledger_session_scope
    from investment_dashboard.models import Transaction
    from investment_dashboard.models.transaction import TransactionSource
    from investment_dashboard.repositories import (
        accounts_repo,
        fx_repo,
        instrument_overrides_repo,
        prices_repo,
        twin_prices_repo,
    )
    from investment_dashboard.services import twin_health_service

    thu, fri, mon = date(2024, 5, 30), date(2024, 5, 31), date(2024, 6, 3)
    with ledger_session_scope() as s:
        acct = accounts_repo.create_account(
            s,
            broker="fidelity",
            account_label="Main",
            native_currency="USD",
            account_type="brokerage",
        )
        fund = Instrument(
            symbol="FUNDX", name="Fund X", asset_class="mutual_fund", native_currency="USD"
        )
        s.add(fund)
        s.flush()
        fund_id = fund.id
        instrument_overrides_repo.upsert(s, fund_id, intraday_twin="TWN")
        prices_repo.upsert_closes(s, fund_id, {thu: Decimal("190"), fri: Decimal("200")})
        fx_repo.upsert_rates(s, {thu: Decimal("1.10"), fri: Decimal("1.10"), mon: Decimal("1.10")})
        s.add(
            Transaction(
                account_id=acct.id,
                date=fri,
                kind="buy",
                source=TransactionSource.MANUAL,
                instrument_id=fund_id,
                quantity=Decimal("10"),
                price_native=Decimal("200"),
                net_native=Decimal("-2000"),
                net_usd=Decimal("-2000"),
                net_eur=Decimal("-1818.18"),
            )
        )
        s.flush()
        with cache_write_session(s) as cache:
            twin_prices_repo.upsert_prices(
                cache,
                "TWN",
                {
                    datetime(2024, 5, 30, 20, 0): Decimal("100"),
                    datetime(2024, 5, 31, 20, 0): Decimal("105"),
                    datetime(2024, 6, 3, 13, 30): Decimal("105"),
                },
            )

    data = twin_health_service.health(now=datetime(2024, 6, 3, 22, 0, tzinfo=UTC))
    entry = next(f for f in data["funds"] if f["symbol"] == "FUNDX")
    assert entry["estimating"] is True  # held, NAV not posted, twin has data
    assert entry["stored_sessions"] == 2
    assert entry["first_session"] == thu.isoformat()
    assert entry["last_session"] == fri.isoformat()
    assert entry["last_price_at"] is not None
    assert entry["year_backfill_done"] is False
    div = entry["divergence"]
    assert div is not None
    assert div["last_date"] == fri.isoformat()
    assert Decimal(div["last_gap_pp"]) < 0  # twin ran 0.26 pp behind
