"""Tests for the read-only JSON API.

The API reuses the read-model layer, so these tests focus on routing,
the response shape, and the optional token-auth behaviour rather than
re-checking the financial numbers (covered by the read-model tests).
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from investment_dashboard.api.app import create_app
from investment_dashboard.config import get_settings
from investment_dashboard.models import ALL_METADATAS

_TOKEN = "test-token-value"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    """API client whose endpoints read from a shared in-memory engine.

    FastAPI runs sync route handlers in a worker thread, so the engine
    uses ``StaticPool`` to share a single in-memory connection across
    threads (the default per-thread pool would expose an empty DB).
    """
    eng = create_engine(
        "sqlite://",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )

    @event.listens_for(eng, "connect")
    def _fk_on(dbapi_conn, _record):  # type: ignore[no-untyped-def]
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    for md in ALL_METADATAS:
        md.create_all(eng)
    factory = sessionmaker(bind=eng, autoflush=False, expire_on_commit=False)

    @contextmanager
    def _fake_scope() -> Iterator[Session]:
        s = factory()
        try:
            yield s
            s.commit()
        finally:
            s.close()

    # The route handlers call ``session_scope`` imported into api.app.
    monkeypatch.setattr("investment_dashboard.api.app.session_scope", _fake_scope)
    # A fresh settings object per test so token toggling is isolated.
    get_settings.cache_clear()
    try:
        with TestClient(create_app()) as c:
            yield c
    finally:
        get_settings.cache_clear()
        eng.dispose()


def test_health_is_open(client: TestClient) -> None:
    resp = client.get("/api/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert "schema_version" in body


@pytest.mark.parametrize(
    "path",
    [
        "/api/snapshot",
        "/api/overview",
        "/api/deposits",
        "/api/transactions",
        "/api/monthly",
        "/api/yearly",
        "/api/analytics",
        "/api/calculator",
    ],
)
def test_endpoints_return_json_on_empty_db(client: TestClient, path: str) -> None:
    resp = client.get(path)
    assert resp.status_code == 200, resp.text
    assert isinstance(resp.json(), dict)


def test_snapshot_has_all_sections(client: TestClient) -> None:
    body = client.get("/api/snapshot").json()
    assert set(body) == {
        "meta",
        "overview",
        "deposits",
        "transactions",
        "monthly",
        "yearly",
        "analytics",
        "calculator",
    }


def test_token_auth_enforced_when_configured(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("INV_DASHBOARD_API_TOKEN", _TOKEN)
    get_settings.cache_clear()
    try:
        # Health stays open even with a token configured.
        assert client.get("/api/health").status_code == 200
        # Guarded routes now require the token.
        assert client.get("/api/overview").status_code == 401
        assert client.get("/api/overview", headers={"X-API-Token": "wrong"}).status_code == 401
        bearer = "Bearer " + _TOKEN
        ok = client.get("/api/overview", headers={"Authorization": bearer})
        assert ok.status_code == 200
        ok2 = client.get("/api/overview", headers={"X-API-Token": _TOKEN})
        assert ok2.status_code == 200
    finally:
        get_settings.cache_clear()
