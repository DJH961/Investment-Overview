"""Export → encrypt → publish orchestration for the v3.0 live-web companion.

Implements ``docs/v3.0_live_web_companion_proposal.md`` §5.2. The flow is:

1. **export** — :func:`build_mobile_export` assembles the minimized payload
   (reusing the existing positions/metrics/read-model compute — no new
   business logic).
2. **encrypt** — :mod:`investment_dashboard.storage.blob_crypto` seals it into
   an AES-256-GCM envelope under the user's mobile passphrase.
3. **publish** — the envelope is uploaded as a single asset (``portfolio.enc``)
   on a fixed GitHub release, *overwriting* the previous one so old ciphertext
   never accumulates in git history.

Transport uses the GitHub REST release-asset API with a fine-grained Personal
Access Token (Contents: write on the one repo). The token and passphrase live
in the OS keyring (see :mod:`investment_dashboard.storage.encryption`); they
are never written to the repo, ``.env``, or logs.

Everything here is additive and inert until the user enables publishing.

SECURITY — this repository is PUBLIC (proposal §7.4). Never log, commit, or
persist decrypted data, the GitHub token, or the mobile passphrase. The publish
path must log only non-sensitive metadata (repo, tag, asset name, byte counts,
timestamps) — never payload contents or secrets.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from investment_dashboard.storage import blob_crypto
from investment_dashboard.storage.encryption import (
    load_mobile_passphrase_from_keyring,
    load_publish_token_from_keyring,
)

if TYPE_CHECKING:
    from datetime import date

    import httpx
    from sqlalchemy.orm import Session

    from investment_dashboard.config import Settings

log = logging.getLogger(__name__)

#: Fixed asset name overwritten on every publish. The web app fetches this.
ASSET_NAME = "portfolio.enc"

#: GitHub REST API roots.
_API_ROOT = "https://api.github.com"

#: ``owner/name`` repository slug. Each part must start alphanumerically; the
#: explicit ``..`` guard in :func:`validate_repo` then blocks any path-traversal
#: attempt against the REST URL.
_REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$")

#: Per-request network timeout (seconds). Uploads are tiny (a few KB).
_HTTP_TIMEOUT = 30.0


class PublishError(RuntimeError):
    """Raised when publishing can't proceed or the GitHub API rejects it."""


@dataclass(frozen=True)
class PublishResult:
    """Outcome of a successful publish."""

    repo: str
    release_tag: str
    asset_name: str
    asset_id: int
    browser_download_url: str | None
    size_bytes: int
    published_at: datetime
    created_release: bool


def resolve_mobile_passphrase(settings: Settings) -> str | None:
    """Mobile passphrase precedence: explicit setting/env > OS keyring."""
    return settings.mobile_passphrase or load_mobile_passphrase_from_keyring()


def resolve_publish_token(settings: Settings) -> str | None:
    """GitHub PAT precedence: explicit setting/env > OS keyring."""
    return settings.publish_token or load_publish_token_from_keyring()


def validate_repo(repo: str) -> None:
    """Raise :class:`PublishError` unless ``repo`` is a valid ``owner/name``.

    Guards against path traversal: a slug like ``owner/..`` would otherwise
    collapse the GitHub REST path and target an unintended endpoint.
    """
    if not _REPO_RE.match(repo) or ".." in repo:
        raise PublishError(f"publish_repo must be in 'owner/name' form, got {repo!r}.")


def build_envelope(
    session: Session,
    *,
    passphrase: str,
    include_transactions: bool = False,
    as_of: date | None = None,
) -> dict[str, Any]:
    """Build the mobile export and seal it into an AES-GCM envelope."""
    from investment_dashboard.readmodels import build_mobile_export  # noqa: PLC0415

    payload = build_mobile_export(
        session,
        as_of=as_of,
        include_transactions=include_transactions,
    )
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    return blob_crypto.encrypt_bytes(raw, passphrase)


