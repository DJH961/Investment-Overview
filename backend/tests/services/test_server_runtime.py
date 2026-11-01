from __future__ import annotations

import asyncio
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi import FastAPI

from investment_dashboard import boot
from investment_dashboard.config import get_settings
from investment_dashboard.services import scheduler, server_runtime

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
def jobs(monkeypatch: pytest.MonkeyPatch) -> Iterator[dict[str, int]]:
    counts = {"boot": 0, "run": 0}

    def fake_boot() -> None:
        counts["boot"] += 1

    monkeypatch.setattr(boot, "run_server_boot_sequence", fake_boot)

    async def fake_run(self: Any) -> None:
        counts["run"] += 1
        await asyncio.Event().wait()

    monkeypatch.setattr(scheduler.Scheduler, "run", fake_run)
    yield counts
    get_settings.cache_clear()


def _settings(monkeypatch: pytest.MonkeyPatch, *, server: bool, sched: bool) -> None:
    monkeypatch.setenv("INV_DASHBOARD_SERVER_MODE", str(server).lower())
    monkeypatch.setenv("INV_DASHBOARD_SCHEDULER_ENABLED", str(sched).lower())
    get_settings.cache_clear()


async def test_startup_shutdown_idempotent_with_scheduler(
    monkeypatch: pytest.MonkeyPatch, jobs: dict[str, int]
) -> None:
    _settings(monkeypatch, server=True, sched=True)
    app = FastAPI()
    await server_runtime.startup(app)
    await server_runtime.startup(app)
    await asyncio.sleep(0)
    assert jobs == {"boot": 1, "run": 1}
    task = app.state.scheduler_task
    assert not task.done()
    await server_runtime.shutdown(app)
    await server_runtime.shutdown(app)
    assert task.done()


async def test_scheduler_off_and_server_mode_off(
    monkeypatch: pytest.MonkeyPatch, jobs: dict[str, int]
) -> None:
    _settings(monkeypatch, server=False, sched=False)
    app = FastAPI()
    await server_runtime.startup(app)
    assert jobs == {"boot": 0, "run": 0}
    assert getattr(app.state, "scheduler_task", None) is None
    await server_runtime.shutdown(app)
