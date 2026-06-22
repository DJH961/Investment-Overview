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
import threading
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

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
ON_MANUAL_EDIT_KEY = "live_web_publish_on_manual_edit"

#: Trigger identifiers.
TRIGGER_IMPORT = "import"
TRIGGER_SHUTDOWN = "shutdown"
TRIGGER_MANUAL_EDIT = "manual_edit"

#: Grace period between a manual ledger edit and the debounced republish. Long
#: enough that a flurry of manual edits coalesces into a single publish (each
#: edit re-arms the timer) instead of one upload per keystroke-save.
MANUAL_EDIT_DEBOUNCE_SECONDS = 120.0

#: Each trigger maps to its per-trigger toggle. Auto-publish triggers default to
#: *on* when the master switch is enabled (matching decision §8.2), so enabling
#: publishing turns the auto-triggers on unless the user opts one out.
_TRIGGER_KEY = {
    TRIGGER_IMPORT: ON_IMPORT_KEY,
    TRIGGER_SHUTDOWN: ON_SHUTDOWN_KEY,
    TRIGGER_MANUAL_EDIT: ON_MANUAL_EDIT_KEY,
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


@dataclass(frozen=True)
class PublishOutcome:
    """Result of an auto-publish attempt, for callers that want to react.

    ``status`` is one of:

    * ``"published"`` — the blob was uploaded; ``result`` carries the details.
    * ``"skipped"`` — publishing is disabled/not configured for this trigger;
      nothing was attempted (and the user should not be bothered).
    * ``"failed"`` — an attempt was made but failed; ``detail`` is a short,
      non-sensitive reason suitable for showing to the user.
    """

    trigger: str
    status: Literal["published", "skipped", "failed"]
    result: PublishResult | None = None
    detail: str | None = None


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


def run_trigger(trigger: str) -> PublishOutcome:
    """Auto-publish the live-web blob for ``trigger``; never raises.

    Returns a :class:`PublishOutcome` describing whether the publish was
    ``"published"``, ``"skipped"`` (disabled/misconfigured) or ``"failed"``. All
    failures are logged with non-sensitive metadata only and swallowed so the
    host path (import / shutdown / manual edit) is never disrupted.
    """
    try:
        cfg = _read_config(trigger)
    except Exception:  # pragma: no cover - defensive; app_config read should not fail
        log.exception("auto-publish: could not read configuration")
        return PublishOutcome(trigger, "skipped", detail="configuration unavailable")
    if cfg is None:
        return PublishOutcome(trigger, "skipped")

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
        return PublishOutcome(trigger, "failed", detail=str(exc))
    except Exception as exc:  # pragma: no cover - network/runtime
        # Log only the exception class to be sure no payload/secret leaks.
        log.warning("auto-publish (%s) failed: %s", trigger, type(exc).__name__)
        return PublishOutcome(trigger, "failed", detail="unexpected error")

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
    return PublishOutcome(trigger, "published", result=result)


def publish_on_trigger(trigger: str) -> PublishResult | None:
    """Auto-publish for ``trigger`` and return the :class:`PublishResult`, or ``None``.

    Thin back-compat wrapper over :func:`run_trigger` for callers that only care
    about the published result (and not whether a publish was skipped vs failed).
    """
    return run_trigger(trigger).result


def describe_outcome(outcome: PublishOutcome) -> tuple[str, str] | None:
    """Map an outcome to a short ``(message, notify_type)`` for the UI, or ``None``.

    Returns ``None`` for a skipped/disabled publish so the user is never bothered
    with a notification about a feature they have switched off.
    """
    if outcome.status == "published":
        result = outcome.result
        if result is not None:
            return (f"Published live-web snapshot to {result.repo}.", "positive")
        return ("Published live-web snapshot.", "positive")
    if outcome.status == "failed":
        suffix = f": {outcome.detail}" if outcome.detail else "."
        return (f"Live-web publish failed{suffix}", "negative")
    return None


# ---------------------------------------------------------------------------
# Debounced manual-edit trigger
# ---------------------------------------------------------------------------
#
# A manual ledger edit (add / edit / delete a transaction) should republish, but
# users often make several edits in a row. Re-arming a single timer on every edit
# coalesces a burst into one upload ``MANUAL_EDIT_DEBOUNCE_SECONDS`` after the
# *last* edit. The timer runs in a daemon thread (its own DB session), so it
# never blocks the UI and dies with the process.
_debounce_lock = threading.Lock()
_debounce_state: dict[str, threading.Timer | None] = {"timer": None}


def schedule_publish_after_edit(delay: float = MANUAL_EDIT_DEBOUNCE_SECONDS) -> None:
    """(Re)arm the debounced manual-edit republish; never raises.

    Each call cancels any pending timer and starts a fresh one, so a flurry of
    manual edits results in a single publish ``delay`` seconds after the last
    edit. The publish is still gated by Settings at fire time.
    """
    with _debounce_lock:
        pending = _debounce_state["timer"]
        if pending is not None:
            pending.cancel()
        timer = threading.Timer(delay, _fire_manual_edit)
        timer.daemon = True
        _debounce_state["timer"] = timer
        timer.start()


def cancel_pending_edit_publish() -> None:
    """Cancel any pending debounced manual-edit publish (e.g. on shutdown)."""
    with _debounce_lock:
        pending = _debounce_state["timer"]
        if pending is not None:
            pending.cancel()
            _debounce_state["timer"] = None


def _fire_manual_edit() -> None:  # pragma: no cover - timer thread glue
    """Timer callback: publish the debounced manual-edit snapshot."""
    with _debounce_lock:
        _debounce_state["timer"] = None
    try:
        run_trigger(TRIGGER_MANUAL_EDIT)
    except Exception:  # pragma: no cover - defensive; run_trigger never raises
        log.warning("auto-publish: debounced manual-edit publish failed", exc_info=False)
