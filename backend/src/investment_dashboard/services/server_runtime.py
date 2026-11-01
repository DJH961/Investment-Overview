"""v6 server startup/shutdown.

``await startup(app)`` runs the server boot (migrations, integrity checks; no
desktop-only steps) when ``settings.server_mode`` is on and, when
``settings.scheduler_enabled``, starts the scheduler task. ``await
shutdown(app)`` cancels and awaits it. Both are idempotent and keep blocking
work off the event loop.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging

from fastapi import FastAPI

from investment_dashboard.config import get_settings

log = logging.getLogger(__name__)


def _boot_server() -> None:
    from investment_dashboard import boot  # noqa: PLC0415

    boot.run_server_boot_sequence()


async def startup(app: FastAPI) -> None:
    state = app.state
    if getattr(state, "server_runtime_started", False):
        return
    settings = get_settings()
    if settings.server_mode:
        await asyncio.to_thread(_boot_server)
    if settings.scheduler_enabled:
        from investment_dashboard.services.scheduler import Scheduler  # noqa: PLC0415

        scheduler = Scheduler()
        state.scheduler = scheduler
        state.scheduler_task = asyncio.create_task(scheduler.run(), name="inv-scheduler")
    state.server_runtime_started = True


async def shutdown(app: FastAPI) -> None:
    state = app.state
    task = getattr(state, "scheduler_task", None)
    state.scheduler_task = None
    state.server_runtime_started = False
    if task is not None:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task
