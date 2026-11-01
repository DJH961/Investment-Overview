"""``/api/diagnostics`` routes."""

from __future__ import annotations

from fastapi.testclient import TestClient

from investment_dashboard.services import provider_status, runtime_status


def test_diagnostics_shape(api_client: TestClient) -> None:
    provider_status.reset()
    runtime_status.reset()
    provider_status.record("yfinance", "error", "boom")
    runtime_status.record_error("refresh", "failed")
    body = api_client.get("/api/diagnostics").json()
    assert body["status"] in {"ok", "warning", "error"}
    assert {c["id"] for c in body["checks"]}
    assert any(p["name"] == "yfinance" and p["status"] == "error" for p in body["providers"])
    assert any(p["source"] == "refresh" for p in body["problems"])
    assert "active" in body["refresh"]
    provider_status.reset()
    runtime_status.reset()


def test_support_bundle_is_text_download(api_client: TestClient) -> None:
    res = api_client.get("/api/diagnostics/support-bundle")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/plain")
    assert "attachment" in res.headers["content-disposition"]
    assert "support bundle" in res.text


def test_support_bundle_leaves_out_the_raw_log(api_client: TestClient) -> None:
    text = api_client.get("/api/diagnostics/support-bundle").text
    assert "Recent log (last" not in text
    assert "docker compose logs app" in text
