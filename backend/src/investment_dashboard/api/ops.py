"""Ops endpoints: price refresh trigger/status and a database backup download.

* ``POST /refresh`` starts the existing refresh on a daemon thread (single
  flight: a second request while one runs gets 409) and returns 202.
* ``GET /backup?kind=sealed`` streams the same sealed snapshot the scheduler writes
  (full database incl. passkeys, AES-GCM sealed; restore with
  ``inv-dashboard-restore``). ``kind=db`` (default until the frontend moves over)
  streams a plain, secret-scrubbed SQLite copy.
"""

from __future__ import annotations

import logging
import shutil
import tempfile
import threading
from contextlib import closing
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from investment_dashboard.api.schemas.ops import RefreshStatus
from investment_dashboard.config import get_settings
from investment_dashboard.db import get_active_encryption
from investment_dashboard.services import auto_refresh, backup_service, refresh_status
from investment_dashboard.storage.encryption import connect_sqlite
from investment_dashboard.storage.integrity import backup_database

log = logging.getLogger(__name__)

router = APIRouter(tags=["ops"])

_REFRESH_SOURCE = "Manual refresh"
_flight_lock = threading.Lock()
_flight_running = False

#: Tables holding credentials / live sessions: emptied in every backup copy.
_SECRET_TABLES = ("auth_credential", "auth_passkeys", "auth_sessions")
#: ``app_config`` keys containing any of these words are dropped from backups.
_SECRET_KEY_WORDS = ("token", "secret", "passphrase", "password", "api_key")


def _status() -> RefreshStatus:
    snap = refresh_status.snapshot()
    with _flight_lock:
        running = snap.active or _flight_running
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


def _run_refresh(force: bool) -> None:
    global _flight_running  # noqa: PLW0603
    try:
        auto_refresh.tick_refresh(_REFRESH_SOURCE, force=force)
    except Exception:  # pragma: no cover - tick_refresh never raises
        log.warning("Manual refresh failed", exc_info=True)
    finally:
        with _flight_lock:
            _flight_running = False


@router.post("/refresh", response_model=RefreshStatus, status_code=status.HTTP_202_ACCEPTED)
def start_refresh(force: bool = True) -> RefreshStatus:
    global _flight_running  # noqa: PLW0603
    with _flight_lock:
        if _flight_running or refresh_status.snapshot().active:
            raise HTTPException(status.HTTP_409_CONFLICT, "A refresh is already running")
        _flight_running = True
    try:
        threading.Thread(
            target=_run_refresh, args=(force,), name="inv-dashboard-api-refresh", daemon=True
        ).start()
    except Exception:  # pragma: no cover - thread creation failure
        with _flight_lock:
            _flight_running = False
        raise
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
        "db",
        pattern="^(db|sealed)$",
        description="'sealed': encrypted full snapshot; 'db': plain scrubbed copy.",
    ),
) -> FileResponse:
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
