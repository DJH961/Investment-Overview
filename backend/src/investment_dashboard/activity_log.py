"""Activity logs: one file per subject under ``<log dir>/activity/``.

The main ``dashboard.log`` holds everything; these files answer "what did the
server do?" per topic without digging through it:

* ``auth.log`` — logins (password, passkey), failed logins, logouts, passkey changes.
* ``market_data.log`` — price/FX/benchmark polling, provider fallbacks, scheduler jobs.
* ``imports.log`` — broker file uploads, import previews/confirms, ledger uploads.
* ``changes.log`` — manual edits: transactions, accounts, deposits, settings.
* ``backups.log`` — sealed snapshots, backup downloads, restores.
* ``system.log`` — startup, shutdown, migrations, watchdog warnings.

Each file rotates at midnight (UTC) and keeps :data:`RETENTION_DAYS` days, so
the logs never hold more than about three months. Records come from two places:
the module loggers listed in :data:`SUBJECTS` (routed here by name, so existing
``log.info`` calls need no change) and explicit ``activity("<subject>")``
loggers used for request and job events. Secrets are scrubbed by the same filter
as the main log.
"""

from __future__ import annotations

import logging
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path

from investment_dashboard.redaction import SecretRedactingFilter

RETENTION_DAYS = 90
_FORMAT = "%(asctime)s %(levelname)-7s %(name)s — %(message)s"
_DATEFMT = "%Y-%m-%d %H:%M:%S"
_PKG = "investment_dashboard"

#: Subject -> logger-name prefixes routed into ``<subject>.log``.
SUBJECTS: dict[str, tuple[str, ...]] = {
    "auth": (f"{_PKG}.services.auth_service",),
    "market_data": (
        f"{_PKG}.adapters",
        f"{_PKG}.services.prices_service",
        f"{_PKG}.services.fx_service",
        f"{_PKG}.services.benchmark_service",
        f"{_PKG}.services.auto_refresh",
        f"{_PKG}.services.tiingo_fallback",
        f"{_PKG}.services.tiingo_fallback_runner",
        f"{_PKG}.services.intraday_snapshots_service",
        f"{_PKG}.services.price_probe_service",
        f"{_PKG}.services.scheduler",
    ),
    "imports": (
        f"{_PKG}.services.importer_service",
        f"{_PKG}.services.import_staging",
        f"{_PKG}.tools.upload_db",
    ),
    "changes": (
        f"{_PKG}.services.transaction_edit_service",
        f"{_PKG}.services.manual_entry",
        f"{_PKG}.services.fx_conversion_service",
        f"{_PKG}.services.database_reset_service",
    ),
    "backups": (
        f"{_PKG}.services.backup_service",
        f"{_PKG}.tools.restore_db",
        f"{_PKG}.tools.backup",
    ),
    "system": (
        f"{_PKG}.boot",
        f"{_PKG}.services.server_runtime",
        f"{_PKG}.services.loop_watchdog",
    ),
}

_HANDLER_ATTR = "_activity_subject"


def activity(subject: str) -> logging.Logger:
    """The explicit event logger for ``subject`` (one of :data:`SUBJECTS`)."""
    if subject not in SUBJECTS:
        raise ValueError(f"unknown activity subject {subject!r}")
    return logging.getLogger(f"activity.{subject}")


def configure_activity_logs(log_dir: Path, *, retention_days: int = RETENTION_DAYS) -> Path | None:
    """Attach one daily-rotating file per subject; returns the folder or ``None``.

    Idempotent (old activity handlers are replaced) and best effort: a folder
    that cannot be created leaves the app logging to the main log only.
    """
    folder = log_dir / "activity"
    try:
        folder.mkdir(parents=True, exist_ok=True)
    except OSError:
        return None
    formatter = logging.Formatter(fmt=_FORMAT, datefmt=_DATEFMT)
    redactor = SecretRedactingFilter()
    for subject, prefixes in SUBJECTS.items():
        handler = TimedRotatingFileHandler(
            folder / f"{subject}.log",
            when="midnight",
            backupCount=retention_days,
            encoding="utf-8",
            delay=True,
            utc=True,
        )
        handler.setLevel(logging.INFO)
        handler.setFormatter(formatter)
        handler.addFilter(redactor)
        setattr(handler, _HANDLER_ATTR, subject)
        for name in (f"activity.{subject}", *prefixes):
            logger = logging.getLogger(name)
            for old in [h for h in logger.handlers if getattr(h, _HANDLER_ATTR, None)]:
                logger.removeHandler(old)
                old.close()
            logger.addHandler(handler)
    # Explicit events are INFO; keep them even when the root level is WARNING.
    for subject in SUBJECTS:
        logging.getLogger(f"activity.{subject}").setLevel(logging.INFO)
    return folder
