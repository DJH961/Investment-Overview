"""Centralized logging configuration.

Logs are written to **two** sinks so problems are both visible live and
recoverable after the fact:

* ``stderr`` — the familiar console stream while the server runs.
* a **rotating file** under :attr:`Settings.resolved_log_dir` — so a user who
  hits a slow/broken page can grab ``dashboard.log`` (or download a diagnostics
  bundle from the Data Health page) and share the exact logs.

Both sinks share the secret-redacting filter so nothing sensitive is ever
written to disk.

A third, non-file handler (:class:`_RuntimeStatusHandler`) mirrors every
``WARNING``/``ERROR`` record into
:mod:`investment_dashboard.services.runtime_status`, so any logged problem also
surfaces in the browser (a toast plus the Data Health page) — vital now that the
app runs with no console window to watch.
"""

from __future__ import annotations

import logging
import os
import sys
from logging.handlers import RotatingFileHandler

from investment_dashboard.config import Settings, get_settings
from investment_dashboard.redaction import SecretRedactingFilter, register_secrets

_FORMAT = "%(asctime)s %(levelname)-7s %(name)s — %(message)s"
_DATEFMT = "%Y-%m-%d %H:%M:%S"


class _RuntimeStatusHandler(logging.Handler):
    """Funnel ``WARNING``/``ERROR`` log records into the in-app error tracker.

    The app runs with no console window, so anything that only reaches the log
    used to be invisible. Mirroring every warning/error into
    :mod:`investment_dashboard.services.runtime_status` makes *all* of them show
    up in the browser (a toast plus the Data Health page), not just the two
    hand-wired background tasks that called ``record_error`` directly.

    A record can opt out by setting ``extra={"runtime_status_skip": True}`` (used
    by callers that record into the tracker themselves, to avoid double entries),
    and can override the displayed label with ``extra={"runtime_status_source"}``.
    """

    def emit(self, record: logging.LogRecord) -> None:
        if getattr(record, "runtime_status_skip", False):
            return
        # Defer the import so this module stays importable very early in boot and
        # to avoid any import cycle through the services package.
        try:
            from investment_dashboard.services import runtime_status  # noqa: PLC0415

            source = getattr(record, "runtime_status_source", None) or record.name
            severity = (
                runtime_status.SEVERITY_WARNING
                if record.levelno < logging.ERROR
                else runtime_status.SEVERITY_ERROR
            )
            runtime_status.record_error(str(source), record.getMessage(), severity=severity)
        except Exception:  # pragma: no cover - logging must never crash callers
            self.handleError(record)


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


#: Third-party loggers that are harmless but noisy, and the level they are held at.
#: ``bs4.dammit`` (BeautifulSoup inside yfinance) warns "Some characters could not
#: be decoded" whenever Yahoo serves a page with odd encoding.
_QUIET_LOGGERS: dict[str, int] = {
    "bs4": logging.ERROR,
    "bs4.dammit": logging.ERROR,
    "charset_normalizer": logging.WARNING,
}


def quiet_third_party_loggers() -> None:
    """Hold known-noisy third-party loggers at a higher level."""
    for name, level in _QUIET_LOGGERS.items():
        logging.getLogger(name).setLevel(level)


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
    register_secrets(
        settings.db_passphrase,
        settings.api_token,
        settings.tiingo_token,
        settings.mobile_passphrase,
        os.environ.get("INV_DASHBOARD_BACKUP_PASSPHRASE"),
    )

    stream_handler = logging.StreamHandler(stream=sys.stderr)
    stream_handler.setFormatter(formatter)
    stream_handler.addFilter(redactor)
    root.addHandler(stream_handler)

    file_handler = _build_file_handler(settings, formatter, redactor)
    if file_handler is not None:
        root.addHandler(file_handler)

    # Mirror warnings/errors into the in-app tracker so they surface in the
    # browser (toast + Data Health), not just on disk. It only needs the
    # redactor — it stores messages, not formatted lines — and is capped at
    # WARNING so routine info/debug chatter never toasts.
    status_handler = _RuntimeStatusHandler(level=logging.WARNING)
    status_handler.addFilter(redactor)
    root.addHandler(status_handler)

    root.setLevel(settings.log_level)
    quiet_third_party_loggers()

    # Per-subject activity files (auth, market data, imports, ...), kept 90 days.
    from investment_dashboard.activity_log import configure_activity_logs  # noqa: PLC0415

    configure_activity_logs(settings.resolved_log_dir)

    if file_handler is not None:
        logging.getLogger(__name__).info("Logging to %s", settings.log_file_path)
    else:
        logging.getLogger(__name__).warning(
            "File logging unavailable (could not open %s); logging to console only.",
            settings.log_file_path,
        )
