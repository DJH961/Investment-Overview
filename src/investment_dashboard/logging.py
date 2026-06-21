"""Centralized logging configuration.

Logs are written to **two** sinks so problems are both visible live and
recoverable after the fact:

* ``stderr`` — the familiar console stream while the server runs.
* a **rotating file** under :attr:`Settings.resolved_log_dir` — so a user who
  hits a slow/broken page can grab ``dashboard.log`` (or download a diagnostics
  bundle from the Data Health page) and share the exact logs.

Both sinks share the secret-redacting filter so nothing sensitive is ever
written to disk.
"""

from __future__ import annotations

import logging
import sys
from logging.handlers import RotatingFileHandler

from investment_dashboard.config import Settings, get_settings
from investment_dashboard.redaction import SecretRedactingFilter

_FORMAT = "%(asctime)s %(levelname)-7s %(name)s — %(message)s"
_DATEFMT = "%Y-%m-%d %H:%M:%S"


def _build_file_handler(
    settings: Settings, formatter: logging.Formatter, redactor: logging.Filter
) -> RotatingFileHandler | None:
    """Best-effort rotating file handler; returns ``None`` if it can't open.

    File logging must never stop the app from booting — a read-only data dir or
    a locked file falls back to console-only logging instead of crashing.
    """
    try:
        log_dir = settings.resolved_log_dir
        log_dir.mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(
            settings.log_file_path,
            maxBytes=settings.log_max_bytes,
            backupCount=settings.log_backup_count,
            encoding="utf-8",
            delay=True,
        )
    except OSError:
        return None
    handler.setFormatter(formatter)
    handler.addFilter(redactor)
    return handler


def configure_logging() -> None:
    settings = get_settings()
    root = logging.getLogger()
    if root.handlers:
        return
    formatter = logging.Formatter(fmt=_FORMAT, datefmt=_DATEFMT)
    # Defence-in-depth: scrub secret-shaped strings from every record so an
    # accidental ``log.exception(resp.text)`` can't leak a credential — to the
    # console *or* the on-disk log file.
    redactor = SecretRedactingFilter()

    stream_handler = logging.StreamHandler(stream=sys.stderr)
    stream_handler.setFormatter(formatter)
    stream_handler.addFilter(redactor)
    root.addHandler(stream_handler)

    file_handler = _build_file_handler(settings, formatter, redactor)
    if file_handler is not None:
        root.addHandler(file_handler)

    root.setLevel(settings.log_level)

    if file_handler is not None:
        logging.getLogger(__name__).info("Logging to %s", settings.log_file_path)
    else:
        logging.getLogger(__name__).warning(
            "File logging unavailable (could not open %s); logging to console only.",
            settings.log_file_path,
        )
