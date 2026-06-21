"""Best-effort auto-publish triggers for the v3.0 live-web companion.

Implements the auto-publish half of ``docs/v3.0_live_web_companion_proposal.md``
§5.4 (decision §8.2): the encrypted snapshot is (re)published **after every
successful import** and **on graceful app close**, in addition to the manual
"Publish now" button. Each trigger is individually toggleable and the whole
feature stays dormant until the master switch is on.

This module is the thin, *defensive* glue between those host paths (the importer
UI and the shutdown sequence) and :mod:`publish_service`:

* It reads enablement, the per-trigger toggle, and the non-secret preferences
  from ``app_config`` — the same store the Settings → Live web companion panel
  writes — so the UI is the single source of truth.
* :func:`publish_on_trigger` **never raises**. An import must still succeed and
  the app must still shut down even if publishing fails (offline, bad token,
  etc.); failures are logged at ``WARNING`` and swallowed.

SECURITY — this repository is PUBLIC. Never log, commit, or persist decrypted
data, tokens, or passphrases. The logging here is deliberately limited to
non-sensitive metadata (trigger name, asset name, byte count, timestamps).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING

from investment_dashboard.db import session_scope
from investment_dashboard.repositories import app_config_repo

if TYPE_CHECKING:
    from investment_dashboard.services.publish_service import PublishResult

log = logging.getLogger(__name__)

#: ``app_config`` keys, mirroring the Settings → Live web companion panel.
ENABLED_KEY = "live_web_enabled"
REPO_KEY = "live_web_repo"
INCLUDE_TX_KEY = "live_web_include_transactions"
LAST_PUBLISHED_KEY = "live_web_last_published_at"
ON_IMPORT_KEY = "live_web_publish_on_import"
ON_SHUTDOWN_KEY = "live_web_publish_on_shutdown"

#: Trigger identifiers.
TRIGGER_IMPORT = "import"
TRIGGER_SHUTDOWN = "shutdown"

#: Each trigger maps to its per-trigger toggle. Auto-publish triggers default to
#: *on* when the master switch is enabled (matching decision §8.2), so enabling
#: publishing turns both auto-triggers on unless the user opts one out.
_TRIGGER_KEY = {
    TRIGGER_IMPORT: ON_IMPORT_KEY,
    TRIGGER_SHUTDOWN: ON_SHUTDOWN_KEY,
}


def _truthy(value: str | None, *, default: bool) -> bool:
    """Interpret a stored ``app_config`` string as a boolean."""
    if value is None:
        return default
    return value.strip().lower() == "true"


@dataclass(frozen=True)
class _TriggerConfig:
    """Resolved, non-secret preferences for an enabled trigger."""

    repo: str | None
    include_transactions: bool


def _read_config(trigger: str) -> _TriggerConfig | None:
    """Return the config for ``trigger`` if publishing is enabled for it, else ``None``."""
    key = _TRIGGER_KEY.get(trigger)
    if key is None:
        raise ValueError(f"unknown auto-publish trigger: {trigger!r}")
    with session_scope() as session:
        if not _truthy(app_config_repo.get(session, ENABLED_KEY), default=False):
            return None
        if not _truthy(app_config_repo.get(session, key), default=True):
            return None
        repo = app_config_repo.get(session, REPO_KEY)
        include = _truthy(app_config_repo.get(session, INCLUDE_TX_KEY), default=False)
    return _TriggerConfig(repo=repo, include_transactions=include)


def publish_on_trigger(trigger: str) -> PublishResult | None:
    """Auto-publish the live-web blob for ``trigger``; never raises.

    Returns the :class:`~investment_dashboard.services.publish_service.PublishResult`
    on success, or ``None`` when publishing is disabled for this trigger, is
    misconfigured (missing repo/passphrase/token), or the publish failed. All
    failures are logged with non-sensitive metadata only and swallowed so the
    host path (import / shutdown) is never disrupted.
    """
    try:
        cfg = _read_config(trigger)
    except Exception:  # pragma: no cover - defensive; app_config read should not fail
        log.exception("auto-publish: could not read configuration")
        return None
    if cfg is None:
        return None

    from investment_dashboard.services import publish_service  # noqa: PLC0415

    try:
        with session_scope() as session:
            result = publish_service.publish_now(
                session,
                repo=cfg.repo,
                include_transactions=cfg.include_transactions,
            )
    except publish_service.PublishError as exc:
        # Expected, actionable misconfiguration (no token/passphrase/repo, or a
        # GitHub API rejection). The message is non-sensitive by construction.
        log.warning("auto-publish (%s) skipped: %s", trigger, exc)
        return None
    except Exception as exc:  # pragma: no cover - network/runtime
        # Log only the exception class to be sure no payload/secret leaks.
        log.warning("auto-publish (%s) failed: %s", trigger, type(exc).__name__)
        return None

    try:
        with session_scope() as session:
            app_config_repo.set_value(session, LAST_PUBLISHED_KEY, result.published_at.isoformat())
    except Exception:  # pragma: no cover - timestamp is cosmetic
        log.exception("auto-publish: published but failed to record the timestamp")

    log.info(
        "auto-publish (%s): published %s (%d bytes) to %s@%s",
        trigger,
        result.asset_name,
        result.size_bytes,
        result.repo,
        result.release_tag,
    )
    return result
