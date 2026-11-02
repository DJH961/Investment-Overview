"""maintenance_service: catalogue, params, server-side confirmation, backups first."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest

from investment_dashboard.errors import NotFoundError
from investment_dashboard.services import backup_service, job_runner, live_bus
from investment_dashboard.services import maintenance_service as ms


@pytest.fixture(autouse=True)
def _clean(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    job_runner.reset_for_tests()
    monkeypatch.setattr(live_bus.bus, "publish", lambda _e: None)
    monkeypatch.setattr(job_runner, "_store", lambda _r: None)
    yield
    job_runner.reset_for_tests()


def test_catalogue_is_consistent() -> None:
    assert len(ms.BY_ID) == len(ms.JOBS)
    for job in ms.JOBS:
        assert job.group in ms.GROUPS
        assert (job.danger == "typed") == (job.confirm_word is not None)
        if job.backup_first:
            assert job.danger == "typed"
    # Decision: no factory reset / delete-everything in the hosted app.
    assert not any("everything" in j.id or j.id == "reset.transactions" for j in ms.JOBS)


def test_params_are_validated() -> None:
    spec = ms.get_spec("snapshots.rebuild")
    assert ms.validate_params(spec, {"from": "2026-01-02"})["from"].isoformat() == "2026-01-02"
    with pytest.raises(ms.JobParamsError) as err:
        ms.validate_params(spec, {"from": "yesterday", "extra": 1})
    assert set(err.value.errors) == {"from", "extra"}
    assert ms.validate_params(ms.get_spec("graphs.reload"), None) == {"which": "all"}
    with pytest.raises(ms.JobParamsError):
        ms.validate_params(ms.get_spec("prices.redownload"), {})
    with pytest.raises(NotFoundError):
        ms.get_spec("nope")


def test_confirmation_is_enforced() -> None:
    typed = ms.get_spec("cache.reset")
    with pytest.raises(ms.JobParamsError):
        ms.check_confirm(typed, None)
    with pytest.raises(ms.JobParamsError):
        ms.check_confirm(typed, "reset")
    ms.check_confirm(typed, "RESET")
    confirm = ms.get_spec("tiingo.reset_state")
    with pytest.raises(ms.JobParamsError):
        ms.check_confirm(confirm, None)
    ms.check_confirm(confirm, "yes")
    ms.check_confirm(ms.get_spec("cache.janitor"), None)


def test_destructive_job_takes_a_backup_first(monkeypatch: pytest.MonkeyPatch) -> None:
    order: list[str] = []

    class _Path:
        name = "snapshot-20260101-000000.sealed.json"

    monkeypatch.setattr(backup_service, "is_configured", lambda: True)
    monkeypatch.setattr(
        backup_service, "create_snapshot", lambda: order.append("backup") or _Path()
    )

    def fake_reset(_p: dict[str, Any]) -> dict[str, Any]:
        order.append("reset")
        return {"deleted_rows": 3}

    spec = ms.BY_ID["cache.reset"]
    monkeypatch.setitem(ms.BY_ID, "cache.reset", ms.JobSpec(**{**spec.__dict__, "run": fake_reset}))
    run = ms.start_job("cache.reset", {}, confirm="RESET", actor="t", wait=True)
    assert run.status == "succeeded"
    assert order == ["backup", "reset"]
    assert run.result == {"deleted_rows": 3, "backup": _Path.name}


def test_backup_failure_aborts(monkeypatch: pytest.MonkeyPatch) -> None:
    called: list[str] = []
    monkeypatch.setattr(backup_service, "is_configured", lambda: True)

    def broken() -> None:
        raise backup_service.SnapshotError("disk full")

    monkeypatch.setattr(backup_service, "create_snapshot", broken)
    spec = ms.BY_ID["cache.reset"]
    monkeypatch.setitem(
        ms.BY_ID,
        "cache.reset",
        ms.JobSpec(**{**spec.__dict__, "run": lambda _p: called.append("x")}),
    )
    run = ms.start_job("cache.reset", None, confirm="RESET", actor="t", wait=True)
    assert run.status == "failed"
    assert called == []


def test_catalogue_view_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(job_runner, "last_stored_all", lambda _jobs: {})
    view = ms.catalogue()
    job = next(j for j in view["jobs"] if j["id"] == "cache.reset")
    assert job["danger"] == "typed"
    assert job["confirm_word"] == "RESET"
    assert {g["id"] for g in view["groups"]} >= {"prices", "fx"}
