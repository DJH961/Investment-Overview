"""Crash-safe atomic file writes for sidecar / blob outputs.

Several writers in the app emit *sidecar* files that a consumer cloud-sync
client (OneDrive, iCloud, Dropbox, …) may pick up and upload at any moment:
backup manifests, the ``publish-web`` encrypted blob, and the mobile snapshot.
A plain ``Path.write_text`` is neither atomic (a reader can observe a partial
file) nor durable (the bytes may sit in the page cache when a crash or power
loss occurs).

:func:`atomic_write_text` / :func:`atomic_write_bytes` write to a temp file in
the destination directory, ``fsync`` the file, ``os.replace`` it into place
(atomic on POSIX and Windows for same-directory renames), and ``fsync`` the
parent directory so the rename itself is durable. The snapshot export already
used a temp-rename; routing every sidecar through this single helper makes the
whole app's external writes uniformly crash-safe.
"""

from __future__ import annotations

import contextlib
import os
from pathlib import Path


def atomic_write_bytes(path: Path, data: bytes) -> None:
    """Atomically and durably write ``data`` to ``path``."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp.{os.getpid()}")
    try:
        with open(tmp, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        _fsync_dir(path.parent)
    finally:
        # Never leave a stray temp file behind if the replace failed.
        if tmp.exists():
            with contextlib.suppress(OSError):
                tmp.unlink()


def atomic_write_text(path: Path, text: str, *, encoding: str = "utf-8") -> None:
    """Atomically and durably write ``text`` to ``path``."""
    atomic_write_bytes(path, text.encode(encoding))


def _fsync_dir(directory: Path) -> None:
    """``fsync`` a directory so a rename into it survives a crash.

    Directory fsync is a no-op (and may be unsupported) on some platforms —
    notably Windows, where ``os.open`` on a directory raises. Swallow those so
    the write still succeeds with file-level durability.
    """
    try:
        fd = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)
