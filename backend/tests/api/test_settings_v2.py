"""``/api/settings/schema|values|reset|history|export|import``."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from investment_dashboard.api import guards
from investment_dashboard.api.security import Principal
from investment_dashboard.services import settings_service


@pytest.fixture(autouse=True)
def _fresh_cache() -> Iterator[None]:
    settings_service.invalidate()
    yield
    settings_service.invalidate()


@pytest.fixture
def as_session(monkeypatch: pytest.MonkeyPatch) -> None:
    async def principal(_request: object) -> Principal:
        return Principal(kind="session", session_id="abcdef0123456789")

    monkeypatch.setattr(guards, "_principal", principal)


@pytest.fixture
def as_token(monkeypatch: pytest.MonkeyPatch) -> None:
    async def principal(_request: object) -> Principal:
        return Principal(kind="token")

    monkeypatch.setattr(guards, "_principal", principal)


def test_schema_lists_sections_and_fields(api_client: TestClient) -> None:
    data = api_client.get("/api/settings/schema").json()
    keys = {f["key"]: f for f in data["fields"]}
    assert {s["id"] for s in data["sections"]} >= {"display", "backups"}
    assert keys["backup.retention.daily"]["min"] == "0"
    assert keys["tiingo.api_token"]["secret"] is True
    assert keys["tiingo.api_token"]["default"] is None
    assert keys["log_level"]["env_var"] == "INV_DASHBOARD_LOG_LEVEL"


def test_patch_round_trip_and_per_key_errors(api_client: TestClient, as_token: None) -> None:
    resp = api_client.patch(
        "/api/settings/values",
        json={"changes": {"backup.retention.daily": 7, "projection.scenarios": ["0.05"]}},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert sorted(body["changed"]) == ["backup.retention.daily", "projection.scenarios"]
    assert body["values"]["backup.retention.daily"]["value"] == 7
    assert body["values"]["backup.retention.daily"]["source"] == "db"
    assert body["values"]["projection.scenarios"]["value"] == ["0.05"]

    bad = api_client.patch(
        "/api/settings/values",
        json={"changes": {"backup.retention.daily": 5000, "theme": "dark", "nope": 1}},
    )
    assert bad.status_code == 422
    assert set(bad.json()["errors"]) == {"backup.retention.daily", "nope"}
    values = api_client.get("/api/settings/values").json()["values"]
    assert values["theme"]["value"] == "auto"  # nothing half-applied


def test_secrets_are_write_only_and_need_a_session(
    api_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def token(_r: object) -> Principal:
        return Principal(kind="token")

    monkeypatch.setattr(guards, "_principal", token)
    change = {"changes": {"tiingo.api_token": "abcdefghijklmnop"}}
    assert api_client.patch("/api/settings/values", json=change).status_code == 403

    async def session(_r: object) -> Principal:
        return Principal(kind="session", session_id="abcdef0123456789")

    monkeypatch.setattr(guards, "_principal", session)
    resp = api_client.patch("/api/settings/values", json=change)
    assert resp.status_code == 200
    assert "abcdefghijklmnop" not in resp.text
    token_value = resp.json()["values"]["tiingo.api_token"]
    assert token_value["value"] is None
    assert token_value["is_set"] is True
    history = api_client.get("/api/settings/history").json()["rows"]
    assert history[0]["new_value"] == "<redacted>"
    assert history[0]["actor"] == "session:abcdef01"
    assert "abcdefghijklmnop" not in api_client.get("/api/settings/export").text


def test_reset_revert_export_import(api_client: TestClient, as_session: None) -> None:
    api_client.patch("/api/settings/values", json={"changes": {"display.locale": "de-DE"}})
    api_client.patch("/api/settings/values", json={"changes": {"display.locale": "en-US"}})
    row = api_client.get("/api/settings/history", params={"key": "display.locale"}).json()["rows"][
        0
    ]
    assert api_client.post(f"/api/settings/history/{row['id']}/revert").status_code == 200
    values = api_client.get("/api/settings/values").json()["values"]
    assert values["display.locale"]["value"] == "de-DE"
    exported = api_client.get("/api/settings/export")
    assert "attachment" in exported.headers["content-disposition"]
    payload = exported.json()
    assert payload["settings"] == {"display.locale": "de-DE"}

    resp = api_client.post("/api/settings/reset", json={"section": "display"})
    assert resp.json()["values"]["display.locale"]["source"] == "default"
    dry = api_client.post("/api/settings/import", json=payload).json()
    assert dry == {
        "dry_run": True,
        "diff": [{"key": "display.locale", "current": "en-GB", "new": "de-DE"}],
    }
    api_client.post("/api/settings/import", params={"dry_run": "false"}, json=payload)
    values = api_client.get("/api/settings/values").json()["values"]
    assert values["display.locale"]["value"] == "de-DE"
    assert api_client.post("/api/settings/import", json={"kind": "x"}).status_code == 422
    assert api_client.post("/api/settings/history/99999/revert").status_code == 404
    assert api_client.post("/api/settings/reset", json={"keys": ["nope"]}).status_code == 422


def test_legacy_view_sees_new_values(api_client: TestClient, as_session: None) -> None:
    api_client.patch("/api/settings/values", json={"changes": {"theme": "dark"}})
    assert api_client.get("/api/settings").json()["theme"] == "dark"


def test_origin_guard_applies(anon_client: TestClient) -> None:
    assert anon_client.get("/api/settings/schema").status_code == 401
    assert anon_client.patch("/api/settings/values", json={"changes": {}}).status_code == 401
