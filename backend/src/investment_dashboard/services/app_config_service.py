"""Key/value settings access routed through the config tier.

Every settings service reads and writes ``app_config`` through here, so the
right tier session is used in split-DB layouts (the caller's session is reused
unchanged in single-file mode).

Every write bumps :func:`write_version` (now and again when the session
commits), so ``settings_service`` can drop its process-local cache.
"""

from __future__ import annotations

import itertools
import threading

from sqlalchemy import event
from sqlalchemy.orm import Session

from investment_dashboard.db import config_read_session, config_write_session
from investment_dashboard.repositories import app_config_repo

_counter = itertools.count(1)
_version_lock = threading.Lock()
_version = {"n": 0}


def write_version() -> int:
    """Changes whenever ``app_config`` may have changed in this process."""
    return _version["n"]


def _bump(*_args: object) -> None:
    with _version_lock:
        _version["n"] = next(_counter)


def note_write(session: Session) -> None:
    """Record a write made directly through ``app_config_repo`` on ``session``."""
    _bump()
    if not event.contains(session, "after_commit", _bump):
        event.listen(session, "after_commit", _bump, once=True)


def get(session: Session, key: str) -> str | None:
    with config_read_session(session) as cfg:
        return app_config_repo.get(cfg, key)


def get_many(session: Session, keys: list[str]) -> dict[str, str | None]:
    with config_read_session(session) as cfg:
        return app_config_repo.get_many(cfg, keys)


def set_value(session: Session, key: str, value: str | None) -> None:
    with config_write_session(session) as cfg:
        app_config_repo.set_value(cfg, key, value)
        note_write(cfg)


def delete_key(session: Session, key: str) -> bool:
    with config_write_session(session) as cfg:
        removed = app_config_repo.delete_key(cfg, key)
        note_write(cfg)
        return removed


def delete_by_prefix(session: Session, prefix: str) -> int:
    with config_write_session(session) as cfg:
        removed = app_config_repo.delete_by_prefix(cfg, prefix)
        note_write(cfg)
        return removed
