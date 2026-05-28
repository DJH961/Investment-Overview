"""Stray ``-wal`` / ``-shm`` sidecar detection and repair.

When a SQLite file lives in a cloud-sync folder (OneDrive, iCloud,
Dropbox, Google Drive), the per-connection WAL/SHM sidecar files are
**not safe** to sync — the cloud client will happily rewrite them in
the middle of a SQLite write, corrupting the database.

The v2.0 plan §5.2 mitigates this by:

1. Switching journal mode from ``WAL`` to ``TRUNCATE`` for files in
   detected cloud folders. ``TRUNCATE`` keeps the journal inside one
   file that is zero-length at rest and cleaned up on commit. The
   pragma listener in ``db.py`` consults
   :func:`should_use_truncate_journal` to decide which mode to set.
2. Scanning the ledger and config directories at boot for stray
   ``*.sqlite-wal`` / ``*.sqlite-shm`` files. If any are found the
   app refuses to open the DB and asks the user to run
   ``inv-dashboard repair-sidecar``.
"""

from __future__ import annotations

import logging
import sqlite3
from dataclasses import dataclass
from pathlib import Path

from investment_dashboard.storage.cloud import path_is_in_cloud_folder

log = logging.getLogger(__name__)


class StraySidecarError(RuntimeError):
    """Raised when stray WAL/SHM sidecars are found alongside a synced DB."""


@dataclass(frozen=True)
class SidecarReport:
    """Sidecars discovered for one DB file."""

    db_path: Path
    wal: Path | None
    shm: Path | None

    @property
    def found(self) -> bool:
        return self.wal is not None or self.shm is not None


def should_use_truncate_journal(db_path: Path) -> bool:
    """Return ``True`` when ``db_path`` lives in a known cloud folder.

    Callers that lay down the SQLite pragma sequence should use
    ``PRAGMA journal_mode=TRUNCATE`` instead of ``WAL`` in that case.
    """
    if db_path.as_posix() == ":memory:":
        return False
    return path_is_in_cloud_folder(db_path) is not None


def scan_sidecars(db_path: Path) -> SidecarReport:
    """Look for ``-wal`` and ``-shm`` siblings next to ``db_path``."""
    wal = db_path.with_name(db_path.name + "-wal")
    shm = db_path.with_name(db_path.name + "-shm")
    return SidecarReport(
        db_path=db_path,
        wal=wal if wal.exists() else None,
        shm=shm if shm.exists() else None,
    )


def assert_no_sidecars_in_cloud(db_paths: list[Path]) -> None:
    """Raise :class:`StraySidecarError` if any cloud-located DB has sidecars.

    Sidecars next to a *local* DB are fine — SQLite manages them
    cleanly with no sync engine in between. Only the cloud case is
    fatal.
    """
    offenders: list[SidecarReport] = []
    for db_path in db_paths:
        if not should_use_truncate_journal(db_path):
            continue
        report = scan_sidecars(db_path)
        if report.found:
            offenders.append(report)
    if not offenders:
        return
    lines = [
        "Stray SQLite WAL/SHM sidecar files were found inside a known "
        "cloud-sync folder. Cloud clients can corrupt these files "
        "mid-write. Run `inv-dashboard repair-sidecar` to integrity-check "
        "and clean them up.",
    ]
    for report in offenders:
        for sidecar in (report.wal, report.shm):
            if sidecar is not None:
                lines.append(f"  - {sidecar}")
    raise StraySidecarError("\n".join(lines))


def repair_sidecars(db_path: Path) -> SidecarReport:
    """Integrity-check ``db_path`` and remove its WAL/SHM siblings.

    The function opens a short-lived SQLite connection so SQLite has
    a chance to checkpoint-and-truncate any honest, in-flight WAL
    (the common case after a crash). If integrity check fails the
    sidecars are *not* deleted and the caller can fall back to a
    backup.
    """
    report = scan_sidecars(db_path)
    if not report.found:
        return report
    # First: open and integrity-check; this also forces a checkpoint.
    conn = sqlite3.connect(db_path)
    try:
        result = conn.execute("PRAGMA integrity_check").fetchone()
        if result is None or result[0] != "ok":
            raise StraySidecarError(
                f"integrity_check on {db_path} returned {result!r}; "
                "refusing to delete sidecars. Restore from a backup."
            )
        # Force a full checkpoint then switch to TRUNCATE so subsequent
        # opens don't recreate -wal/-shm.
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.execute("PRAGMA journal_mode=TRUNCATE")
    finally:
        conn.close()
    # Now remove anything that survived.
    refreshed = scan_sidecars(db_path)
    for sidecar in (refreshed.wal, refreshed.shm):
        if sidecar is not None:
            try:
                sidecar.unlink()
            except OSError:
                log.warning("failed to delete sidecar %s", sidecar, exc_info=True)
    return scan_sidecars(db_path)
