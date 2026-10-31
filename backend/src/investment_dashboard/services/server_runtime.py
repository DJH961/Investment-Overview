"""v6 server startup/shutdown (owned by task B6).

Contract: ``await startup(app)`` runs the server boot (migrations, integrity
checks; no desktop-only steps) and, when ``settings.scheduler_enabled``, starts
the scheduler task; ``await shutdown(app)`` stops it cleanly. Both must be
idempotent and must not block the event loop (use ``asyncio.to_thread`` for
blocking work).

STUB until B6 lands: no-ops.
"""

from __future__ import annotations

from fastapi import FastAPI


async def startup(app: FastAPI) -> None:
    return None


async def shutdown(app: FastAPI) -> None:
    return None
