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


def test_status_is_a_cheap_headline(api_client: TestClient) -> None:
    runtime_status.reset()
    runtime_status.record_error("refresh", "failed")
    body = api_client.get("/api/diagnostics/status").json()
    assert body["severity"] in {"ok", "info", "warning", "error"}
    assert isinstance(body["count"], int)
    assert body["problems"] == 1
    runtime_status.reset()


def test_dismiss_one_and_all_problems(api_client: TestClient) -> None:
    runtime_status.reset()
    first = runtime_status.record_error("refresh", "one")
    runtime_status.record_error("fx", "two")
    res = api_client.post(f"/api/diagnostics/problems/{first.seq}/dismiss")
    assert res.status_code == 200
    assert res.json() == {"dismissed": 1}
    assert api_client.post(f"/api/diagnostics/problems/{first.seq}/dismiss").status_code == 404
    assert [p.message for p in runtime_status.recent()] == ["two"]
    assert api_client.post("/api/diagnostics/problems/dismiss-all").json() == {"dismissed": 1}
    assert runtime_status.recent() == []
