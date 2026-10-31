"""Single-writer cross-process file lock.

The v2.0 plan §5.3 requires that two devices syncing the same ledger
file via OneDrive/iCloud/Dropbox cannot both open it for writes — the
second writer would overwrite the first with no merge.

This module implements an OS-level advisory lock on a sidecar
``<ledger>.lock`` file (which itself lives next to the DB and must be
excluded from cloud sync):

* POSIX: ``fcntl.flock`` with ``LOCK_EX | LOCK_NB``.
* Windows: ``msvcrt.locking`` with ``LK_NBLCK``.

The acquisition is non-blocking. On failure the caller can either
exit or fall back to read-only mode (see ``run_boot_sequence``).
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import IO

log = logging.getLogger(__name__)


class WriteLockError(RuntimeError):
    """Raised when the writer lock cannot be acquired."""


@dataclass
class WriteLock:
    """Held writer lock; release via :meth:`release` or as a context mgr."""

    path: Path
    _fh: IO[bytes]

    def __enter__(self) -> WriteLock:
        return self

    def __exit__(self, *exc: object) -> None:
        self.release()

    def release(self) -> None:
        from contextlib import suppress  # noqa: PLC0415

        try:
            if os.name == "nt":  # pragma: no cover - platform-specific
                import msvcrt  # noqa: PLC0415

                with suppress(OSError):
                    self._fh.seek(0)
                    msvcrt.locking(self._fh.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl  # noqa: PLC0415

                with suppress(OSError):
                    fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
        finally:
            with suppress(OSError):
                self._fh.close()


def _lock_path_for(db_path: Path) -> Path:
    return db_path.with_name(db_path.name + ".lock")


def acquire_write_lock(db_path: Path) -> WriteLock:
    """Acquire a non-blocking exclusive lock on the writer lock file.

    Raises :class:`WriteLockError` if the lock is already held by
    another process (on this device, or on another device that has the
    cloud-folder open *and* propagated the lock file before the local
    open — admittedly imperfect for the cross-device case, but better
    than the unlocked default).
    """
    if db_path.as_posix() == ":memory:":
        # In-memory DBs have no concurrent-writer hazard.
        return _NoopWriteLock()

    lock_path = _lock_path_for(db_path)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    # Open in append+read so the file exists; we never write content.
    fh = open(lock_path, "a+b")  # noqa: SIM115 - lifetime owned by WriteLock
    try:
        if os.name == "nt":  # pragma: no cover - platform-specific
            import msvcrt  # noqa: PLC0415

            try:
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                raise WriteLockError(
                    f"another instance holds the writer lock at {lock_path}"
                ) from exc
        else:
            import fcntl  # noqa: PLC0415

            try:
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                raise WriteLockError(
                    f"another instance holds the writer lock at {lock_path}"
                ) from exc
    except Exception:
        fh.close()
        raise
    return WriteLock(path=lock_path, _fh=fh)


class _NoopWriteLock(WriteLock):
    """Stand-in lock used when there is no on-disk DB to protect."""

    def __init__(self) -> None:
        # Skip the dataclass __init__; this lock never touches the FS.
        pass

    def release(self) -> None:  # pragma: no cover - trivial
        return
