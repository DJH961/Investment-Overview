"""Effective settings: read, change, reset, audit, export and import.

Precedence per key: **value stored in the app > env var (when the setting names
one and it was set) > registry default**. Settings with ``env_bound`` treat the
env value as a ceiling/floor the app can only tighten.

* :func:`get` returns the typed effective value. With a ``session`` it reads
  through that session (sees uncommitted writes); without one it uses a small
  process-local cache, refreshed whenever ``app_config`` is written in this
  process (``app_config_service.write_version``) and at least every
  :data:`CACHE_TTL_SECONDS` (CLI writes from another process). A read failure
  never breaks the caller: it falls back to env/default.
* :func:`set_many` validates every change first (per-key errors), then writes
  all of them and their audit rows in one transaction, publishes a ``settings``
  event and runs the ``on_change`` hooks.
* Secrets are write-only: :func:`values` reports only ``{"set": bool}``, audit
  rows hold ``<redacted>``, and :func:`export_json` leaves them out.

Layering: services/readmodels call this; domain and adapters never do (values
are passed in as parameters).
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from sqlalchemy.orm import Session

from investment_dashboard.activity_log import activity
from investment_dashboard.config import get_settings
from investment_dashboard.db import (
    config_read_session,
    config_session_scope,
    config_write_session,
)
from investment_dashboard.domain import settings_schema as schema
from investment_dashboard.domain.settings_schema import SettingDef, SettingError, Typed
from investment_dashboard.errors import NotFoundError, ValidationError
from investment_dashboard.repositories import app_config_repo, settings_audit_repo
from investment_dashboard.services import app_config_service, live_bus
from investment_dashboard.services import settings_registry as registry

log = logging.getLogger(__name__)

CACHE_TTL_SECONDS = 60.0
REDACTED = "<redacted>"
EXPORT_KIND = "inv-dashboard-settings"
Source = Literal["db", "env", "default"]


class SettingsValidationError(ValidationError):
    """One or more changes are invalid; ``errors`` maps key -> message (422)."""

    def __init__(self, errors: dict[str, str]) -> None:
        super().__init__("; ".join(f"{k}: {v}" for k, v in errors.items()))
        self.errors = errors


@dataclass(frozen=True)
class Effective:
    key: str
    value: Typed
    source: Source
    env_value_present: bool
    stored_invalid: bool = False


# -- cache -------------------------------------------------------------------------

_cache_lock = threading.Lock()
_cache: dict[str, Any] = {"version": -1, "loaded_at": 0.0, "raw": {}}


def invalidate() -> None:
    with _cache_lock:
        _cache["version"] = -1


def _raw_values(session: Session | None) -> dict[str, str | None]:
    keys = list(registry.BY_KEY)
    if session is not None:
        return app_config_service.get_many(session, keys)
    version = app_config_service.write_version()
    now = time.monotonic()
    with _cache_lock:
        fresh = _cache["version"] == version and now - _cache["loaded_at"] < CACHE_TTL_SECONDS
        if fresh:
            return dict(_cache["raw"])
    try:
        with config_session_scope() as cfg:
            raw = app_config_service.get_many(cfg, keys)
    except Exception:
        log.debug("settings read failed; using env/defaults", exc_info=True)
        return {}
    with _cache_lock:
        _cache.update(version=version, loaded_at=now, raw=dict(raw))
    return raw


# -- resolution ----------------------------------------------------------------------


def _env_value(defn: SettingDef) -> Typed:
    if defn.env_var is None:
        return None
    settings = get_settings()
    if defn.env_var not in settings.model_fields_set:
        return None
    raw = getattr(settings, defn.env_var, None)
    if raw is None or raw == "":
        return None
    try:
        return schema.coerce(defn, raw)
    except SettingError:
        log.warning("env value for %s is invalid; ignored", defn.key)
        return None


def _resolve(defn: SettingDef, stored: str | None) -> Effective:
    env_value = _env_value(defn)
    present = env_value is not None
    invalid = False
    if stored is not None:
        try:
            value = schema.parse(defn, stored)
        except SettingError:
            invalid = True  # a hand-edited bad row: fall back, and say so
        else:
            return Effective(defn.key, schema.bounded(defn, value, env_value), "db", present)
    if present:
        return Effective(defn.key, env_value, "env", True, invalid)
    return Effective(defn.key, defn.default, "default", False, invalid)


def effective(key: str, session: Session | None = None) -> Effective:
    defn = registry.get_def(key)
    return _resolve(defn, _raw_values(session).get(key))


def get(key: str, session: Session | None = None) -> Any:
    """The typed effective value of ``key`` (see the module doc for precedence)."""
    return effective(key, session).value


def get_or(key: str, fallback: Any, session: Session | None = None) -> Any:
    """The value set in the app or env, else ``fallback`` (also on any error).

    For wiring module constants: the constant stays the effective default (the
    registry default equals it, a test checks that), so code and tests that
    patch the constant keep working.
    """
    try:
        eff = effective(key, session)
    except Exception:
        log.debug("setting %s unreadable; using %r", key, fallback, exc_info=True)
        return fallback
    return fallback if eff.source == "default" else eff.value


def get_all(session: Session | None = None) -> dict[str, Effective]:
    raw = _raw_values(session)
    return {k: _resolve(d, raw.get(k)) for k, d in registry.BY_KEY.items()}


# -- API views --------------------------------------------------------------------


def _json_view(defn: SettingDef, value: Typed) -> Any:
    if defn.secret:
        return None
    return schema.to_json(value)


def schema_view() -> dict[str, Any]:
    """Sections and field metadata for the generic Settings form."""
    fields = []
    for d in registry.DEFS:
        fields.append(
            {
                "key": d.key,
                "type": d.type.value,
                "section": d.section,
                "label": d.label,
                "help": d.help,
                "default": _json_view(d, d.default),
                "min": None if d.min is None else format(d.min, "f"),
                "max": None if d.max is None else format(d.max, "f"),
                "choices": list(d.choices),
                "level": d.level,
                "secret": d.secret,
                "nullable": d.nullable,
                "restart_required": d.restart_required,
                "env_var": f"INV_DASHBOARD_{d.env_var.upper()}" if d.env_var else None,
                "env_bound": d.env_bound,
                "danger": d.danger,
                "unit": d.unit,
                "since": d.since,
            }
        )
    return {
        "sections": [{"id": k, "label": v} for k, v in registry.SECTIONS.items()],
        "fields": fields,
    }


def values(session: Session) -> dict[str, dict[str, Any]]:
    """``{key: {value, source, default, env_value_present, modified_at, is_set}}``."""
    with _same(session) as cfg:
        changed = settings_audit_repo.last_changed(cfg, list(registry.BY_KEY))
    out: dict[str, dict[str, Any]] = {}
    for key, eff in get_all(session).items():
        defn = registry.BY_KEY[key]
        out[key] = {
            "value": _json_view(defn, eff.value),
            "source": eff.source,
            "default": _json_view(defn, defn.default),
            "env_value_present": eff.env_value_present,
            "modified_at": changed.get(key),
            "is_set": eff.value is not None,
            "stored_invalid": eff.stored_invalid,
        }
    return out


@contextmanager
def _same(session: Session) -> Iterator[Session]:
    with config_read_session(session) as cfg:
        yield cfg


# -- writes -----------------------------------------------------------------------


def _audit_text(defn: SettingDef, stored: str | None) -> str | None:
    if stored is None:
        return None
    return REDACTED if defn.secret else stored


def validate(changes: Mapping[str, Any], session: Session | None = None) -> dict[str, Typed]:
    """Typed values for ``changes``; raises :class:`SettingsValidationError`."""
    errors: dict[str, str] = {}
    typed: dict[str, Typed] = {}
    for key, raw in changes.items():
        defn = registry.BY_KEY.get(key)
        if defn is None:
            errors[key] = "unknown setting"
            continue
        try:
            typed[key] = schema.coerce(defn, raw)
        except SettingError as exc:
            errors[key] = str(exc).removeprefix(f"{key}: ")
    if not errors:
        merged = {k: e.value for k, e in get_all(session).items()}
        merged.update(typed)
        for check in registry.GROUP_CHECKS:
            # Only checks touching a changed key can block (an old bad combo
            # must not stop unrelated edits).
            for key, msg in check(merged).items():
                if key in typed:
                    errors.setdefault(key, msg)
    if errors:
        raise SettingsValidationError(errors)
    return typed


def _write(
    session: Session | None,
    stored: Mapping[str, str | None],
    *,
    actor: str,
    action: str,
    request_id: str | None,
) -> list[str]:
    """Write/delete rows + audit in one transaction; returns the changed keys."""
    changed: list[str] = []

    @contextmanager
    def scope() -> Iterator[Session]:
        if session is None:
            with config_session_scope() as s:
                yield s
        else:
            with config_write_session(session) as s:
                yield s

    now = datetime.now(UTC).replace(tzinfo=None)
    with scope() as cfg:
        current = app_config_repo.get_many(cfg, list(stored))
        for key, new in stored.items():
            old = current.get(key)
            if old == new:
                continue
            defn = registry.BY_KEY[key]
            if new is None:
                app_config_repo.delete_key(cfg, key)
            else:
                app_config_repo.set_value(cfg, key, new)
            app_config_service.note_write(cfg)
            settings_audit_repo.add(
                cfg,
                key=key,
                old_value=_audit_text(defn, old),
                new_value=_audit_text(defn, new),
                changed_at=now,
                actor=actor,
                action=action,
                request_id=request_id,
            )
            changed.append(key)
        if changed:
            settings_audit_repo.prune(cfg)
    return changed


def _after_write(changed: list[str], *, actor: str, action: str) -> None:
    invalidate()
    if not changed:
        return
    activity("changes").info("settings %s by %s: %s", action, actor, ", ".join(sorted(changed)))
    try:
        live_bus.bus.publish(
            {"type": "settings", "ts": datetime.now(UTC).isoformat(), "keys": sorted(changed)}
        )
    except Exception:  # pragma: no cover - the bus never blocks a write
        log.debug("settings event not published", exc_info=True)
    for key in changed:
        hook = registry.ON_CHANGE.get(key)
        if hook is None:
            continue
        try:
            hook(get(key))
        except Exception:
            log.warning("on_change hook for %s failed", key, exc_info=True)


def set_many(
    changes: Mapping[str, Any],
    *,
    actor: str,
    action: str = "set",
    request_id: str | None = None,
    session: Session | None = None,
) -> list[str]:
    """Validate all of ``changes``, then store them together. Returns changed keys.

    A ``None`` value for a nullable setting clears it (back to env/default).
    """
    typed = validate(changes, session)
    stored = {k: schema.dump(registry.BY_KEY[k], v) for k, v in typed.items()}
    changed = _write(session, stored, actor=actor, action=action, request_id=request_id)
    _after_write(changed, actor=actor, action=action)
    return changed


def reset(
    *,
    keys: list[str] | None = None,
    section: str | None = None,
    everything: bool = False,
    actor: str,
    request_id: str | None = None,
    session: Session | None = None,
) -> list[str]:
    """Delete stored values so env/default applies again. Returns changed keys."""
    targets: list[str] = []
    if everything:
        targets = list(registry.BY_KEY)
    if section is not None:
        if section not in registry.SECTIONS:
            raise SettingsValidationError({"section": f"unknown section {section!r}"})
        targets += [d.key for d in registry.DEFS if d.section == section]
    unknown = [k for k in keys or [] if k not in registry.BY_KEY]
    if unknown:
        raise SettingsValidationError(dict.fromkeys(unknown, "unknown setting"))
    targets += list(keys or [])
    stored = dict.fromkeys(dict.fromkeys(targets), None)
    changed = _write(session, stored, actor=actor, action="reset", request_id=request_id)
    _after_write(changed, actor=actor, action="reset")
    return changed


def history(
    *, key: str | None = None, limit: int = 100, session: Session | None = None
) -> list[settings_audit_repo.AuditRow]:
    if session is None:
        with config_session_scope() as cfg:
            return settings_audit_repo.history(cfg, key=key, limit=limit)
    with _same(session) as cfg:
        return settings_audit_repo.history(cfg, key=key, limit=limit)


def revert(
    audit_id: int, *, actor: str, request_id: str | None = None, session: Session | None = None
) -> list[str]:
    """Put a key back to the value it had before change ``audit_id``."""
    if session is None:
        with config_session_scope() as cfg:
            row = settings_audit_repo.get(cfg, audit_id)
    else:
        with _same(session) as cfg:
            row = settings_audit_repo.get(cfg, audit_id)
    if row is None:
        raise NotFoundError(f"settings change {audit_id} not found")
    defn = registry.BY_KEY.get(row.key)
    if defn is None:
        raise SettingsValidationError({row.key: "this setting no longer exists"})
    if defn.secret:
        raise SettingsValidationError({row.key: "secret values cannot be reverted"})
    if row.old_value is not None:
        try:
            schema.parse(defn, row.old_value)
        except SettingError as exc:
            raise SettingsValidationError({row.key: str(exc)}) from exc
    changed = _write(
        session, {row.key: row.old_value}, actor=actor, action="revert", request_id=request_id
    )
    _after_write(changed, actor=actor, action="revert")
    return changed


# -- export / import --------------------------------------------------------------


def export_json(session: Session | None = None) -> dict[str, Any]:
    """Every value stored in the app (not env/default), secrets left out."""
    out = {
        key: schema.to_json(eff.value)
        for key, eff in get_all(session).items()
        if eff.source == "db" and not registry.BY_KEY[key].secret
    }
    return {
        "kind": EXPORT_KIND,
        "version": 1,
        "exported_at": datetime.now(UTC).isoformat(),
        "settings": out,
    }


def import_json(
    payload: Mapping[str, Any],
    *,
    dry_run: bool,
    actor: str,
    request_id: str | None = None,
    session: Session | None = None,
) -> list[dict[str, Any]]:
    """Diff (and unless ``dry_run`` apply) an :func:`export_json` payload.

    Returns ``[{key, current, new}]`` for every key whose value would change.
    Secrets in the payload are refused.
    """
    if payload.get("kind") != EXPORT_KIND or not isinstance(payload.get("settings"), dict):
        raise SettingsValidationError({"payload": "not a settings export"})
    incoming: dict[str, Any] = payload["settings"]
    secret = [k for k in incoming if k in registry.BY_KEY and registry.BY_KEY[k].secret]
    if secret:
        raise SettingsValidationError(dict.fromkeys(secret, "secrets cannot be imported"))
    typed = validate(incoming, session)
    current = get_all(session)
    diff = [
        {"key": k, "current": schema.to_json(current[k].value), "new": schema.to_json(v)}
        for k, v in typed.items()
        if current[k].value != v or current[k].source != "db"
    ]
    if not dry_run and diff:
        set_many(
            {d["key"]: d["new"] for d in diff},
            actor=actor,
            action="import",
            request_id=request_id,
            session=session,
        )
    return diff
