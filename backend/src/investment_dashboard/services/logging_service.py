"""Logging-verbosity service — a user-facing knob for how much the app logs.

By default the app logs at ``INFO`` (see :class:`~investment_dashboard.config.Settings`
``log_level``). When something misbehaves — a price that won't update, a graph
that looks wrong — the most useful thing a user can do is flip on **verbose**
(``DEBUG``) logging, reproduce the problem, and grab the log file / support
bundle. Previously that required setting an environment variable and restarting,
which is a non-starter for a desktop app with no console.

This service persists the chosen level in ``app_config`` (key
:data:`_CONFIG_KEY`) and applies it to the **root logger** immediately, so the
change takes effect without a restart and survives the next boot
(:func:`apply_persisted_log_level`, wired into the boot sequence).

The environment / ``Settings.log_level`` still sets the *initial* level at
process start (see :func:`investment_dashboard.logging.configure_logging`); a
persisted override here, when present, takes precedence once the database is up.
"""

from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from investment_dashboard.repositories import app_config_repo

log = logging.getLogger(__name__)

_CONFIG_KEY = "log_level"

#: The verbosity choices we expose, coarsest first. We deliberately surface only
#: the two levels a user actually reaches for — ``INFO`` (the normal, readable
#: default) and ``DEBUG`` (verbose: every data pull, calculation and internal
#: step). ``WARNING`` is kept as an accepted value for power users who set it via
#: the environment, but it is not offered in the picker.
LEVELS: tuple[str, ...] = ("INFO", "DEBUG")

#: Human labels for the picker, mapped to the logging level name.
LEVEL_LABELS: dict[str, str] = {
    "INFO": "Normal",
    "DEBUG": "Verbose (debug)",
}

DEFAULT_LEVEL = "INFO"


def _normalise(value: str | None) -> str | None:
    """Return a recognised, upper-cased level name, or ``None`` if invalid."""
    if value is None:
        return None
    candidate = value.strip().upper()
    if candidate in logging.getLevelNamesMapping():
        return candidate
    return None


def get_log_level(session: Session) -> str:
    """Return the persisted log level, or the configured default.

    Falls back to :data:`~investment_dashboard.config.Settings.log_level` (the
    environment / first-run default) when nothing has been chosen in the UI yet.
    """
    persisted = _normalise(app_config_repo.get(session, _CONFIG_KEY))
    if persisted is not None:
        return persisted
    from investment_dashboard.config import get_settings  # noqa: PLC0415

    return _normalise(get_settings().log_level) or DEFAULT_LEVEL


def set_log_level(session: Session, level: str) -> str:
    """Persist ``level``, apply it to the root logger live, and return it.

    Raises ``ValueError`` for an unrecognised level so the caller can surface a
    clear message rather than silently storing junk.
    """
    normalised = _normalise(level)
    if normalised is None:
        raise ValueError(f"Unknown log level {level!r}")
    app_config_repo.set_value(session, _CONFIG_KEY, normalised)
    _apply(normalised)
    log.info("log level set to %s", normalised)
    return normalised


def _apply(level: str) -> None:
    """Set the root logger's effective level (affects both sinks)."""
    logging.getLogger().setLevel(level)


def apply_persisted_log_level() -> None:
    """Apply any persisted log level to the root logger (best-effort).

    Called from the boot sequence once the config database is reachable, so a
    user's verbose-logging choice survives restarts. A missing/empty value or an
    unreadable config tier simply leaves the boot-time level
    (:func:`configure_logging`) in place.
    """
    try:
        from investment_dashboard.db import config_session_scope  # noqa: PLC0415

        with config_session_scope() as session:
            persisted = _normalise(app_config_repo.get(session, _CONFIG_KEY))
        if persisted is not None:
            _apply(persisted)
            log.info("applied persisted log level: %s", persisted)
    except Exception:  # pragma: no cover - defensive: never block boot on this
        log.debug("could not apply persisted log level", exc_info=True)
