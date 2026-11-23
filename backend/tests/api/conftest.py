"""Fixtures for the v6 API tests.

* ``api_db`` — a fresh single-file SQLite DB in ``tmp_path`` (all three tiers in
  one file), settings pointed at it. The schema is built from the models once per
  test session (per xdist worker) into a template file, and each test gets a copy.
* ``api_client`` — ``TestClient`` with the auth guard overridden (logged in).
* ``anon_client`` — ``TestClient`` with the real guard (for auth tests).

Both clients build the app with ``lifespan=False`` (no boot, no scheduler).
Seed data with ``investment_dashboard.db.ledger_session_scope()`` inside a test.
"""

from __future__ import annotations

import shutil
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from investment_dashboard.api.app import create_app
from investment_dashboard.api.deps import require_auth
from investment_dashboard.config import get_settings
from investment_dashboard.db import dispose_engines
from investment_dashboard.models import ALL_METADATAS


@pytest.fixture(autouse=True)
def _steady_etag_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pin the clock part of the ``/both`` ETags while a test runs.

    The ETag carries a 60-second TTL bucket; a slow first request on a CI runner can
    straddle a bucket boundary, so the follow-up ``If-None-Match`` misses and the
    304 tests flake. Calls with an explicit time (the time-component test) still use
    the real function, and tests that patch it themselves override this.
    """
    from investment_dashboard.services import read_cache

    real = read_cache.time_component

    def steady(now: float | None = None) -> str:
        return real(now) if now is not None else "test-clock"

    monkeypatch.setattr(read_cache, "time_component", steady)


@pytest.fixture(scope="session")
def _api_schema_template(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """An empty database with every tier's schema, built once per session.

    ``create_all`` for all the models on a new file costs tens of milliseconds (far
    more on Windows); copying the finished file costs well under one. The template is
    a plain rollback-journal file with no ``-wal`` sidecar, so a byte copy is a
    complete database; the app's engine switches the copy to its own journal mode.
    """
    template = tmp_path_factory.mktemp("api_schema") / "template.sqlite"
    engine = create_engine(f"sqlite:///{template}")
    try:
        for metadata in ALL_METADATAS:
            metadata.create_all(engine)
    finally:
        engine.dispose()
    return template


@pytest.fixture
def api_db(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, _api_schema_template: Path
) -> Iterator[Path]:
    db = tmp_path / "app.sqlite"
    shutil.copyfile(_api_schema_template, db)
    monkeypatch.setenv("INV_DASHBOARD_DB_PATH", str(db))
    for tier in ("LEDGER", "CONFIG", "CACHE"):
        monkeypatch.delenv(f"INV_DASHBOARD_{tier}_PATH", raising=False)
    monkeypatch.setenv("INV_DASHBOARD_SERVER_MODE", "true")
    monkeypatch.setenv("INV_DASHBOARD_COOKIE_SECURE", "false")
    monkeypatch.delenv("INV_DASHBOARD_API_TOKEN", raising=False)
    get_settings.cache_clear()
    dispose_engines()
    try:
        yield db
    finally:
        dispose_engines()
        get_settings.cache_clear()


async def _allow() -> None:
    return None


#: Built apps, keyed by the settings ``create_app`` reads. Building one registers
#: every route (about 0.3 s, far more than a typical API test), and the app keeps no
#: per-request state: a test only changes ``dependency_overrides`` and ``app.state``,
#: which ``_shared_app`` resets.
_APPS: dict[tuple[object, ...], FastAPI] = {}


def _shared_app() -> FastAPI:
    settings = get_settings()
    key = (
        settings.server_mode,
        settings.expose_api_docs,
        tuple(settings.dev_cors_origins or ()),
        str(settings.frontend_dist) if settings.frontend_dist is not None else None,
    )
    app = _APPS.get(key)
    if app is None:
        app = _APPS[key] = create_app(lifespan=False)
    app.dependency_overrides.clear()
    app.state._state.clear()
    return app


@pytest.fixture
def api_client(api_db: Path) -> Iterator[TestClient]:
    app = _shared_app()
    app.dependency_overrides[require_auth] = _allow
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides.clear()


@pytest.fixture
def anon_client(api_db: Path) -> Iterator[TestClient]:
    app = _shared_app()
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides.clear()
