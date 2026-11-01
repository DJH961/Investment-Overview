"""``inv-dashboard-restore``: bring a sealed snapshot back as the live database.

Run it with the app stopped, from inside the container::

    docker compose stop app
    docker compose run --rm app inv-dashboard-restore --latest
    docker compose up -d app

Steps: pick a snapshot (``--latest``, ``--snapshot NAME`` or interactively) ->
unseal -> SQLite integrity check + key check + row counts compared with the
counts recorded when it was sealed -> atomic swap into place. The previous
database is kept next to it as ``<db>.before-restore-<time>``; nothing is
deleted. If the backup directory is empty, snapshots are pulled from the
off-site bucket with ``rclone`` when it is available, otherwise the command
says how to fetch them through the ``backup`` sidecar.
"""

from __future__ import annotations

import argparse
import getpass
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from investment_dashboard.config import get_settings
from investment_dashboard.services import backup_service
from investment_dashboard.storage.encryption import (
    EncryptionConfig,
    resolve_encryption,
)
from investment_dashboard.storage.integrity import IntegrityCheckError, integrity_check

ENV_REMOTE = "INV_DASHBOARD_BACKUP_REMOTE"
FETCH_HINT = (
    "No snapshots found. Fetch them from the off-site bucket first:\n"
    "  docker compose run --rm --entrypoint rclone backup copy "
    "b2:Investment-Overview/snapshots /data/backups\n"
    "(see deploy/RUNBOOK.md, section Restore), then run this command again."
)


class RestoreError(RuntimeError):
    """The restore was refused; the live database is untouched."""


@dataclass(frozen=True)
class RestoreResult:
    db_path: Path
    aside: Path | None
    counts: dict[str, int]


