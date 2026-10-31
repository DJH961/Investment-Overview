"""Fixtures for the v6 API tests.

* ``api_db`` — a fresh single-file SQLite DB in ``tmp_path`` (all three tiers in
  one file), schema created from the models, settings pointed at it.
* ``api_client`` — ``TestClient`` with the auth guard overridden (logged in).
* ``anon_client`` — ``TestClient`` with the real guard (for auth tests).

Both clients build the app with ``lifespan=False`` (no boot, no scheduler).
Seed data with ``investment_dashboard.db.ledger_session_scope()`` inside a test.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.api.app import create_app
from investment_dashboard.api.deps import require_auth
from investment_dashboard.config import get_settings
from investment_dashboard.db import dispose_engines, get_ledger_engine
from investment_dashboard.models import ALL_METADATAS


@pytest.fixture
def api_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    db = tmp_path / "app.sqlite"
    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(db))
    for tier in ("LEDGER", "CONFIG", "CACHE"):
        monkeypatch.delenv(f"INV_DASHBOARD_{tier}_PATH", raising=False)
    monkeypatch.setenv("INV_DASHBOARD_SERVER_MODE", "true")
    monkeypatch.setenv("INV_DASHBOARD_SESSION_SECRET", "test-session-secret-0123456789abcdef")
    monkeypatch.setenv("INV_DASHBOARD_COOKIE_SECURE", "false")
    monkeypatch.delenv("INV_DASHBOARD_API_TOKEN", raising=False)
    get_settings.cache_clear()
    dispose_engines()
    engine = get_ledger_engine()
    for metadata in ALL_METADATAS:
        metadata.create_all(engine)
    try:
        yield db
    finally:
        dispose_engines()
        get_settings.cache_clear()


async def _allow() -> None:
    return None


@pytest.fixture
def api_client(api_db: Path) -> Iterator[TestClient]:
    app = create_app(lifespan=False)
    app.dependency_overrides[require_auth] = _allow
    with TestClient(app) as client:
        yield client


@pytest.fixture
def anon_client(api_db: Path) -> Iterator[TestClient]:
    with TestClient(create_app(lifespan=False)) as client:
        yield client
