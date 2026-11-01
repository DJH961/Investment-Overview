"""``/api/onboarding`` route."""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_onboarding_fresh_database(api_client: TestClient) -> None:
    body = api_client.get("/api/onboarding").json()
    assert body["account"] is False
    assert body["first_import"] is False
    assert body["targets"] is False
    assert body["conversions"] is False
    assert body["complete"] is False


def test_onboarding_requires_auth(anon_client: TestClient) -> None:
    assert anon_client.get("/api/onboarding").status_code == 401
