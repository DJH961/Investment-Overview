# ruff: noqa: PT018
"""API tests for ``/api/auth`` and the ``authenticate`` guard."""

from __future__ import annotations

import importlib.util
from collections.abc import Iterator
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations
from fastapi import Depends
from fastapi.testclient import TestClient

from investment_dashboard.api.app import create_app
from investment_dashboard.api.deps import require_auth
from investment_dashboard.config import get_settings
from investment_dashboard.db import config_session_scope
from investment_dashboard.models.auth import AuthPasskey
from investment_dashboard.services import auth_service as svc

PASSWORD = "correct horse battery"
ORIGIN = "http://localhost:5173"
TOKEN = "s3cret-token-value-0123456789-abcdefghij"
T0 = datetime(2026, 1, 1, 12, 0, 0)
CRED = {"id": "Y3JlZC0x", "rawId": "Y3JlZC0x", "type": "public-key", "response": {}}


class Clock:
    def __init__(self) -> None:
        self.t = T0

    def __call__(self) -> datetime:
        return self.t

    def advance(self, **kw: float) -> None:
        self.t += timedelta(**kw)


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Clock:
    c = Clock()
    monkeypatch.setattr(svc, "_clock", c)
    return c


@pytest.fixture(autouse=True)
def _reset_state() -> Iterator[None]:
    svc.rate_limiter.reset()
    svc.options_limiter.reset()
    svc.challenges.reset()
    yield
    svc.rate_limiter.reset()
    svc.options_limiter.reset()
    svc.challenges.reset()


@pytest.fixture
def client(api_db: Path, clock: Clock) -> Iterator[TestClient]:
    app = create_app(lifespan=False)

    @app.get("/api/_guarded", dependencies=[Depends(require_auth)])
    def guarded() -> dict[str, bool]:
        return {"ok": True}

    @app.post("/api/_guarded", dependencies=[Depends(require_auth)])
    def guarded_post() -> dict[str, bool]:
        return {"ok": True}

    with TestClient(app, headers={"Origin": ORIGIN}) as c:
        yield c


@pytest.fixture
def with_password(api_db: Path) -> None:
    with config_session_scope() as s:
        svc.set_password(s, PASSWORD)


def _login(c: TestClient, password: str = PASSWORD) -> Any:
    return c.post("/api/auth/login", json={"password": password})


def _other(client: TestClient, **headers: str) -> TestClient:
    """A fresh client (own cookie jar) against the same app."""
    return TestClient(client.app, headers=headers)


def test_login_without_password_is_503(client: TestClient) -> None:
    r = _login(client)
    assert r.status_code == 503
    assert "inv-dashboard-set-password" in r.json()["detail"]
    assert client.get("/api/auth/me").json() == {"authenticated": False, "passkeys": None}


def test_login_ok_sets_cookie_and_guards(client: TestClient, with_password: None) -> None:
    assert client.get("/api/_guarded").status_code == 401
    r = _login(client)
    assert r.status_code == 204
    cookie = r.headers["set-cookie"].lower()
    assert cookie.startswith("session=")  # cookie_secure=false in tests
    assert "httponly" in cookie and "samesite=strict" in cookie and "path=/" in cookie
    assert "max-age=" in cookie
    assert client.get("/api/_guarded").status_code == 200
    assert client.get("/api/auth/me").json()["authenticated"] is True


