"""Loopback + per-boot token gate of ``POST /api/ops/announce-restart``."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from investment_dashboard.api import ops
from investment_dashboard.services import live_bus, restart_notice

BODY = {"state": "restarting", "version": "abc1234", "eta_s": 20}
URL = "/api/ops/announce-restart"


@pytest.fixture
def token_file(tmp_path: Path) -> Iterator[Path]:
    path = tmp_path / "inv-restart.token"
    restart_notice.configure(path)
    yield path
    restart_notice.configure(None)


def _client(host: str) -> TestClient:
    app = FastAPI()
    app.include_router(ops.announce_router, prefix="/api")
    return TestClient(app, client=(host, 50000))


def test_token_file_is_written(token_file: Path) -> None:
    value = restart_notice.token()
    assert token_file.read_text() == value
    assert restart_notice.token() == value


def test_wrong_host_is_404(token_file: Path) -> None:
    token = restart_notice.token()
    res = _client("10.0.0.5").post(URL, json=BODY, headers={"X-Restart-Token": token})
    assert res.status_code == 404


@pytest.mark.parametrize("header", [None, "nope"])
def test_missing_or_wrong_token_is_404(token_file: Path, header: str | None) -> None:
    headers = {"X-Restart-Token": header} if header else {}
    assert _client("127.0.0.1").post(URL, json=BODY, headers=headers).status_code == 404


def test_success_publishes_event(token_file: Path) -> None:
    token = restart_notice.token()
    seen: list[dict[str, object]] = []
    original = live_bus.bus.publish
    live_bus.bus.publish = seen.append  # type: ignore[method-assign]
    try:
        res = _client("127.0.0.1").post(URL, json=BODY, headers={"X-Restart-Token": token})
    finally:
        live_bus.bus.publish = original  # type: ignore[method-assign]
    assert res.status_code == 202
    assert len(seen) == 1
    event = seen[0]
    assert event["type"] == "server"
    assert event["state"] == "restarting"
    assert event["version"] == "abc1234"
    assert event["eta_s"] == 20
    assert event["reason"] == "deploy"


def test_real_app_mounts_route_past_the_session_guard(token_file: Path) -> None:
    """In the real app: no session needed from loopback+token, outsiders get 404 (not 401)."""
    from investment_dashboard.api.app import create_app

    app = create_app(lifespan=False)
    token = restart_notice.token()
    outside = TestClient(app, client=("203.0.113.9", 50000))
    assert outside.post(URL, json=BODY).status_code == 404
    original = live_bus.bus.publish
    live_bus.bus.publish = lambda _event: None  # type: ignore[method-assign,assignment]
    try:
        inside = TestClient(app, client=("127.0.0.1", 50000))
        res = inside.post(URL, json=BODY, headers={"X-Restart-Token": token})
    finally:
        live_bus.bus.publish = original  # type: ignore[method-assign]
    assert res.status_code == 202
