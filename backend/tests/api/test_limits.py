# ruff: noqa: PT018
"""Request guard (auth before body, body caps) and server-mode config checks."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.api import app as app_module
from investment_dashboard.api import limits, security
from investment_dashboard.api.app import create_app
from investment_dashboard.config import (
    ServerConfigError,
    Settings,
    get_settings,
    server_config_problems,
    validate_server_config,
)
from investment_dashboard.db import config_session_scope
from investment_dashboard.services import auth_service

ORIGIN = "http://localhost:5173"
PASSWORD = "correct horse battery"
BIG = 18 * 1024 * 1024


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture(autouse=True)
def _reset() -> Iterator[None]:
    auth_service.reset_limiters()
    yield
    auth_service.reset_limiters()


async def _call(
    app: Any, method: str, path: str, headers: list[tuple[bytes, bytes]], body_chunks: list[bytes]
) -> tuple[int, int]:
    """Drive the ASGI app directly; returns (status, number of body reads)."""
    reads = 0
    chunks = list(body_chunks)

    async def receive() -> dict[str, Any]:
        nonlocal reads
        if not chunks:
            await asyncio.sleep(0)
            return {"type": "http.disconnect"}
        reads += 1
        chunk = chunks.pop(0)
        return {"type": "http.request", "body": chunk, "more_body": bool(chunks)}

    status: list[int] = []

    async def send(message: dict[str, Any]) -> None:
        if message["type"] == "http.response.start":
            status.append(message["status"])

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": headers,
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
        "state": {},
    }
    await app(scope, receive, send)
    return status[0], reads


@pytest.mark.anyio
async def test_unauthenticated_large_post_is_rejected_unread(api_db: Path) -> None:
    app = create_app(lifespan=False)
    headers = [(b"content-type", b"application/json"), (b"content-length", str(BIG).encode())]
    status, reads = await _call(app, "POST", "/api/transactions", headers, [b"x" * 1024])
    assert status == 413 and reads == 0


@pytest.mark.anyio
async def test_unauthenticated_post_gets_401_before_the_body_is_read(api_db: Path) -> None:
    app = create_app(lifespan=False)
    headers = [(b"content-type", b"application/json"), (b"content-length", b"2")]
    status, reads = await _call(app, "POST", "/api/transactions", headers, [b"{}"])
    assert status == 401 and reads == 0
    # Chunked (no Content-Length) multipart upload: also never read.
    headers = [(b"content-type", b"multipart/form-data; boundary=x")]
    status, reads = await _call(app, "POST", "/api/imports", headers, [b"a" * 4096] * 4)
    assert status == 401 and reads == 0


@pytest.mark.anyio
async def test_streamed_body_over_the_cap_is_413(api_db: Path) -> None:
    app = create_app(lifespan=False)
    app.dependency_overrides[app_module.require_auth] = _allow
    headers = [(b"content-type", b"application/json")]  # no Content-Length
    chunk = b" " * 16 * 1024
    status, reads = await _call(app, "POST", "/api/transactions", headers, [chunk] * 10)
    assert status == 413
    assert reads <= get_settings().max_body_bytes // len(chunk) + 1


async def _allow() -> None:
    return None


def test_body_limits_per_route(api_db: Path) -> None:
    s = get_settings()
    assert limits.body_limit("POST", "/api/imports", s) == s.max_upload_body_bytes
    assert limits.body_limit("POST", "/api/imports/", s) == s.max_upload_body_bytes
    assert limits.body_limit("POST", "/api/imports/abc/confirm", s) == s.max_body_bytes
    assert limits.body_limit("PUT", "/api/settings", s) == s.max_body_bytes
    assert s.max_body_bytes == 64 * 1024
    assert s.max_upload_body_bytes == 11 * 1024 * 1024


def test_guarded_paths() -> None:
    assert limits.is_guarded("/api/transactions")
    assert limits.is_guarded("/api")
    assert limits.is_guarded("/api/does-not-exist")
    assert not limits.is_guarded("/api/health")
    assert not limits.is_guarded("/api/auth/login")
    assert limits.is_guarded("/api/authx")  # only whole path segments are public
    assert not limits.is_guarded("/overview")
    assert not limits.is_guarded("/apix")


def test_public_auth_route_body_is_capped(anon_client: TestClient) -> None:
    big = {"password": "x" * (get_settings().max_body_bytes + 10)}
    resp = anon_client.post("/api/auth/login", json=big, headers={"Origin": ORIGIN})
    assert resp.status_code == 413
    assert resp.headers["X-Content-Type-Options"] == "nosniff"  # headers still applied


def test_upload_under_the_upload_cap_passes_the_guard(api_client: TestClient) -> None:
    # Bigger than the default cap, far below the upload cap: reaches the route.
    payload = b"a" * (get_settings().max_body_bytes * 2)
    resp = api_client.post("/api/imports", files={"file": ("x.csv", payload, "text/csv")})
    assert resp.status_code != 413


def test_guard_principal_is_reused(
    anon_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    with config_session_scope() as s:
        auth_service.set_password(s, PASSWORD)
    anon_client.headers["Origin"] = ORIGIN
    assert anon_client.post("/api/auth/login", json={"password": PASSWORD}).status_code == 204
    calls = 0
    real = security._session_lookup

    def counting(token: str, settings: Settings, slide: bool = True) -> str | None:
        nonlocal calls
        calls += 1
        return real(token, settings, slide)

    monkeypatch.setattr(security, "_session_lookup", counting)
    assert anon_client.get("/api/refresh/status").status_code == 200
    assert calls == 1


def test_bad_token_failures_do_not_use_the_password_budget(
    anon_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("INV_DASHBOARD_API_TOKEN", "t" * 40)
    get_settings.cache_clear()
    for _ in range(get_settings().login_rate_limit_per_minute + 1):
        anon_client.get("/api/refresh/status", headers={"Authorization": "Bearer nope"})
    with config_session_scope() as s:
        auth_service.set_password(s, PASSWORD)
    login = anon_client.post(
        "/api/auth/login", json={"password": PASSWORD}, headers={"Origin": ORIGIN}
    )
    assert login.status_code == 204


# ------------------------------------------------------------------ server config


_GOOD = {
    "server_mode": True,
    "webauthn_origin": "https://money.example.org",
    "webauthn_rp_id": "money.example.org",
    "cookie_secure": True,
    "db_passphrase": "a-long-enough-passphrase-0123",
}


def _settings(**overrides: Any) -> Settings:
    return Settings(**{**_GOOD, **overrides})


def test_good_server_config_passes() -> None:
    assert server_config_problems(_settings(), env={}) == []
    assert server_config_problems(_settings(webauthn_rp_id="example.org"), env={}) == []


@pytest.mark.parametrize(
    ("overrides", "env", "needle"),
    [
        ({"cookie_secure": False}, {}, "cookie_secure"),
        ({"webauthn_origin": "http://money.example.org"}, {}, "https"),
        ({"webauthn_rp_id": "other.example.org"}, {}, "webauthn_rp_id"),
        ({"dev_cors_origins": ["https://x.example"]}, {}, "dev_cors_origins"),
        ({"db_passphrase": "changeme"}, {}, "placeholder"),
        ({"db_passphrase": "short-pass"}, {}, "at least"),
        ({}, {"INV_DASHBOARD_BACKUP_PASSPHRASE": "changeme-too"}, "BACKUP_PASSPHRASE"),
    ],
)
def test_unsafe_server_config_refuses_boot(
    overrides: dict[str, Any], env: dict[str, str], needle: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    problems = server_config_problems(_settings(**overrides), env=env)
    assert any(needle in p for p in problems), problems
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    with pytest.raises(ServerConfigError):
        validate_server_config(_settings(**overrides))


def test_loopback_dev_server_is_allowed() -> None:
    # CI smoke / e2e runs: plain http on loopback, insecure cookie.
    dev = _settings(
        webauthn_origin="http://127.0.0.1:5173", webauthn_rp_id="localhost", cookie_secure=False
    )
    assert server_config_problems(dev, env={}) == []
    # A weak passphrase is refused even there.
    weak = _settings(webauthn_origin="http://localhost:5173", db_passphrase="pw")
    assert server_config_problems(weak, env={})


def test_desktop_mode_is_not_validated() -> None:
    validate_server_config(_settings(server_mode=False, cookie_secure=False))


def test_run_validates_and_passes_proxy_and_concurrency_settings(
    api_db: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import uvicorn

    seen: dict[str, Any] = {}
    monkeypatch.setattr(uvicorn, "run", lambda app, **kw: seen.update(kw))
    monkeypatch.setattr("investment_dashboard.logging.configure_logging", lambda: None)
    monkeypatch.setenv("INV_DASHBOARD_FORWARDED_ALLOW_IPS", "10.0.0.0/8")
    monkeypatch.setenv("INV_DASHBOARD_LIMIT_CONCURRENCY", "32")
    get_settings.cache_clear()
    app_module.run()
    assert seen["forwarded_allow_ips"] == "10.0.0.0/8"
    assert seen["limit_concurrency"] == 32
    assert seen["proxy_headers"] is True

    seen.clear()
    monkeypatch.setenv("INV_DASHBOARD_WEBAUTHN_ORIGIN", "https://money.example.org")
    get_settings.cache_clear()
    with pytest.raises(ServerConfigError):
        app_module.run()
    assert seen == {}


def test_forwarded_allow_ips_default_is_not_wildcard() -> None:
    assert Settings().forwarded_allow_ips != "*"


def test_run_passes_trusted_proxy_setting_to_uvicorn(monkeypatch: pytest.MonkeyPatch) -> None:
    import sys
    import types

    from investment_dashboard.api import app as app_module

    captured: dict[str, object] = {}
    fake = types.SimpleNamespace(run=lambda _app, **kw: captured.update(kw))
    monkeypatch.setitem(sys.modules, "uvicorn", fake)
    monkeypatch.setattr("investment_dashboard.logging.configure_logging", lambda *a, **k: None)
    monkeypatch.setattr(app_module, "create_app", object)
    monkeypatch.setattr(
        app_module, "get_settings", lambda: _settings(forwarded_allow_ips="172.29.40.2")
    )
    app_module.run()
    assert captured["proxy_headers"] is True
    assert captured["forwarded_allow_ips"] == "172.29.40.2"
