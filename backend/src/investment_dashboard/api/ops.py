"""Ops endpoints: price refresh trigger/status and a database backup download.

* ``POST /refresh`` starts the existing refresh as the ``refresh`` job of
  :mod:`services.job_runner` (single flight, shares the heavy-job lock with the
  repair jobs: a second request while one runs gets 409) and returns 202.
* ``GET /backup?kind=sealed`` streams the same sealed snapshot the scheduler writes
  (full database incl. passkeys, AES-GCM sealed; restore with
  ``inv-dashboard-restore``). ``kind=db``
  streams a plain, secret-scrubbed SQLite copy. ``name=<snapshot>`` downloads
  one of the stored sealed snapshots (see ``GET /maintenance/backups``).
"""

from __future__ import annotations

import logging
import shutil
import tempfile
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from investment_dashboard.api.guards import actor_of
from investment_dashboard.api.schemas.ops import RefreshStatus
from investment_dashboard.config import get_settings
from investment_dashboard.db import get_active_encryption
from investment_dashboard.services import auto_refresh, backup_service, job_runner, refresh_status
from investment_dashboard.storage.encryption import connect_sqlite
from investment_dashboard.storage.integrity import backup_database

log = logging.getLogger(__name__)

router = APIRouter(tags=["ops"])

_REFRESH_SOURCE = "Manual refresh"
_REFRESH_JOB = "refresh"

#: Tables holding credentials / live sessions: emptied in every backup copy.
_SECRET_TABLES = ("auth_credential", "auth_passkeys", "auth_sessions")
#: ``app_config`` keys containing any of these words are dropped from backups.
_SECRET_KEY_WORDS = ("token", "secret", "passphrase", "password", "api_key")


def _status() -> RefreshStatus:
    snap = refresh_status.snapshot()
    running = snap.active or bool(job_runner.running(_REFRESH_JOB))
    return RefreshStatus(
        running=running,
        source=snap.source,
        seq=snap.seq,
        last_update_at=snap.last_update_at,
        historical=snap.historical,
        progress_done=snap.progress_done,
        progress_total=snap.progress_total,
        progress_label=snap.progress_label,
    )


def _run_refresh(params: dict[str, object]) -> dict[str, object]:
    return {"refreshed": auto_refresh.tick_refresh(_REFRESH_SOURCE, force=bool(params["force"]))}


@router.post("/refresh", response_model=RefreshStatus, status_code=status.HTTP_202_ACCEPTED)
def start_refresh(request: Request, force: bool = True) -> RefreshStatus:
    if refresh_status.snapshot().active:
        raise HTTPException(status.HTTP_409_CONFLICT, "A refresh is already running")
    try:
        job_runner.start(
            _REFRESH_JOB,
            _run_refresh,
            {"force": force},
            actor=actor_of(getattr(request.state, "principal", None)),
            heavy=True,
        )
    except job_runner.JobBusyError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    return _status()


@router.get("/refresh/status", response_model=RefreshStatus)
def get_refresh_status() -> RefreshStatus:
    return _status()


def _scrub_secrets(copy: Path) -> None:
    """Remove credential rows and secret-looking config values from the copy."""
    with closing(connect_sqlite(copy, get_active_encryption())) as conn:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for table in _SECRET_TABLES:
            if table in tables:
                conn.execute(f"DELETE FROM {table}")
        if "app_config" in tables:
            for word in _SECRET_KEY_WORDS:
                conn.execute("DELETE FROM app_config WHERE lower(key) LIKE ?", (f"%{word}%",))
        conn.commit()
        conn.execute("VACUUM")


def _sealed_backup() -> FileResponse:
    tmp = Path(tempfile.mkdtemp(prefix="inv-backup-"))
    try:
        dest = backup_service.create_snapshot(directory=tmp, retain=False)
    except backup_service.SnapshotError as exc:
        shutil.rmtree(tmp, ignore_errors=True)
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except FileNotFoundError as exc:
        shutil.rmtree(tmp, ignore_errors=True)
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Database file not found") from exc
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    log.info("Sealed backup downloaded (%s)", dest.name)
    return FileResponse(
        dest,
        media_type="application/json",
        filename=dest.name,
        background=BackgroundTask(shutil.rmtree, tmp, ignore_errors=True),
    )


@router.get("/backup", response_class=FileResponse)
def download_backup(
    kind: str = Query(
        "sealed",
        pattern="^(db|sealed)$",
        description="'sealed': encrypted full snapshot; 'db': plain scrubbed copy.",
    ),
    name: str | None = Query(
        None,
        max_length=64,
        description="A stored sealed snapshot to download instead of a fresh one.",
    ),
) -> FileResponse:
    if name is not None:
        try:
            path = backup_service.snapshot_by_name(name)
        except backup_service.SnapshotError as exc:
            raise HTTPException(status.HTTP_404_NOT_FOUND, str(exc)) from exc
        log.info("Stored backup downloaded (%s)", path.name)
        return FileResponse(path, media_type="application/json", filename=path.name)
    settings = get_settings()
    if settings.is_split_db:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Backup needs the single-file database layout"
        )
    if kind == "sealed":
        return _sealed_backup()
    src = settings.db_path
    tmp = Path(tempfile.mkdtemp(prefix="inv-backup-"))
    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    dest = tmp / f"investment-overview-{stamp}.sqlite"
    try:
        backup_database(src, dest, encryption=get_active_encryption())
        _scrub_secrets(dest)
    except FileNotFoundError as exc:
        shutil.rmtree(tmp, ignore_errors=True)
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Database file not found") from exc
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    log.info("Database backup downloaded (%s)", dest.name)
    return FileResponse(
        dest,
        media_type="application/octet-stream",
        filename=dest.name,
        background=BackgroundTask(shutil.rmtree, tmp, ignore_errors=True),
    )
