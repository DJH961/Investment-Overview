"""SQLite/SQLCipher integrity-check and verified-backup helpers."""

from __future__ import annotations

import logging
from contextlib import closing
from datetime import datetime
from pathlib import Path

from investment_dashboard.storage.encryption import EncryptionConfig, connect_sqlite

log = logging.getLogger(__name__)


class IntegrityCheckError(RuntimeError):
    """Raised when ``PRAGMA integrity_check`` does not return ``ok``."""


#: Back-compat alias for older imports (kept for one release cycle).
IntegrityCheckFailed = IntegrityCheckError


def integrity_check(db_path: Path, *, encryption: EncryptionConfig | None = None) -> str:
    """Return ``'ok'`` or raise :class:`IntegrityCheckFailed`.

    A missing file (e.g. first boot before migrations run) returns
    ``'missing'`` and *does not* raise — callers should treat that as
    "create me" rather than "corrupted".
    """
    if db_path.as_posix() == ":memory:":
        return "ok"
    if not db_path.exists():
        return "missing"
    with closing(connect_sqlite(db_path, encryption)) as conn:
        row = conn.execute("PRAGMA integrity_check").fetchone()
    if row is None or row[0] != "ok":
        raise IntegrityCheckFailed(f"integrity_check on {db_path}: {row!r}")
    return "ok"


def backup_database(
    db_path: Path,
    dest_path: Path,
    *,
    encryption: EncryptionConfig | None = None,
) -> Path:
    """Make a SQLite-safe online backup of ``db_path`` to ``dest_path``.

    Uses ``sqlite3.Connection.backup`` (which under the hood is the
    ``sqlite3_backup_*`` C API), so it is safe against a database
    that is being written to concurrently.
    """
    if not db_path.exists():
        raise FileNotFoundError(db_path)
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    with (
        closing(connect_sqlite(db_path, encryption)) as src,
        closing(connect_sqlite(dest_path, encryption)) as dst,
    ):
        src.backup(dst)
    return dest_path


def timestamp_suffix(now: datetime | None = None) -> str:
    """Return a ``YYYYMMDD-HHMMSS`` suffix for backup filenames."""
    now = now or datetime.now()
    return now.strftime("%Y%m%d-%H%M%S")