def restore_snapshot(
    snapshot: Path,
    db_path: Path,
    *,
    seal_passphrase: str,
    encryption: EncryptionConfig | None = None,
    now: datetime | None = None,
) -> RestoreResult:
    """Verify ``snapshot`` and atomically swap it in as ``db_path``."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    staged = db_path.with_name(db_path.name + ".restoring")
    staged.unlink(missing_ok=True)
    try:
        try:
            meta = backup_service.unseal_snapshot(snapshot, seal_passphrase, staged)
        except backup_service.SnapshotError as exc:
            raise RestoreError(str(exc)) from exc
        try:
            integrity_check(staged, encryption=encryption)
            counts = backup_service.row_counts(staged, encryption)
        except IntegrityCheckError as exc:
            raise RestoreError(f"integrity check failed: {exc}") from exc
        except Exception as exc:
            raise RestoreError(
                "the snapshot opened but the database cannot be read "
                f"(wrong database passphrase?): {exc}"
            ) from exc
        if counts != meta.get("counts"):
            raise RestoreError("row counts differ from the counts recorded when it was sealed")
        aside = _swap(staged, db_path, now or datetime.now(UTC))
    finally:
        staged.unlink(missing_ok=True)
    return RestoreResult(db_path, aside, counts)


def _swap(staged: Path, db_path: Path, now: datetime) -> Path | None:
    aside: Path | None = None
    if db_path.exists():
        aside = db_path.with_name(f"{db_path.name}.before-restore-{now:%Y%m%d-%H%M%S}")
        try:
            os.link(db_path, aside)  # old file stays on disk under the new name
        except OSError:
            shutil.copy2(db_path, aside)
    for suffix in ("-wal", "-shm"):  # a stale WAL must never be applied to the new file
        side = db_path.with_name(db_path.name + suffix)
        if side.exists() and aside is not None:
            side.replace(aside.with_name(aside.name + suffix))
        else:
            side.unlink(missing_ok=True)
    os.replace(staged, db_path)
    return aside


def _fetch_remote(directory: Path) -> bool:
    remote = os.environ.get(ENV_REMOTE)
    if not remote or shutil.which("rclone") is None:
        return False
    directory.mkdir(parents=True, exist_ok=True)
    print(f"Fetching snapshots from {remote} ...")
    return subprocess.run(["rclone", "copy", remote, str(directory)], check=False).returncode == 0


def _describe(i: int, s: backup_service.SnapshotInfo) -> str:
    size = s.path.stat().st_size / 1_000_000
    return f"  [{i}] {s.created:%Y-%m-%d %H:%M:%S} UTC  {s.path.name}  ({size:.1f} MB)"


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="inv-dashboard-restore", description=__doc__)
    p.add_argument("--list", action="store_true", help="list snapshots and exit")
    p.add_argument("--latest", action="store_true", help="restore the newest snapshot")
    p.add_argument("--snapshot", help="snapshot file name (or path) to restore")
    p.add_argument("--dir", type=Path, help="backup directory (default /data/backups)")
    p.add_argument("--db", type=Path, help="database file to replace (default: the app's)")
    p.add_argument("--yes", action="store_true", help="do not ask for confirmation")
    return p


def main(argv: list[str] | None = None) -> int:  # noqa: PLR0911, PLR0912, PLR0915
    args = _build_parser().parse_args(argv)
    directory: Path = args.dir or backup_service.backup_dir()
    settings = get_settings()
    db_path: Path = args.db or settings.db_path

    snaps = backup_service.list_snapshots(directory)
    if not snaps and not args.snapshot and _fetch_remote(directory):
        snaps = backup_service.list_snapshots(directory)

    if args.list:
        if not snaps:
            print(FETCH_HINT)
            return 2
        for i, s in enumerate(snaps):
            print(_describe(i, s))
        return 0

    chosen: Path | None = None
    if args.snapshot:
        cand = Path(args.snapshot)
        chosen = cand if cand.is_file() else directory / args.snapshot
        if not chosen.is_file():
            print(f"Snapshot not found: {args.snapshot}", file=sys.stderr)
            return 2
    elif not snaps:
        print(FETCH_HINT, file=sys.stderr)
        return 2
    elif args.latest:
        chosen = snaps[0].path
    elif sys.stdin.isatty():
        for i, s in enumerate(snaps):
            print(_describe(i, s))
        pick = input("Restore which snapshot? [0 = newest] ").strip() or "0"
        if not pick.isdigit() or int(pick) >= len(snaps):
            print("Not a valid choice.", file=sys.stderr)
            return 2
        chosen = snaps[int(pick)].path
    else:
        print("Choose --latest or --snapshot NAME (or run with a terminal).", file=sys.stderr)
        return 2

    seal = backup_service.backup_passphrase()
    if seal is None:
        if not sys.stdin.isatty():
            print("Set INV_DASHBOARD_BACKUP_PASSPHRASE.", file=sys.stderr)
            return 2
        seal = getpass.getpass("Backup passphrase: ")

    if not args.yes:
        if not sys.stdin.isatty():
            print("Add --yes to confirm without a terminal.", file=sys.stderr)
            return 2
        print(f"This replaces {db_path} with {chosen.name}. The current file is kept aside.")
        print("Make sure the app is stopped (docker compose stop app).")
        if input("Type 'restore' to continue: ").strip() != "restore":
            print("Cancelled; nothing changed.")
            return 1

    try:
        encryption = resolve_encryption(
            encrypt_synced_tiers=settings.encrypt_synced_tiers,
            env_passphrase=settings.db_passphrase,
        )
        result = restore_snapshot(chosen, db_path, seal_passphrase=seal, encryption=encryption)
    except RestoreError as exc:
        print(f"RESTORE REFUSED, the live database was not touched: {exc}", file=sys.stderr)
        return 3
    except Exception as exc:
        print(f"RESTORE FAILED, the live database was not touched: {exc}", file=sys.stderr)
        return 3

    total = sum(result.counts.values())
    print(
        f"Restored {chosen.name} into {result.db_path} ({total} rows in {len(result.counts)} tables)."
    )
    if result.aside:
        print(f"The previous database was kept as {result.aside}.")
    print("Start the app again:  docker compose up -d app")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
