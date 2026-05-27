"""App-config repository — typed access to the key/value ``app_config`` table.

Used by services that persist single-user preferences such as the display
currency. Keys are free-form strings; values are stored as ``Text`` and
parsed/serialised by the caller.
"""

from __future__ import annotations

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
