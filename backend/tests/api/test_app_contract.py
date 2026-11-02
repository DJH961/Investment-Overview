"""Contract tests for the v6 app factory (owned by the orchestrator)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.api.app import create_app
from investment_dashboard.config import get_settings


def test_health_is_public(anon_client: TestClient) -> None:
    resp = anon_client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"
    assert resp.headers["X-Robots-Tag"].startswith("noindex")
    assert resp.headers["Cache-Control"] == "no-store"


def test_unknown_api_path_is_404(api_client: TestClient) -> None:
    assert api_client.get("/api/does-not-exist").status_code == 404


def test_openapi_renders(api_client: TestClient) -> None:
    doc = api_client.app.openapi()  # type: ignore[attr-defined]
    assert doc["info"]["title"] == "Investment Overview"


def test_security_headers_include_coop_corp(anon_client: TestClient) -> None:
    resp = anon_client.get("/api/health")
    assert resp.headers["Cross-Origin-Opener-Policy"] == "same-origin"
    assert resp.headers["Cross-Origin-Resource-Policy"] == "same-origin"


@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json"])
def test_docs_are_off_in_server_mode(anon_client: TestClient, path: str) -> None:
    # api_db sets INV_DASHBOARD_SERVER_MODE=true
    assert anon_client.get(path).status_code == 404


def test_docs_are_off_even_with_the_spa_mounted(
    api_db: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html><title>x</title>", encoding="utf-8")
    monkeypatch.setenv("INV_DASHBOARD_FRONTEND_DIST", str(dist))
    get_settings.cache_clear()
    with TestClient(create_app(lifespan=False)) as client:
        assert client.get("/overview").status_code == 200  # SPA fallback still works
        for path in ("/docs", "/redoc", "/openapi.json", "/docs/oauth2-redirect"):
            assert client.get(path).status_code == 404


def test_docs_can_be_exposed(api_db: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INV_DASHBOARD_EXPOSE_API_DOCS", "true")
    get_settings.cache_clear()
    with TestClient(create_app(lifespan=False)) as client:
        assert client.get("/openapi.json").status_code == 200
        assert client.get("/docs").status_code == 200
