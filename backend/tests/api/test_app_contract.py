"""Contract tests for the v6 app factory (owned by the orchestrator)."""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_health_is_public(anon_client: TestClient) -> None:
    resp = anon_client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"
    assert resp.headers["X-Robots-Tag"].startswith("noindex")
    assert resp.headers["Cache-Control"] == "no-store"


def test_unknown_api_path_is_404(api_client: TestClient) -> None:
    assert api_client.get("/api/does-not-exist").status_code == 404


def test_openapi_renders(api_client: TestClient) -> None:
    doc = api_client.get("/openapi.json").json()
    assert doc["info"]["title"] == "Investment Overview"
