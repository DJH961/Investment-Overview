"""Sealed database snapshots: create, list, prune, unseal (v6 D3).

A snapshot is a consistent copy of the database (SQLite online-backup API, safe
while the app writes) sealed with :mod:`storage.blob_crypto` (AES-256-GCM,
PBKDF2) into one JSON file in the backup directory (``/data/backups`` in the
container). The ``backup`` compose sidecar copies that directory to Backblaze B2;
``inv-dashboard-restore`` brings a snapshot back.

The seal passphrase comes from ``INV_DASHBOARD_BACKUP_PASSPHRASE`` and falls back
to the database passphrase. The snapshot also contains the SQLCipher-encrypted
database file, so a restore needs the database passphrase as well.

Snapshots are taken ~1 minute after the first durable write (see the dirty flag
in :mod:`db`) and at least nightly. Retention keeps the newest snapshot of each of
the last N hours / days / months. All three are in-app settings
(``backup.debounce_seconds``, ``backup.nightly_hours``, ``backup.retention.*``);
the constants below are their defaults and the fallback.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import tempfile
from contextlib import closing
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from investment_dashboard import db as db_module
from investment_dashboard.config import get_settings
from investment_dashboard.errors import UpstreamError
from investment_dashboard.storage import blob_crypto
from investment_dashboard.storage.atomic_io import atomic_write_text
from investment_dashboard.storage.encryption import (
    EncryptionConfig,
    connect_sqlite,
)
from investment_dashboard.storage.integrity import backup_database, integrity_check

log = logging.getLogger(__name__)

ENV_BACKUP_PASSPHRASE = "INV_DASHBOARD_BACKUP_PASSPHRASE"
ENV_BACKUP_DIR = "INV_DASHBOARD_BACKUP_DIR"

SNAPSHOT_KIND = "inv-dashboard-snapshot"
SNAPSHOT_SUFFIX = ".sealed.json"
_NAME_RE = re.compile(r"^snapshot-(\d{8}-\d{6})\.sealed\.json$")

#: Wait this long after the first unbacked-up write (coalesces bursts).
DEBOUNCE_SECONDS = 60.0
#: Take a snapshot at least this often even when nothing changed.
NIGHTLY_SECONDS = 24 * 3600.0


class SnapshotError(UpstreamError):
    """A snapshot is unreadable, tampered, or failed verification."""


@dataclass(frozen=True)
class Retention:
    hourly: int = 24
    daily: int = 14
    monthly: int = 12


@dataclass(frozen=True)
class SnapshotInfo:
    path: Path
    created: datetime


def _setting(key: str, fallback: Any) -> Any:
    from investment_dashboard.services import settings_service  # noqa: PLC0415

    try:
        return settings_service.get(key)
    except Exception:
        return fallback


def configured_retention() -> Retention:
    """The retention policy from settings (defaults: :class:`Retention`)."""
    base = Retention()
    return Retention(
        hourly=int(_setting("backup.retention.hourly", base.hourly)),
        daily=int(_setting("backup.retention.daily", base.daily)),
        monthly=int(_setting("backup.retention.monthly", base.monthly)),
    )


def debounce_seconds() -> float:
    return float(_setting("backup.debounce_seconds", DEBOUNCE_SECONDS))


def nightly_seconds() -> float:
    return float(_setting("backup.nightly_hours", NIGHTLY_SECONDS / 3600)) * 3600


# -- configuration -------------------------------------------------------------


def backup_dir() -> Path:
    override = os.environ.get(ENV_BACKUP_DIR)
    if override:
        return Path(override)
    return get_settings().db_path.parent / "backups"


def backup_passphrase() -> str | None:
    return os.environ.get(ENV_BACKUP_PASSPHRASE) or get_settings().db_passphrase or None


def is_configured() -> bool:
    return backup_passphrase() is not None and get_settings().db_path.exists()


# -- helpers -------------------------------------------------------------------


def row_counts(db_path: Path, encryption: EncryptionConfig | None = None) -> dict[str, int]:
    """Row count of every user table (used to verify a restore)."""
    with closing(connect_sqlite(db_path, encryption)) as conn:
        names = [
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' "
                "AND name NOT LIKE 'sqlite_%' ORDER BY name"
            )
        ]
        return {n: int(conn.execute(f'SELECT count(*) FROM "{n}"').fetchone()[0]) for n in names}


def _snapshot_name(created: datetime) -> str:
    return f"snapshot-{created.strftime('%Y%m%d-%H%M%S')}{SNAPSHOT_SUFFIX}"


def list_snapshots(directory: Path | None = None) -> list[SnapshotInfo]:
    """Snapshots in ``directory``, newest first."""
    directory = directory or backup_dir()
    if not directory.is_dir():
        return []
    found = []
    for child in directory.iterdir():
        m = _NAME_RE.match(child.name)
        if m:
            created = datetime.strptime(m.group(1), "%Y%m%d-%H%M%S").replace(tzinfo=UTC)
            found.append(SnapshotInfo(child, created))
    return sorted(found, key=lambda s: s.created, reverse=True)


def prune(directory: Path, policy: Retention | None = None) -> list[Path]:
    """Delete snapshots outside the retention policy; returns what was removed."""
    policy = policy or configured_retention()
    snaps = list_snapshots(directory)
    keep: set[Path] = set()
    for limit, fmt in (
        (policy.hourly, "%Y%m%d%H"),
        (policy.daily, "%Y%m%d"),
        (policy.monthly, "%Y%m"),
    ):
        seen: list[str] = []
        for s in snaps:  # newest first: first hit per bucket is the newest of it
            key = s.created.strftime(fmt)
            if key in seen:
                continue
            if len(seen) >= limit:
                break
            seen.append(key)
            keep.add(s.path)
    removed = []
    for s in snaps:
        if s.path not in keep:
            s.path.unlink(missing_ok=True)
            removed.append(s.path)
    return removed


def snapshot_by_name(name: str, directory: Path | None = None) -> Path:
    """The snapshot file called ``name`` (only real snapshot names; no paths)."""
    if not _NAME_RE.match(name):
        raise SnapshotError("not a snapshot name")
    for snap in list_snapshots(directory):
        if snap.path.name == name:
            return snap.path
    raise SnapshotError(f"{name} not found")


def describe_snapshots(directory: Path | None = None) -> list[dict[str, Any]]:
    """Newest first: ``{name, created, size_bytes}`` (no secrets, no unsealing)."""
    out = []
    for snap in list_snapshots(directory):
        try:
            size = snap.path.stat().st_size
        except OSError:  # pragma: no cover - vanished meanwhile
            continue
        out.append({"name": snap.path.name, "created": snap.created, "size_bytes": size})
    return out


def verify_snapshot(name: str, directory: Path | None = None) -> dict[str, Any]:
    """Unseal ``name`` into a temp folder, integrity-check it, compare row counts."""
    path = snapshot_by_name(name, directory)
    passphrase = backup_passphrase()
    if passphrase is None:
        raise SnapshotError(f"set {ENV_BACKUP_PASSPHRASE} (or the DB passphrase) to verify")
    with tempfile.TemporaryDirectory(prefix="inv-verify-") as tmp:
        out = Path(tmp) / "verify.sqlite"
        meta = unseal_snapshot(path, passphrase, out)
        encryption = db_module.get_active_encryption()
        status = integrity_check(out, encryption=encryption)
        counts = row_counts(out, encryption)
    if counts != meta.get("counts"):
        raise SnapshotError(f"{name}: row counts differ from the snapshot metadata")
    log.info("backup verified: %s", name)
    return {"name": name, "integrity": status, "tables": len(counts), "size": meta.get("size")}


# -- create --------------------------------------------------------------------


def seal_database(
    db_path: Path,
    dest: Path,
    passphrase: str,
    *,
    encryption: EncryptionConfig | None = None,
    created: datetime | None = None,
    iterations: int = blob_crypto.PBKDF2_ITERATIONS,
) -> Path:
    """Consistent copy of ``db_path`` sealed into ``dest`` (atomic write)."""
    created = created or datetime.now(UTC)
    with tempfile.TemporaryDirectory(prefix="inv-snap-") as tmp:
        copy = Path(tmp) / "copy.sqlite"
        backup_database(db_path, copy, encryption=encryption)
        integrity_check(copy, encryption=encryption)
        counts = row_counts(copy, encryption)
        raw = copy.read_bytes()
    envelope = blob_crypto.encrypt_bytes(raw, passphrase, iterations=iterations)
    envelope["kind"] = SNAPSHOT_KIND
    envelope["meta"] = {
        "created": created.isoformat(),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "size": len(raw),
        "counts": counts,
    }
    dest.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(dest, json.dumps(envelope))
    return dest


def create_snapshot(
    *,
    directory: Path | None = None,
    now: datetime | None = None,
    retain: bool = True,
    policy: Retention | None = None,
) -> Path:
    """Snapshot the live database into ``directory`` and apply retention."""
    passphrase = backup_passphrase()
    if passphrase is None:
        raise SnapshotError(f"set {ENV_BACKUP_PASSPHRASE} (or the DB passphrase) to seal backups")
    directory = directory or backup_dir()
    now = (now or datetime.now(UTC)).astimezone(UTC).replace(microsecond=0)
    dest = directory / _snapshot_name(now)
    seal_database(
        get_settings().db_path,
        dest,
        passphrase,
        encryption=db_module.get_active_encryption(),
        created=now,
    )
    if retain:
        prune(directory, policy)
    log.info("sealed backup written: %s", dest.name)
    return dest


# -- open ----------------------------------------------------------------------


def read_envelope(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise SnapshotError(f"{path.name} is not a readable snapshot: {exc}") from exc
    if not isinstance(data, dict) or data.get("kind") != SNAPSHOT_KIND:
        raise SnapshotError(f"{path.name} is not a sealed snapshot")
    return data


def unseal_snapshot(path: Path, passphrase: str, out: Path) -> dict[str, Any]:
    """Decrypt ``path`` to the plain database file ``out``; returns its metadata.

    Raises :class:`SnapshotError` for a wrong passphrase, tampering or a checksum
    mismatch. ``out`` is only written when everything matched.
    """
    envelope = read_envelope(path)
    try:
        raw = blob_crypto.decrypt_bytes(envelope, passphrase)
    except blob_crypto.EnvelopeError as exc:
        raise SnapshotError(f"{path.name}: {exc}") from exc
    meta = envelope.get("meta") or {}
    if hashlib.sha256(raw).hexdigest() != meta.get("sha256"):
        raise SnapshotError(f"{path.name}: checksum mismatch")
    out.write_bytes(raw)
    return dict(meta)


# -- scheduler hooks -----------------------------------------------------------


def last_snapshot_time() -> datetime | None:
    try:
        snaps = list_snapshots()
    except OSError:  # pragma: no cover - unreadable directory
        return None
    return snaps[0].created if snaps else None


def is_due(now: datetime) -> bool:
    """True when a dirty database has waited out the debounce, or nightly."""
    if not is_configured():
        return False
    since = db_module.dirty_since()
    if since is not None and now.timestamp() - since >= debounce_seconds():
        return True
    last = last_snapshot_time()
    return last is None or (now - last).total_seconds() >= nightly_seconds()


def run_scheduled() -> dict[str, Any] | None:
    """Scheduler job: snapshot now. A failure re-marks the database dirty."""
    db_module.clear_dirty()
    try:
        create_snapshot()
    except Exception:
        db_module.mark_dirty()
        raise
    return None
