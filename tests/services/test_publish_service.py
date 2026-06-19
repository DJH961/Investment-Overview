"""Tests for the v3.0 publish service (export -> encrypt -> GitHub release)."""

from __future__ import annotations

import json

import httpx
import pytest
import respx

from investment_dashboard.config import Settings
from investment_dashboard.services import publish_service
from investment_dashboard.storage import blob_crypto

REPO = "octo/portfolio"
TAG = "live-data"
TOKEN = "ghp_dummytoken"
API = "https://api.github.com"
UPLOADS = "https://uploads.github.com"

ENVELOPE = {"v": 1, "kdf": blob_crypto.KDF_NAME, "kdf_params": {}, "ciphertext": "AA=="}


def _release_body(release_id: int = 99, assets: list | None = None) -> dict:
    return {
        "id": release_id,
        "upload_url": f"{UPLOADS}/repos/{REPO}/releases/{release_id}/assets{{?name,label}}",
        "assets": assets or [],
    }


def _asset_body(asset_id: int = 1) -> dict:
    return {
        "id": asset_id,
        "name": publish_service.ASSET_NAME,
        "browser_download_url": f"https://github.com/{REPO}/releases/download/{TAG}/portfolio.enc",
    }


# --- validation / resolution -------------------------------------------------


def test_validate_repo_rejects_bad_slug() -> None:
    with pytest.raises(publish_service.PublishError):
        publish_service.validate_repo("not-a-repo")
    publish_service.validate_repo("owner/name")  # no raise


def test_resolvers_prefer_settings_then_keyring(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = Settings(mobile_passphrase="from-settings", publish_token="tok-settings")
    assert publish_service.resolve_mobile_passphrase(settings) == "from-settings"
    assert publish_service.resolve_publish_token(settings) == "tok-settings"

    empty = Settings()
    monkeypatch.setattr(
        publish_service, "load_mobile_passphrase_from_keyring", lambda: "from-keyring"
    )
    monkeypatch.setattr(publish_service, "load_publish_token_from_keyring", lambda: "tok-keyring")
    assert publish_service.resolve_mobile_passphrase(empty) == "from-keyring"
    assert publish_service.resolve_publish_token(empty) == "tok-keyring"


def test_publish_now_requires_repo_passphrase_token(session) -> None:  # type: ignore[no-untyped-def]
    settings = Settings()
    with pytest.raises(publish_service.PublishError, match="repository"):
        publish_service.publish_now(session, settings=settings)
    with pytest.raises(publish_service.PublishError, match="passphrase"):
        publish_service.publish_now(session, settings=settings, repo=REPO)
    with pytest.raises(publish_service.PublishError, match="token"):
        publish_service.publish_now(
            session, settings=settings, repo=REPO, passphrase="pw-strong-enough"
        )


# --- GitHub transport --------------------------------------------------------


@respx.mock
def test_publish_envelope_overwrites_existing_asset() -> None:
    existing = _asset_body(asset_id=7)
    get = respx.get(f"{API}/repos/{REPO}/releases/tags/{TAG}").mock(
        return_value=httpx.Response(200, json=_release_body(assets=[existing]))
    )
    delete = respx.delete(f"{API}/repos/{REPO}/releases/assets/7").mock(
        return_value=httpx.Response(204)
    )
    upload = respx.post(f"{UPLOADS}/repos/{REPO}/releases/99/assets").mock(
        return_value=httpx.Response(201, json=_asset_body(asset_id=8))
    )

    result = publish_service.publish_envelope(ENVELOPE, repo=REPO, release_tag=TAG, token=TOKEN)

    assert get.called
    assert delete.called
    assert upload.called
    assert result.created_release is False
    assert result.asset_id == 8
    assert result.size_bytes == len(json.dumps(ENVELOPE, separators=(",", ":")).encode())
    # Token travels in the Authorization header, never in the URL.
    assert upload.calls.last.request.headers["authorization"] == "Bearer " + TOKEN


@respx.mock
def test_publish_envelope_creates_release_when_missing() -> None:
    respx.get(f"{API}/repos/{REPO}/releases/tags/{TAG}").mock(
        return_value=httpx.Response(404, json={"message": "Not Found"})
    )
    create = respx.post(f"{API}/repos/{REPO}/releases").mock(
        return_value=httpx.Response(201, json=_release_body(release_id=42))
    )
    respx.post(f"{UPLOADS}/repos/{REPO}/releases/42/assets").mock(
        return_value=httpx.Response(201, json=_asset_body())
    )

    result = publish_service.publish_envelope(ENVELOPE, repo=REPO, release_tag=TAG, token=TOKEN)

    assert create.called
    assert result.created_release is True
    body = json.loads(create.calls.last.request.content)
    assert body["tag_name"] == TAG


@respx.mock
def test_publish_envelope_surfaces_api_error() -> None:
    respx.get(f"{API}/repos/{REPO}/releases/tags/{TAG}").mock(
        return_value=httpx.Response(403, json={"message": "Forbidden"})
    )
    with pytest.raises(publish_service.PublishError, match="Forbidden"):
        publish_service.publish_envelope(ENVELOPE, repo=REPO, release_tag=TAG, token=TOKEN)


@respx.mock
def test_publish_now_end_to_end(session, monkeypatch: pytest.MonkeyPatch) -> None:  # type: ignore[no-untyped-def]
    # Avoid the read-model/network build; focus on the orchestration + transport.
    monkeypatch.setattr(
        publish_service,
        "build_envelope",
        lambda *a, **k: ENVELOPE,
    )
    respx.get(f"{API}/repos/{REPO}/releases/tags/{TAG}").mock(
        return_value=httpx.Response(200, json=_release_body())
    )
    respx.post(f"{UPLOADS}/repos/{REPO}/releases/99/assets").mock(
        return_value=httpx.Response(201, json=_asset_body())
    )

    settings = Settings(
        publish_repo=REPO,
        mobile_passphrase="pw-strong-enough",
        publish_token=TOKEN,
    )
    result = publish_service.publish_now(session, settings=settings)
    assert result.repo == REPO
    assert result.asset_name == publish_service.ASSET_NAME


def test_build_envelope_round_trips_through_export(session) -> None:  # type: ignore[no-untyped-def]
    envelope = publish_service.build_envelope(session, passphrase="pw-strong-enough")
    raw = blob_crypto.decrypt_bytes(envelope, "pw-strong-enough")
    payload = json.loads(raw)
    assert "meta" in payload
    assert "holdings" in payload