def _headers(token: str) -> dict[str, str]:
    return {
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def _get_or_create_release(
    client: httpx.Client,
    *,
    repo: str,
    release_tag: str,
    token: str,
) -> tuple[dict[str, Any], bool]:
    """Return ``(release, created)`` for ``release_tag``, creating it if absent."""
    headers = _headers(token)
    resp = client.get(f"{_API_ROOT}/repos/{repo}/releases/tags/{release_tag}", headers=headers)
    if resp.status_code == 200:
        return resp.json(), False
    if resp.status_code != 404:
        raise PublishError(_api_error("look up the release", resp))

    create = client.post(
        f"{_API_ROOT}/repos/{repo}/releases",
        headers=headers,
        json={
            "tag_name": release_tag,
            "name": "Live web companion data",
            "body": (
                "Encrypted portfolio blob for the v3.0 live-web companion. "
                "The single asset on this release is overwritten on each publish."
            ),
        },
    )
    if create.status_code not in (200, 201):
        raise PublishError(_api_error("create the release", create))
    return create.json(), True


def _delete_existing_asset(
    client: httpx.Client,
    *,
    repo: str,
    release: dict[str, Any],
    asset_name: str,
    token: str,
) -> None:
    for asset in release.get("assets", []) or []:
        if asset.get("name") != asset_name:
            continue
        resp = client.delete(
            f"{_API_ROOT}/repos/{repo}/releases/assets/{asset['id']}",
            headers=_headers(token),
        )
        if resp.status_code not in (200, 204):
            raise PublishError(_api_error("delete the previous asset", resp))


def _upload_asset(
    client: httpx.Client,
    *,
    release: dict[str, Any],
    asset_name: str,
    blob: bytes,
    token: str,
) -> dict[str, Any]:
    # ``upload_url`` is an RFC 6570 template like
    # ``https://uploads.github.com/.../assets{?name,label}``.
    template = release.get("upload_url", "")
    base = template.split("{", 1)[0]
    if not base:  # pragma: no cover - defensive
        raise PublishError("the release response did not include an upload URL.")
    headers = _headers(token)
    headers["Content-Type"] = "application/octet-stream"
    resp = client.post(base, params={"name": asset_name}, content=blob, headers=headers)
    if resp.status_code not in (200, 201):
        raise PublishError(_api_error("upload the encrypted asset", resp))
    return resp.json()


def _api_error(action: str, resp: httpx.Response) -> str:
    detail = ""
    try:
        body = resp.json()
        if isinstance(body, dict) and body.get("message"):
            detail = f": {body['message']}"
    except ValueError:  # pragma: no cover - non-JSON error body
        detail = ""
    return f"GitHub API failed to {action} (HTTP {resp.status_code}){detail}"


def publish_envelope(
    envelope: dict[str, Any],
    *,
    repo: str,
    release_tag: str,
    token: str,
    asset_name: str = ASSET_NAME,
    client: httpx.Client | None = None,
) -> PublishResult:
    """Upload ``envelope`` as the single release asset, overwriting any prior.

    Opens (and closes) its own :class:`httpx.Client` unless one is supplied
    (tests inject a mocked client).
    """
    import httpx  # noqa: PLC0415

    validate_repo(repo)
    blob = json.dumps(envelope, separators=(",", ":")).encode("utf-8")

    owns_client = client is None
    client = client or httpx.Client(timeout=_HTTP_TIMEOUT)
    try:
        release, created = _get_or_create_release(
            client, repo=repo, release_tag=release_tag, token=token
        )
        _delete_existing_asset(
            client, repo=repo, release=release, asset_name=asset_name, token=token
        )
        asset = _upload_asset(
            client, release=release, asset_name=asset_name, blob=blob, token=token
        )
    finally:
        if owns_client:
            client.close()

    log.info("published %s (%d bytes) to %s@%s", asset_name, len(blob), repo, release_tag)
    return PublishResult(
        repo=repo,
        release_tag=release_tag,
        asset_name=asset_name,
        asset_id=int(asset.get("id", 0)),
        browser_download_url=asset.get("browser_download_url"),
        size_bytes=len(blob),
        published_at=datetime.now(tz=UTC),
        created_release=created,
    )


def publish_now(
    session: Session,
    *,
    settings: Settings | None = None,
    repo: str | None = None,
    release_tag: str | None = None,
    include_transactions: bool | None = None,
    passphrase: str | None = None,
    token: str | None = None,
    as_of: date | None = None,
    asset_name: str = ASSET_NAME,
    client: httpx.Client | None = None,
) -> PublishResult:
    """Export → encrypt → publish in one call.

    Each keyword override falls back to :class:`Settings` / the OS keyring when
    ``None``, so the CLI can run with zero arguments while the UI can pass its
    persisted preferences explicitly.
    """
    if settings is None:
        from investment_dashboard.config import get_settings  # noqa: PLC0415

        settings = get_settings()

    repo = repo or settings.publish_repo
    release_tag = release_tag or settings.publish_release_tag
    if include_transactions is None:
        include_transactions = settings.publish_include_transactions
    passphrase = passphrase or resolve_mobile_passphrase(settings)
    token = token or resolve_publish_token(settings)

    if not repo:
        raise PublishError(
            "No publish repository configured. Set INV_DASHBOARD_PUBLISH_REPO "
            "or the repo field in Settings → Live web companion."
        )
    if not passphrase:
        raise PublishError(
            "No mobile passphrase available. Save one in Settings → Live web "
            "companion (stored in the OS keychain) or set "
            "INV_DASHBOARD_MOBILE_PASSPHRASE."
        )
    if not token:
        raise PublishError(
            "No GitHub token available. Save a fine-grained PAT in Settings → "
            "Live web companion (stored in the OS keychain) or set "
            "INV_DASHBOARD_PUBLISH_TOKEN."
        )

    envelope = build_envelope(
        session,
        passphrase=passphrase,
        include_transactions=include_transactions,
        as_of=as_of,
    )
    return publish_envelope(
        envelope,
        repo=repo,
        release_tag=release_tag,
        token=token,
        asset_name=asset_name,
        client=client,
    )
