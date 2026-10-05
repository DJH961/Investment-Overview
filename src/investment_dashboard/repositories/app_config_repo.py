"""App-config repository — typed access to the key/value ``app_config`` table.

Used by services that persist single-user preferences such as the display
currency. Keys are free-form strings; values are stored as ``Text`` and
parsed/serialised by the caller.
"""

from __future__ import annotations

from sqlalchemy import delete
from sqlalchemy.orm import Session

from investment_dashboard.models import AppConfig


def get(session: Session, key: str) -> str | None:
    """Return the raw value for ``key`` or ``None`` if not set."""
    row = session.get(AppConfig, key)
    return None if row is None else row.value


def set_value(session: Session, key: str, value: str | None) -> None:
    """Upsert a value. Pass ``value=None`` to clear it (sets to NULL)."""
    row = session.get(AppConfig, key)
    if row is None:
        row = AppConfig(key=key, value=value)
        session.add(row)
    else:
        row.value = value
    session.flush()


def delete_key(session: Session, key: str) -> bool:
    """Delete a key from ``app_config``. Returns True if a row was deleted."""
    row = session.get(AppConfig, key)
    if row is not None:
        session.delete(row)
        session.flush()
        return True
    return False


def delete_by_prefix(session: Session, prefix: str) -> int:
    """Delete all keys starting with ``prefix``. Returns rows removed."""
    result = session.execute(delete(AppConfig).where(AppConfig.key.startswith(prefix)))
    session.flush()
    return int(result.rowcount or 0)
