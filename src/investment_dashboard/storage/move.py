"""Relocate the synced ledger + config tiers to a new folder.

Implements the v2.0 plan §4.4 "Move ledger…" flow. The Settings →
Storage panel exposes a folder picker that calls :func:`move_synced_tiers`
to physically relocate the ledger (and config) database files, then
updates ``app_config`` so the resolver finds them at the new location on
the next launch.

The move is deliberately conservative, following the plan's §8 note that
an "atomic move across drives" must fall back to *copy-verify-delete with
a temporary holdback file*, not a bare :meth:`pathlib.Path.rename`:

1. A rolling backup of each source file is taken first (safety net).
2. The file is copied with the SQLite online-backup API (consistent even
   if a connection is open) into a ``*.moving`` holdback file in the
   destination folder.
3. The copy is integrity-checked, then atomically renamed into place.
4. Only then is the source file (and any ``-wal`` / ``-shm`` sidecars)
   removed. A source that cannot be deleted yet (e.g. a Windows file lock
   held until the restart) is reported rather than aborting the move.

The cache tier is intentionally never moved — it is local-only derived
data that is rebuilt on demand.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path

from investment_dashboard.storage.backup import snapshot
from investment_dashboard.storage.encryption import EncryptionConfig
from investment_dashboard.storage.integrity import backup_database, integrity_check
from investment_dashboard.storage.paths import StorageLayout, resolve_storage_layout

log = logging.getLogger(__name__)

#: Tier files that may be relocated, in the order they are moved.
_SYNCED_FILENAMES = {"ledger": "ledger.sqlite", "config": "config.sqlite"}

#: app_config keys the resolver reads for each synced tier (see paths.py).
PERSIST_KEYS = {"ledger": "ledger_path", "config": "config_path"}

_SIDECAR_SUFFIXES = ("-wal", "-shm")


class MoveError(RuntimeError):
    """Raised when the relocation cannot complete safely."""


@dataclass(frozen=True)
class MoveResult:
    """Outcome of a :func:`move_synced_tiers` call."""

    #: tier name -> the new on-disk path for that tier.
    moved: dict[str, Path]
    #: tier name -> the rolling backup taken before the move (or ``None``).
    backups: dict[str, Path | None] = field(default_factory=dict)
    #: source files that were copied but could not be deleted afterwards.
    leftover_sources: list[Path] = field(default_factory=list)


def _remove_sidecars(src: Path) -> list[Path]:
    """Best-effort delete the source file + its ``-wal`` / ``-shm`` sidecars.

    Returns the list of paths that still exist (could not be removed).
    """
    leftover: list[Path] = []
    targets = [src, *(src.with_name(src.name + s) for s in _SIDECAR_SUFFIXES)]
    for path in targets:
        try:
            path.unlink()
        except FileNotFoundError:
            continue
        except OSError:
            log.warning("could not remove source file %s after move", path, exc_info=True)
            leftover.append(path)
    return leftover


def _safe_move_file(
    src: Path,
    dest: Path,
    *,
    encryption: EncryptionConfig | None,
) -> list[Path]:
    """Copy-verify-delete ``src`` to ``dest`` and return leftover source paths.

    The destination must not already exist. A consistent copy is written to
    a ``*.moving`` holdback file, integrity-checked, atomically renamed into
    place, and only then is the source removed.
    """
    if dest.exists():
        raise MoveError(
            f"refusing to overwrite existing file: {dest} "
            "(remove it first or pick a different folder)"
        )
    dest.parent.mkdir(parents=True, exist_ok=True)
    holdback = dest.with_name(dest.name + ".moving")
    if holdback.exists():
        holdback.unlink()
    backup_database(src, holdback, encryption=encryption)
    integrity_check(holdback, encryption=encryption)
    holdback.replace(dest)
    return _remove_sidecars(src)


def move_synced_tiers(
    dest_dir: str | Path,
    *,
    layout: StorageLayout | None = None,
    encryption: EncryptionConfig | None = None,
) -> MoveResult:
    """Move the ledger + config tier files into ``dest_dir``.

    Args:
        dest_dir: destination folder. ``~`` is expanded and the folder is
            created if missing.
        layout: the current resolved layout. Defaults to
            :func:`resolve_storage_layout`.
        encryption: encryption config to apply when reading/writing the
            SQLite files (so encrypted tiers stay encrypted).

    Returns a :class:`MoveResult` mapping each tier to its new path. The
    caller is responsible for persisting the new paths into ``app_config``
    (see :data:`PERSIST_KEYS`) and prompting the user to restart.

    Raises :class:`MoveError` if ``dest_dir`` is empty, if a tier is
    already in ``dest_dir``, or if a destination file already exists.
    """
    raw = str(dest_dir).strip()
    if not raw:
        raise MoveError("Choose a destination folder.")
    dest_root = Path(raw).expanduser()
    if dest_root.exists() and not dest_root.is_dir():
        raise MoveError(f"destination is not a folder: {dest_root}")

    layout = layout or resolve_storage_layout()
    sources = {"ledger": layout.ledger.path, "config": layout.config.path}

    # Validate up front so we never half-complete a move.
    planned: dict[str, tuple[Path, Path]] = {}
    for tier, filename in _SYNCED_FILENAMES.items():
        src = sources[tier]
        if src is None:
            continue
        dest = dest_root / filename
        try:
            same = src.resolve() == dest.resolve()
        except OSError:  # pragma: no cover - resolve on a missing parent
            same = src == dest
        if same:
            raise MoveError(f"the {tier} tier is already at {dest}.")
        planned[tier] = (src, dest)

    moved: dict[str, Path] = {}
    backups: dict[str, Path | None] = {}
    leftover: list[Path] = []
    for tier, (src, dest) in planned.items():
        if src.exists():
            backups[tier] = snapshot(src, encryption=encryption)
            leftover.extend(_safe_move_file(src, dest, encryption=encryption))
        else:
            # Nothing on disk yet (tier created lazily on first boot); just
            # record the new target so the caller persists it.
            backups[tier] = None
        moved[tier] = dest
        log.info("moved %s tier -> %s", tier, dest)

    return MoveResult(moved=moved, backups=backups, leftover_sources=leftover)
