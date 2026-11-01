"""Key/value settings access routed through the config tier.

Every settings service reads and writes ``app_config`` through here, so the
right tier session is used in split-DB layouts (the caller's session is reused
unchanged in single-file mode).
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from investment_dashboard.db import config_read_session, config_write_session
from investment_dashboard.repositories import app_config_repo


def get(session: Session, key: str) -> str | None:
    with config_read_session(session) as cfg:
        return app_config_repo.get(cfg, key)


def set_value(session: Session, key: str, value: str | None) -> None:
    with config_write_session(session) as cfg:
        app_config_repo.set_value(cfg, key, value)


def delete_key(session: Session, key: str) -> bool:
    with config_write_session(session) as cfg:
        return app_config_repo.delete_key(cfg, key)


def delete_by_prefix(session: Session, prefix: str) -> int:
    with config_write_session(session) as cfg:
        return app_config_repo.delete_by_prefix(cfg, prefix)
