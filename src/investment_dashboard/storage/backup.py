"""Rolling-backup service for the ledger and config tiers.

Per the v2.0 plan §5.4 we keep:

* The last ``N=24`` hourly backups.
* The last ``14`` daily backups.
* The last ``12`` monthly backups.

The cache tier is *not* backed up — it is local-only derived data.

Backup filenames look like::

    <stem>-<bucket>-YYYYMMDD-HHMMSS.sqlite

where ``<bucket>`` is one of ``hourly`` / ``daily`` / ``monthly``.
This makes pruning trivial: list, sort, drop everything past the cap.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from investment_dashboard.storage.encryption import EncryptionConfig, connect_sqlite
from investment_dashboard.storage.integrity import (
    backup_database,
    integrity_check,
    timestamp_suffix,
)

log = logging.getLogger(__name__)

_BACKUP_DIR_NAME = "backups"
_FILENAME_RE = re.compile(
    r"^(?P<stem>.+)-(?P<bucket>hourly|daily|monthly)-"
    r"(?P<ts>\d{8}-\d{6})\.sqlite$"
)


@dataclass(frozen=True)
class RetentionPolicy:
    """How many backups to keep per bucket."""

    hourly: int = 24
    daily: int = 14
    monthly: int = 12


def _backup_dir_for(db_path: Path) -> Path:
    return db_path.parent / _BACKUP_DIR_NAME


def _list_bucket(backup_dir: Path, stem: str, bucket: str) -> list[Path]:
    if not backup_dir.exists():
        return []
    items: list[Path] = []
    for child in backup_dir.iterdir():
        m = _FILENAME_RE.match(child.name)
        if m and m.group("stem") == stem and m.group("bucket") == bucket:
            items.append(child)
    items.sort(key=lambda p: p.name)
    return items


def _prune(backup_dir: Path, stem: str, bucket: str, keep: int) -> int:
    items = _list_bucket(backup_dir, stem, bucket)
    to_remove = items[:-keep] if keep > 0 else items
    removed = 0
    for old in to_remove:
        try:
            old.unlink()
            removed += 1
        except OSError:
            log.warning("failed to remove old backup %s", old, exc_info=True)
    return removed


def _bucket_for(now: datetime, last_daily: datetime | None, last_monthly: datetime | None) -> str:
    """Promote a snapshot to ``daily`` or ``monthly`` when the bucket rolls over."""
    if last_monthly is None or now.month != last_monthly.month or now.year != last_monthly.year:
        return "monthly"
    if last_daily is None or now.date() != last_daily.date():
        return "daily"
    return "hourly"


def _latest_ts(backup_dir: Path, stem: str, bucket: str) -> datetime | None:
    items = _list_bucket(backup_dir, stem, bucket)
    if not items:
        return None
    m = _FILENAME_RE.match(items[-1].name)
    if m is None:  # pragma: no cover - regex matched above
        return None
    return datetime.strptime(m.group("ts"), "%Y%m%d-%H%M%S")


def snapshot(
    db_path: Path,
    *,
    policy: RetentionPolicy | None = None,
    now: datetime | None = None,
    encryption: EncryptionConfig | None = None,
) -> Path | None:
    """Snapshot ``db_path`` into ``<dir>/backups/`` and prune old files.

    Returns the new backup path, or ``None`` if ``db_path`` does not
    exist yet (first boot before migrations run).
    """
    if not db_path.exists():
        return None
    policy = policy or RetentionPolicy()
    now = now or datetime.now()
    backup_dir = _backup_dir_for(db_path)
    backup_dir.mkdir(parents=True, exist_ok=True)
    stem = db_path.stem
    bucket = _bucket_for(
        now,
        _latest_ts(backup_dir, stem, "daily"),
        _latest_ts(backup_dir, stem, "monthly"),
    )
    dest = backup_dir / f"{stem}-{bucket}-{timestamp_suffix(now)}.sqlite"
    backup_database(db_path, dest, encryption=encryption)
    _prune(backup_dir, stem, "hourly", policy.hourly)
    _prune(backup_dir, stem, "daily", policy.daily)
    _prune(backup_dir, stem, "monthly", policy.monthly)
    return dest


def verify_backup(
    backup_path: Path,
    *,
    encryption: EncryptionConfig | None = None,
) -> dict[str, int]:
    """Integrity-check a backup and return a row-count manifest per table."""
    integrity_check(backup_path, encryption=encryption)
    from contextlib import closing  # noqa: PLC0415

    counts: dict[str, int] = {}
    with closing(connect_sqlite(backup_path, encryption)) as conn:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).fetchall()
        for (name,) in rows:
            (n,) = conn.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()
            counts[name] = int(n)
    return counts
