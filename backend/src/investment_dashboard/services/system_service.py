"""Read-only system facts for the Settings → System tab and Health & Repair.

Nothing here is editable: paths, env-only flags, versions, migration status and
which in-app settings shadow an env value. Secrets are reported only as
"set / not set".
"""

from __future__ import annotations

import os
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import text

from investment_dashboard import __version__
from investment_dashboard.config import get_settings

_STARTED = time.monotonic()
_STARTED_AT = datetime.now(UTC)


def _size(path: Path | None) -> int | None:
    try:
        return path.stat().st_size if path is not None else None
    except OSError:
        return None


def migration_status() -> dict[str, str | None]:
    """``{current, head}`` Alembic revisions (``None`` when unknown)."""
    current: str | None = None
    head: str | None = None
    try:
        from investment_dashboard.db import get_ledger_engine  # noqa: PLC0415

        with get_ledger_engine().connect() as conn:
            current = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
    except Exception:
        current = None
    try:
        from alembic.config import Config  # noqa: PLC0415
        from alembic.script import ScriptDirectory  # noqa: PLC0415

        ini = Path(__file__).resolve().parents[3] / "alembic.ini"
        if not ini.exists():
            ini = Path.cwd() / "alembic.ini"
        if ini.exists():
            cfg = Config(str(ini))
            cfg.set_main_option("script_location", str(ini.parent / "migrations"))
            head = ScriptDirectory.from_config(cfg).get_current_head()
    except Exception:
        head = None
    return {"current": current, "head": head}


def integrity() -> dict[str, Any]:
    """SQLite ``integrity_check`` of the live database file(s)."""
    from investment_dashboard.db import get_active_encryption  # noqa: PLC0415
    from investment_dashboard.storage.integrity import integrity_check  # noqa: PLC0415

    settings = get_settings()
    paths = {settings.ledger_path, settings.config_path, settings.cache_path}
    results: dict[str, str] = {}
    for path in sorted(p for p in paths if p is not None):
        results[path.name] = integrity_check(path, encryption=get_active_encryption())
    return {"ok": all(v in ("ok", "missing") for v in results.values()), "files": results}


def info() -> dict[str, Any]:
    from investment_dashboard.services import (  # noqa: PLC0415
        backup_service,
        settings_registry,
        settings_service,
    )

    settings = get_settings()
    effective = settings_service.get_all()
    shadowing = [
        key
        for key, eff in effective.items()
        if eff.source == "db" and eff.env_value_present and not settings_registry.BY_KEY[key].secret
    ]
    return {
        "version": __version__,
        "image_tag": os.environ.get("APP_TAG"),
        "started_at": _STARTED_AT.isoformat(),
        "uptime_seconds": int(time.monotonic() - _STARTED),
        "server_mode": settings.server_mode,
        "scheduler_enabled": settings.scheduler_enabled,
        "encrypted": settings.encrypt_synced_tiers or bool(settings.db_passphrase),
        "split_db": settings.is_split_db,
        "api_token_enabled": bool(settings.api_token),
        "backup_passphrase_set": bool(os.environ.get(backup_service.ENV_BACKUP_PASSPHRASE)),
        "backup_falls_back_to_db_key": not os.environ.get(backup_service.ENV_BACKUP_PASSPHRASE)
        and bool(settings.db_passphrase),
        "paths": {
            "db": str(settings.db_path),
            "backups": str(backup_service.backup_dir()),
            "logs": str(settings.resolved_log_dir),
        },
        "db_size_bytes": _size(settings.db_path),
        "migrations": migration_status(),
        "env_shadowed_by_app": shadowing,
    }
