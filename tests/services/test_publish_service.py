"""Tests for the v3.0 publish service (export -> encrypt -> GitHub release)."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime, timedelta

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


def _mock_preflight(*, push: bool = True, expires: str | None = None) -> None:
    """Stub the ``GET /repos/{repo}`` pre-flight with optional expiry header."""
    headers = {}
    if expires is not None:
        headers["github-authentication-token-expiration"] = expires
    respx.get(f"{API}/repos/{REPO}").mock(
        return_value=httpx.Response(200, json={"permissions": {"push": push}}, headers=headers)
    )


# --- validation / resolution -------------------------------------------------


def test_validate_repo_rejects_bad_slug() -> None:
    for bad in ("not-a-repo", "owner/..", "../owner", "owner/na/me", "-bad/name"):
        with pytest.raises(publish_service.PublishError):
            publish_service.validate_repo(bad)
    publish_service.validate_repo("owner/name")  # no raise
    publish_service.validate_repo("DJH961/Investment-Overview")  # no raise


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
    _mock_preflight()
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


def test_build_meta_stamps_blob_hash() -> None:
    import hashlib

    blob = b'{"ciphertext":"AA=="}'
    published = datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)
    meta = publish_service.build_meta(blob, published_at=published)
    assert meta["version"] == hashlib.sha256(blob).hexdigest()
    assert meta["size"] == len(blob)
    assert meta["asset"] == publish_service.ASSET_NAME
    assert meta["published_at"] == "2026-01-02T03:04:05+00:00"
    # The sidecar must never carry decrypted data — only the stamp fields.
    assert set(meta) == {"schema", "version", "size", "published_at", "asset"}


@respx.mock
def test_publish_envelope_uploads_meta_sidecar() -> None:
    _mock_preflight()
    respx.get(f"{API}/repos/{REPO}/releases/tags/{TAG}").mock(
        return_value=httpx.Response(200, json=_release_body())
    )
    upload = respx.post(f"{UPLOADS}/repos/{REPO}/releases/99/assets").mock(
        return_value=httpx.Response(201, json=_asset_body(asset_id=8))
    )

    result = publish_service.publish_envelope(ENVELOPE, repo=REPO, release_tag=TAG, token=TOKEN)

    # Two uploads: the blob, then the meta sidecar (with the right asset names).
    names = [call.request.url.params.get("name") for call in upload.calls]
    assert names == [publish_service.ASSET_NAME, publish_service.META_ASSET_NAME]
    # The published meta body stamps the exact blob hash, mirrored on the result.
    import hashlib

    blob = json.dumps(ENVELOPE, separators=(",", ":")).encode()
    meta_body = json.loads(upload.calls[1].request.content)
    assert meta_body["version"] == hashlib.sha256(blob).hexdigest()
    assert result.version == meta_body["version"]


@respx.mock
def test_publish_envelope_creates_release_when_missing() -> None:
    _mock_preflight()
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
    _mock_preflight()
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
    _mock_preflight()
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


# --- pre-flight token validation (C5) ----------------------------------------


@respx.mock
def test_preflight_rejects_invalid_token() -> None:
    respx.get(f"{API}/repos/{REPO}").mock(
        return_value=httpx.Response(401, json={"message": "Bad credentials"})
    )
    with pytest.raises(publish_service.PublishError, match="401"):
        publish_service.publish_envelope(ENVELOPE, repo=REPO, release_tag=TAG, token=TOKEN)


@respx.mock
def test_preflight_rejects_unreachable_repo() -> None:
    respx.get(f"{API}/repos/{REPO}").mock(
        return_value=httpx.Response(404, json={"message": "Not Found"})
    )
    with pytest.raises(publish_service.PublishError, match="404"):
        publish_service.publish_envelope(ENVELOPE, repo=REPO, release_tag=TAG, token=TOKEN)


@respx.mock
def test_preflight_rejects_read_only_token() -> None:
    _mock_preflight(push=False)
    with pytest.raises(publish_service.PublishError, match="not write"):
        publish_service.publish_envelope(ENVELOPE, repo=REPO, release_tag=TAG, token=TOKEN)


@respx.mock
def test_preflight_rejects_expired_token() -> None:
    _mock_preflight(expires="2000-01-01 00:00:00 UTC")
    with pytest.raises(publish_service.PublishError, match="expired"):
        publish_service.publish_envelope(ENVELOPE, repo=REPO, release_tag=TAG, token=TOKEN)


@respx.mock
def test_preflight_allows_imminent_but_valid_expiry() -> None:
    """A soon-but-not-yet-expired token still publishes (it only warns)."""
    soon = (datetime.now(tz=UTC) + timedelta(days=2)).strftime("%Y-%m-%d %H:%M:%S %z")
    _mock_preflight(expires=soon)
    respx.get(f"{API}/repos/{REPO}/releases/tags/{TAG}").mock(
        return_value=httpx.Response(200, json=_release_body())
    )
    respx.post(f"{UPLOADS}/repos/{REPO}/releases/99/assets").mock(
        return_value=httpx.Response(201, json=_asset_body())
    )
    result = publish_service.publish_envelope(ENVELOPE, repo=REPO, release_tag=TAG, token=TOKEN)
    assert result.asset_name == publish_service.ASSET_NAME


def test_check_expiry_warns_when_imminent() -> None:
    soon = (datetime.now(tz=UTC) + timedelta(days=2)).strftime("%Y-%m-%d %H:%M:%S %z")
    resp = httpx.Response(200, headers={"github-authentication-token-expiration": soon}, json={})
    records: list[logging.LogRecord] = []
    handler = logging.Handler()
    handler.emit = records.append  # type: ignore[method-assign]
    previous_level = publish_service.log.level
    previous_disabled = publish_service.log.disabled
    publish_service.log.addHandler(handler)
    publish_service.log.setLevel(logging.WARNING)
    # Another test may have run dictConfig(disable_existing_loggers=True); undo
    # that for the duration of this assertion so the warning actually emits.
    publish_service.log.disabled = False
    try:
        publish_service._check_expiry(resp)
    finally:
        publish_service.log.removeHandler(handler)
        publish_service.log.setLevel(previous_level)
        publish_service.log.disabled = previous_disabled
    assert any("expires soon" in r.getMessage() for r in records)


def test_check_expiry_raises_when_past() -> None:
    resp = httpx.Response(
        200,
        headers={"github-authentication-token-expiration": "2000-01-01 00:00:00 UTC"},
        json={},
    )
    with pytest.raises(publish_service.PublishError, match="expired"):
        publish_service._check_expiry(resp)


def test_check_expiry_noop_without_header() -> None:
    publish_service._check_expiry(httpx.Response(200, json={}))  # no raise


def test_parse_expiry_handles_formats_and_garbage() -> None:
    assert publish_service._parse_expiry("2030-01-02 03:04:05 UTC") is not None
    assert publish_service._parse_expiry("2030-01-02 03:04 +0000") is not None
    assert publish_service._parse_expiry("") is None
    assert publish_service._parse_expiry("never") is None
    assert publish_service._parse_expiry("not-a-date") is None


@respx.mock
def test_preflight_aborts_before_any_write() -> None:
    """A bad token must not create a release / leave half-finished state."""
    respx.get(f"{API}/repos/{REPO}").mock(
        return_value=httpx.Response(401, json={"message": "Bad credentials"})
    )
    create = respx.post(f"{API}/repos/{REPO}/releases").mock(
        return_value=httpx.Response(201, json=_release_body())
    )
    with pytest.raises(publish_service.PublishError):
        publish_service.publish_envelope(ENVELOPE, repo=REPO, release_tag=TAG, token=TOKEN)
    assert not create.called


def test_api_error_redacts_token_in_message() -> None:
    leaky_token = "ghp_" + "A" * 36
    resp = httpx.Response(403, json={"message": f"token {leaky_token} is forbidden"})
    message = publish_service._api_error("upload", resp, token=leaky_token)
    assert leaky_token not in message
    assert "«redacted»" in message


def test_build_envelope_round_trips_through_export(session) -> None:  # type: ignore[no-untyped-def]
    envelope = publish_service.build_envelope(session, passphrase="pw-strong-enough")
    raw = blob_crypto.decrypt_bytes(envelope, "pw-strong-enough")
    payload = json.loads(raw)
    assert "meta" in payload
    assert "holdings" in payload