def test_secure_cookie_name_and_flag(
    client: TestClient, with_password: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("INV_DASHBOARD_COOKIE_SECURE", "true")
    get_settings.cache_clear()
    cookie = _login(client).headers["set-cookie"]
    assert cookie.startswith("__Host-session=")
    assert "Secure" in cookie


def test_wrong_password_401_same_message(client: TestClient, with_password: None) -> None:
    r = _login(client, "wrong password here")
    assert r.status_code == 401
    assert r.json()["detail"] == "Invalid credentials."
    assert "set-cookie" not in r.headers


def test_rate_limit_429(client: TestClient, with_password: None) -> None:
    for _ in range(get_settings().login_rate_limit_per_minute):
        assert _login(client, "wrong password here").status_code == 401
    r = _login(client)  # even the right password is refused now
    assert r.status_code == 429
    assert int(r.headers["Retry-After"]) >= 1


def test_rate_limit_expires(client: TestClient, with_password: None, clock: Clock) -> None:
    for _ in range(get_settings().login_rate_limit_per_minute):
        _login(client, "wrong password here")
    clock.advance(seconds=61)
    assert _login(client).status_code == 204


def test_login_requires_json_and_origin(client: TestClient, with_password: None) -> None:
    r = client.post(
        "/api/auth/login",
        content=f'{{"password": "{PASSWORD}"}}',
        headers={"Content-Type": "text/plain"},
    )
    assert r.status_code == 415
    evil = {"Origin": "https://evil.example"}
    assert (
        client.post("/api/auth/login", json={"password": PASSWORD}, headers=evil).status_code == 403
    )
    no_origin = _other(client)
    assert no_origin.post("/api/auth/login", json={"password": PASSWORD}).status_code == 403


def test_idle_expiry(client: TestClient, with_password: None, clock: Clock) -> None:
    _login(client)
    clock.advance(minutes=20)
    assert client.get("/api/_guarded").status_code == 200  # slides
    clock.advance(minutes=20)
    assert client.get("/api/_guarded").status_code == 200
    clock.advance(minutes=31)
    assert client.get("/api/_guarded").status_code == 401


def test_absolute_expiry(client: TestClient, with_password: None, clock: Clock) -> None:
    _login(client)
    days = get_settings().session_max_age_days
    last_ok = T0
    while clock.t < T0 + timedelta(days=days + 1):
        clock.advance(minutes=20)
        if client.get("/api/_guarded").status_code != 200:
            break
        last_ok = clock.t
    else:
        pytest.fail("session should have hit the absolute limit")
    assert T0 + timedelta(days=days) - timedelta(minutes=20) <= last_ok < T0 + timedelta(days=days)


def test_logout_deletes_session(client: TestClient, with_password: None) -> None:
    _login(client)
    token = client.cookies.get("session")
    assert token
    assert client.post("/api/auth/logout").status_code == 204
    replay = _other(client)
    replay.cookies.set("session", token)
    assert replay.get("/api/_guarded").status_code == 401


def test_session_rotated_on_login(client: TestClient, with_password: None) -> None:
    _login(client)
    first = client.cookies.get("session")
    _login(client)
    second = client.cookies.get("session")
    assert first and second and first != second
    stale = _other(client, Origin=ORIGIN)
    stale.cookies.set("session", first)
    assert stale.get("/api/_guarded").status_code == 401


def test_cookie_post_origin_check(client: TestClient, with_password: None) -> None:
    _login(client)
    assert client.post("/api/_guarded").status_code == 200
    evil = {"Origin": "https://evil.example"}
    assert client.post("/api/_guarded", headers=evil).status_code == 403
    c2 = _other(client)
    c2.cookies.set("session", client.cookies.get("session") or "")
    assert c2.post("/api/_guarded").status_code == 403  # missing Origin
    assert c2.get("/api/_guarded").status_code == 200  # safe method unaffected


def test_bearer_token(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    # No token configured: a bearer header opens nothing.
    assert client.get("/api/_guarded", headers={"Authorization": "Bearer x"}).status_code == 401
    monkeypatch.setenv("INV_DASHBOARD_API_TOKEN", TOKEN)
    get_settings.cache_clear()
    bare = _other(client)
    assert bare.get("/api/_guarded").status_code == 401
    assert bare.get("/api/_guarded", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert (
        bare.get("/api/_guarded", headers={"Authorization": f"Bearer {TOKEN}"}).status_code == 200
    )
    assert bare.get("/api/_guarded", headers={"X-API-Token": TOKEN}).status_code == 200
    # token requests need no Origin even for unsafe methods
    assert bare.post("/api/_guarded", headers={"X-API-Token": TOKEN}).status_code == 200


def test_me_public_never_401(client: TestClient) -> None:
    assert client.get("/api/auth/me").status_code == 200


# ------------------------------------------------------------------ passkeys


def _fake_registration(monkeypatch: pytest.MonkeyPatch, seen: dict[str, Any]) -> None:
    def fake(**kw: Any) -> Any:
        seen.update(kw)
        return SimpleNamespace(credential_id=b"cred-1", credential_public_key=b"pub", sign_count=0)

    monkeypatch.setattr(svc, "verify_registration_response", fake)


def _register(client: TestClient, name: str = "Laptop") -> tuple[Any, Any]:
    opts = client.post("/api/auth/passkey/register/options", json={"name": name})
    assert opts.status_code == 200
    verify = client.post(
        "/api/auth/passkey/register/verify",
        json={**CRED, "response": {"transports": ["internal"]}, "name": name},
    )
    return opts, verify


def test_passkey_routes_require_auth(client: TestClient) -> None:
    assert client.post("/api/auth/passkey/register/options").status_code == 401
    assert client.post("/api/auth/passkey/register/verify", json={}).status_code == 401
    assert client.get("/api/auth/passkeys").status_code == 401
    assert client.delete("/api/auth/passkeys/1").status_code == 401


def test_passkey_register_list_login_delete(
    client: TestClient, with_password: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    _login(client)
    seen: dict[str, Any] = {}
    _fake_registration(monkeypatch, seen)
    opts, verify = _register(client)
    body = opts.json()
    assert body["rp"]["id"] == "localhost"
    assert body["authenticatorSelection"]["userVerification"] == "required"
    assert verify.status_code == 204
    assert seen["expected_origin"] == ORIGIN and seen["expected_rp_id"] == "localhost"
    assert isinstance(seen["expected_challenge"], bytes)
    assert seen["require_user_verification"] is True

    listing = client.get("/api/auth/passkeys").json()
    assert len(listing) == 1 and listing[0]["name"] == "Laptop"
    assert client.get("/api/auth/me").json()["passkeys"] == 1

    # challenge is single-use
    again = client.post("/api/auth/passkey/register/verify", json={"id": "x", "rawId": "x"})
    assert again.status_code == 400

    # passkey login from a fresh anonymous client
    anon = _other(client, Origin=ORIGIN)
    lo = anon.post("/api/auth/passkey/login/options")
    assert lo.status_code == 200 and "challenge" in lo.json()
    assert lo.json()["userVerification"] == "required"
    assert anon.get("/api/auth/me").json() == {"authenticated": False, "passkeys": None}

    def fake_auth(**kw: Any) -> Any:
        assert kw["require_user_verification"] is True
        return SimpleNamespace(new_sign_count=7)

    monkeypatch.setattr(svc, "verify_authentication_response", fake_auth)
    r = anon.post("/api/auth/passkey/login/verify", json=CRED)
    assert r.status_code == 204 and "session=" in r.headers["set-cookie"]
    assert anon.get("/api/_guarded").status_code == 200
    with config_session_scope() as s:
        row = s.query(AuthPasskey).one()
        assert row.sign_count == 7 and row.last_used_at is not None
    # replaying the verify fails: challenge consumed
    assert anon.post("/api/auth/passkey/login/verify", json=CRED).status_code == 401

    pid = listing[0]["id"]
    assert client.delete(f"/api/auth/passkeys/{pid}").status_code == 204
    assert client.delete(f"/api/auth/passkeys/{pid}").status_code == 404


def test_passkey_login_failures(
    client: TestClient, with_password: None, monkeypatch: pytest.MonkeyPatch, clock: Clock
) -> None:
    _login(client)
    _fake_registration(monkeypatch, {})
    _register(client)
    anon = _other(client, Origin=ORIGIN)
    # no challenge
    assert anon.post("/api/auth/passkey/login/verify", json=CRED).status_code == 401
    # invalid assertion
    anon.post("/api/auth/passkey/login/options")

    def boom(**kw: Any) -> Any:
        raise ValueError("bad sig")

    monkeypatch.setattr(svc, "verify_authentication_response", boom)
    assert anon.post("/api/auth/passkey/login/verify", json=CRED).status_code == 401
    # unknown credential
    anon.post("/api/auth/passkey/login/options")
    unknown = {**CRED, "id": "b3RoZXI", "rawId": "b3RoZXI"}
    assert anon.post("/api/auth/passkey/login/verify", json=unknown).status_code == 401
    # expired challenge
    anon.post("/api/auth/passkey/login/options")
    clock.advance(seconds=svc.CHALLENGE_TTL_SECONDS + 1)
    svc.rate_limiter.reset()
    svc.options_limiter.reset()
    assert anon.post("/api/auth/passkey/login/verify", json=CRED).status_code == 401
    assert anon.get("/api/_guarded").status_code == 401


def test_passkey_login_rate_limited(client: TestClient) -> None:
    anon = _other(client, Origin=ORIGIN)
    for _ in range(get_settings().login_rate_limit_per_minute):
        assert anon.post("/api/auth/passkey/login/verify", json=CRED).status_code == 401
    assert anon.post("/api/auth/passkey/login/verify", json=CRED).status_code == 429


def test_passkey_login_options_rate_limited(client: TestClient) -> None:
    anon = _other(client, Origin=ORIGIN)
    limit = max(get_settings().login_rate_limit_per_minute * 6, 30)
    for _ in range(limit):
        assert anon.post("/api/auth/passkey/login/options").status_code == 200
    r = anon.post("/api/auth/passkey/login/options")
    assert r.status_code == 429 and int(r.headers["Retry-After"]) >= 1


def test_global_cap_does_not_lock_out_session_owner(
    client: TestClient, with_password: None
) -> None:
    _login(client)
    for i in range(200):  # exhaust the global failure budget from many IPs
        svc.rate_limiter.record_failure(f"ip{i}")
    assert (
        _other(client, Origin=ORIGIN)
        .post("/api/auth/login", json={"password": PASSWORD})
        .status_code
        == 429
    )
    assert _login(client).status_code == 204  # valid session cookie bypasses the global cap


def test_bearer_failures_are_rate_limited(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("INV_DASHBOARD_API_TOKEN", TOKEN)
    get_settings.cache_clear()
    bare = _other(client)
    bad = {"Authorization": "Bearer wrong"}
    for _ in range(get_settings().login_rate_limit_per_minute):
        assert bare.get("/api/_guarded", headers=bad).status_code == 401
    assert bare.get("/api/_guarded", headers=bad).status_code == 429
    assert bare.get("/api/_guarded", headers={"X-API-Token": TOKEN}).status_code == 429


def test_me_hides_passkey_count_when_anonymous(client: TestClient, with_password: None) -> None:
    assert client.get("/api/auth/me").json()["passkeys"] is None
    _login(client)
    assert client.get("/api/auth/me").json() == {"authenticated": True, "passkeys": 0}


def test_short_api_token_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    from pydantic import ValidationError

    from investment_dashboard.config import Settings

    with pytest.raises(ValidationError):
        Settings(api_token="too-short")
    assert Settings(api_token=TOKEN).api_token == TOKEN


# ------------------------------------------------------------------ migration


def test_migration_0016_upgrade_downgrade(tmp_path: Path) -> None:
    path = Path(__file__).parents[2] / "migrations" / "versions" / "0016_v6_auth.py"
    spec = importlib.util.spec_from_file_location("m0016", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.revision == "e3b7c5d9f2a1" and mod.down_revision == "d2a6b4c8e1f0"

    engine = sa.create_engine(f"sqlite:///{tmp_path / 'm.sqlite'}")
    names = {"auth_credential", "auth_passkeys", "auth_sessions"}
    with engine.begin() as conn, Operations.context(MigrationContext.configure(conn)):
        mod.upgrade()
        mod.upgrade()  # idempotent
        assert names <= set(sa.inspect(conn).get_table_names())
        mod.downgrade()
        assert not names & set(sa.inspect(conn).get_table_names())
        mod.downgrade()  # idempotent
    engine.dispose()
