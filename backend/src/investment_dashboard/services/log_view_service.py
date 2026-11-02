"""Read-only view of the server log for Health & Repair → Logs.

Reads at most :data:`MAX_READ_BYTES` from the end of ``dashboard.log`` (or one
activity-subject file), parses the ``<date> <time> <LEVEL> <logger> — <message>``
lines, filters by level / text, and runs every line through
:func:`redaction.redact_secrets` plus the concrete secrets this process holds
(DB / backup passphrases, API and Tiingo tokens). Traceback lines are dropped
unless ``tracebacks=True`` (the API allows that only for browser sessions).
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from investment_dashboard.activity_log import SUBJECTS
from investment_dashboard.config import get_settings
from investment_dashboard.redaction import redact_secrets

MAX_READ_BYTES = 1024 * 1024
MAX_LIMIT = 1000
_LINE_RE = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (?P<level>[A-Z]+)\s+(?P<logger>\S+) — (?P<msg>.*)$"
)
_LEVELS = {name: logging.getLevelName(name) for name in ("DEBUG", "INFO", "WARNING", "ERROR")}


@dataclass(frozen=True)
class LogEntry:
    ts: str
    level: str
    logger: str
    message: str
    traceback: str | None = None


def _secrets() -> list[str]:
    settings = get_settings()
    values = [
        settings.db_passphrase,
        settings.api_token,
        settings.tiingo_token,
        os.environ.get("INV_DASHBOARD_BACKUP_PASSPHRASE"),
    ]
    try:
        from investment_dashboard.services import settings_service  # noqa: PLC0415

        values.append(settings_service.get("tiingo.api_token"))
    except Exception:  # pragma: no cover - the DB is optional here
        pass
    return [v for v in values if isinstance(v, str) and len(v) >= 4]


def _tail(path: Path, max_bytes: int) -> list[str]:
    try:
        with path.open("rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - max_bytes))
            data = fh.read(max_bytes)
    except FileNotFoundError:
        return []
    lines = data.decode("utf-8", errors="replace").splitlines()
    if size > max_bytes and lines:
        lines = lines[1:]  # the first line is probably cut in half
    return lines


def log_path(source: str = "main") -> Path:
    settings = get_settings()
    if source == "main":
        return settings.log_file_path
    if source not in SUBJECTS:
        raise ValueError(f"unknown log {source!r}")
    return settings.resolved_log_dir / "activity" / f"{source}.log"


def read(
    *,
    source: str = "main",
    level: str = "INFO",
    limit: int = 200,
    contains: str | None = None,
    tracebacks: bool = False,
    path: Path | None = None,
) -> list[LogEntry]:
    """Newest-first entries at or above ``level`` (``limit`` capped at 1000)."""
    floor = _LEVELS.get(level.upper())
    if floor is None:
        raise ValueError(f"unknown level {level!r}")
    limit = max(1, min(limit, MAX_LIMIT))
    secrets = _secrets()
    needle = contains.lower() if contains else None
    entries: list[LogEntry] = []
    current: dict[str, Any] | None = None
    extra: list[str] = []

    def flush() -> None:
        if current is None:
            return
        lvl = logging.getLevelName(current["level"])
        if not isinstance(lvl, int) or lvl < floor:
            return
        message = redact_secrets(current["msg"], extra=secrets)
        trace = redact_secrets("\n".join(extra), extra=secrets) if extra and tracebacks else None
        if needle and needle not in message.lower() and needle not in current["logger"].lower():
            return
        entries.append(LogEntry(current["ts"], current["level"], current["logger"], message, trace))

    for line in _tail(path or log_path(source), MAX_READ_BYTES):
        m = _LINE_RE.match(line)
        if m:
            flush()
            current, extra = m.groupdict(), []
        elif current is not None:
            extra.append(line)
    flush()
    return list(reversed(entries))[:limit]


def sources() -> list[str]:
    return ["main", *SUBJECTS]
