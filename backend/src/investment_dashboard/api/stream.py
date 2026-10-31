"""``GET /api/stream``: server-sent events (hello, tick, refresh, fx)."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from investment_dashboard.api import security
from investment_dashboard.api.schemas.stream import event_schema
from investment_dashboard.services import live_bus

router = APIRouter(tags=["stream"])

#: Seconds between ``: heartbeat`` comments (keeps proxies from closing the stream).
HEARTBEAT_SECONDS = 15.0
#: An open stream re-validates its session at least this often (seconds).
REVALIDATE_SECONDS = 45.0


def format_event(event: live_bus.Event) -> str:
    # Unnamed SSE event: the client listens with ``EventSource.onmessage`` and
    # dispatches on ``data.type``; a named ``event:`` line would bypass it.
    return f"data: {json.dumps(event, separators=(',', ':'))}\n\n"


async def _still_authenticated(request: Request) -> bool:
    try:
        await security.authenticate(request)
    except HTTPException:
        return False
    return True


async def _events(request: Request) -> AsyncIterator[str]:
    last_check = time.monotonic()
    sub = live_bus.bus.subscribe()
    try:
        now = datetime.now(UTC)
        yield format_event(
            {"type": "hello", "ts": now.isoformat(), "market_state": live_bus.market_state(now)}
        )
        while True:
            event: live_bus.Event | None
            try:
                event = await asyncio.wait_for(sub.get(), timeout=HEARTBEAT_SECONDS)
            except TimeoutError:
                event = None
            # Re-validate the session at each heartbeat (and at least every
            # REVALIDATE_SECONDS while events flow): logout/expiry ends the stream.
            if event is None or time.monotonic() - last_check >= REVALIDATE_SECONDS:
                if not await _still_authenticated(request):
                    return
                last_check = time.monotonic()
            if event is None:
                if await request.is_disconnected():
                    return
                yield ": heartbeat\n\n"
                continue
            yield format_event(event)
    finally:
        sub.close()


@router.get(
    "/stream",
    summary="Live event stream (SSE)",
    response_class=StreamingResponse,
    responses={
        200: {
            "description": "text/event-stream; each message is one `data:` JSON event.",
            "content": {"text/event-stream": {"schema": event_schema()}},
        }
    },
)
async def stream(request: Request) -> StreamingResponse:
    return StreamingResponse(
        _events(request),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
