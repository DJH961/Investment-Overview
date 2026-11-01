"""SSE stream tests.

Starlette's ``TestClient`` buffers a response until the app finishes, which an
endless event stream never does; so the stream body is driven directly through
the route function with a minimal ASGI ``Request``.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from fastapi import Request
from fastapi.testclient import TestClient

from investment_dashboard.api import security, stream
from investment_dashboard.services import live_bus

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def _request() -> Request:
    async def receive() -> dict[str, Any]:
        await asyncio.Event().wait()
        return {}

    scope = {"type": "http", "method": "GET", "path": "/api/stream", "headers": []}
    return Request(scope, receive)


def _data(chunk: str) -> dict[str, Any]:
    assert chunk.startswith("data: ")
    return json.loads(chunk[6:])  # type: ignore[no-any-return]


@pytest.fixture
def authed(monkeypatch: pytest.MonkeyPatch) -> dict[str, bool]:
    state = {"valid": True}

    async def fake_still_authenticated(request: object) -> bool:
        return state["valid"]

    monkeypatch.setattr(security, "still_authenticated", fake_still_authenticated)
    return state


async def test_stream_headers_hello_event_and_disconnect(authed: dict[str, bool]) -> None:
    resp = await stream.stream(_request())
    assert resp.media_type == "text/event-stream"
    assert resp.headers["cache-control"] == "no-cache"
    assert resp.headers["x-accel-buffering"] == "no"
    body: Any = resp.body_iterator
    hello = _data(await anext(body))
    assert hello["type"] == "hello"
    assert hello["market_state"] in {"open", "closed", "holiday"}
    assert live_bus.bus.subscriber_count == 1
    live_bus.bus.publish({"type": "tick", "ts": "t", "market_state": "open"})
    assert _data(await asyncio.wait_for(anext(body), 2))["type"] == "tick"
    await body.aclose()  # client disconnect
    assert live_bus.bus.subscriber_count == 0


async def test_stream_heartbeat(monkeypatch: pytest.MonkeyPatch, authed: dict[str, bool]) -> None:
    monkeypatch.setattr(stream, "HEARTBEAT_SECONDS", 0.05)
    resp = await stream.stream(_request())
    body: Any = resp.body_iterator
    await anext(body)
    assert await asyncio.wait_for(anext(body), 2) == ": heartbeat\n\n"
    await body.aclose()


async def test_stream_ends_when_session_becomes_invalid(
    monkeypatch: pytest.MonkeyPatch, authed: dict[str, bool]
) -> None:
    monkeypatch.setattr(stream, "HEARTBEAT_SECONDS", 0.05)
    resp = await stream.stream(_request())
    body: Any = resp.body_iterator
    await anext(body)
    authed["valid"] = False
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(anext(body), 2)
    assert live_bus.bus.subscriber_count == 0


async def test_stream_revalidates_while_events_flow(
    monkeypatch: pytest.MonkeyPatch, authed: dict[str, bool]
) -> None:
    monkeypatch.setattr(stream, "REVALIDATE_SECONDS", 0.0)
    resp = await stream.stream(_request())
    body: Any = resp.body_iterator
    await anext(body)
    authed["valid"] = False
    live_bus.bus.publish({"type": "tick"})
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(anext(body), 2)


def test_stream_requires_auth(anon_client: TestClient) -> None:
    assert anon_client.get("/api/stream").status_code == 401


def test_stream_in_openapi(api_client: TestClient) -> None:
    spec = api_client.get("/openapi.json").json()
    content = spec["paths"]["/api/stream"]["get"]["responses"]["200"]["content"]
    assert "text/event-stream" in content


async def test_open_stream_is_closed_after_session_idle_timeout(
    api_db: object, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Heartbeat re-checks must not extend the idle timeout (real session, no fakes)."""
    from datetime import datetime, timedelta

    from investment_dashboard.config import get_settings
    from investment_dashboard.db import config_session_scope
    from investment_dashboard.services import auth_service

    t = {"now": datetime(2026, 1, 1, 12, 0, 0)}
    monkeypatch.setattr(auth_service, "_clock", lambda: t["now"])
    settings = get_settings()
    with config_session_scope() as db:
        token = auth_service.create_session(db, settings, None)
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/api/stream",
        "headers": [(b"cookie", f"{security.cookie_name(settings)}={token}".encode())],
    }

    async def receive() -> dict[str, Any]:
        await asyncio.Event().wait()
        return {}

    monkeypatch.setattr(stream, "HEARTBEAT_SECONDS", 0.02)
    resp = await stream.stream(Request(scope, receive))
    body: Any = resp.body_iterator
    await anext(body)  # hello
    t["now"] += timedelta(minutes=settings.session_idle_minutes - 1)
    assert await asyncio.wait_for(anext(body), 2) == ": heartbeat\n\n"
    t["now"] += timedelta(minutes=2)  # idle total > limit; earlier heartbeats must not have slid it
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(anext(body), 2)
    assert live_bus.bus.subscriber_count == 0
