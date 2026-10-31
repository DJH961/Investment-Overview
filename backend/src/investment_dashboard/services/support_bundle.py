"""Build a shareable *support bundle* — recent logs plus safe context.

When something is slow or broken, the fastest way to get help is to hand over
the exact logs. This service stitches together:

* a header (app version, Python/platform, timestamp, where logs live),
* a **redacted** summary of the effective configuration (never secrets),
* the size of each storage tier (a cheap "is the DB empty?" signal),
* a Data Health snapshot (the app's own diagnostics: stale prices, FX, …),
* the recorded background **errors and warnings** (the Data Health list, which
  otherwise lives only in process memory), and
* the tail of the rotating ``dashboard.log`` file,

into one plain-text file the user can download from the Data Health page and
share directly. Everything passes through :func:`redact_secrets`, so the bundle
is safe to attach to an issue.
"""

from __future__ import annotations

import platform
import sys
from datetime import UTC, datetime
from pathlib import Path

from investment_dashboard import __version__
from investment_dashboard.config import get_settings
from investment_dashboard.redaction import redact_secrets
from investment_dashboard.services import runtime_status

#: Default amount of the log file to include (bytes, counted from the end).
DEFAULT_LOG_TAIL_BYTES = 256_000

#: How many recorded background errors/warnings to embed in the bundle. The
#: tracker retains at most :data:`runtime_status._MAX_LOG_ENTRIES`; we include
#: them all so a report captures the full recent-failure picture.
DEFAULT_MAX_ERRORS = 50

_SEPARATOR = "=" * 72


def read_recent_log_text(max_bytes: int = DEFAULT_LOG_TAIL_BYTES) -> str:
    """Return the tail of the active log file, or a friendly note if absent.

    Reads at most ``max_bytes`` from the end so a long-running session's log
    stays a manageable size. Log records are already secret-redacted on write,
    but we redact again defensively in case an older file predates that filter.
    """
    path: Path = get_settings().log_file_path
    try:
        size = path.stat().st_size
    except OSError:
        return f"(no log file found at {path})"
    try:
        with path.open("rb") as handle:
            if size > max_bytes:
                handle.seek(size - max_bytes)
                # Drop the partial first line after seeking into the middle.
                handle.readline()
            data = handle.read()
    except OSError as exc:  # pragma: no cover - defensive (locked/removed file)
        return f"(could not read log file {path}: {exc})"
    return redact_secrets(data.decode("utf-8", errors="replace"))


def _config_summary() -> str:
    """A redacted, secret-free snapshot of the settings that affect behaviour."""
    settings = get_settings()
    lines = [
        f"log_level         : {settings.log_level}",
        f"log_file          : {settings.log_file_path}",
        f"host:port         : {settings.host}:{settings.port}",
        f"split_db          : {settings.is_split_db}",
        f"ledger_path       : {settings.ledger_path}",
        f"config_path       : {settings.config_path}",
        f"cache_path        : {settings.cache_path}",
        f"api_enabled       : {settings.api_enabled}",
        f"publish_enabled   : {settings.publish_enabled}",
        f"shutdown_on_close : {settings.shutdown_on_tab_close}",
    ]
    return redact_secrets("\n".join(lines))


def _database_summary() -> str:
    """File sizes of each storage tier — a cheap health signal (0 ⇒ empty DB)."""
    settings = get_settings()
    tiers: list[tuple[str, Path | None]] = [
        ("ledger", settings.ledger_path),
        ("config", settings.config_path),
        ("cache", settings.cache_path),
    ]
    seen: set[Path] = set()
    lines: list[str] = []
    for label, path in tiers:
        if path is None or path.as_posix() == ":memory:":
            lines.append(f"{label:<7}: {path}")
            continue
        if path in seen:  # single-file mode: every tier aliases one file
            lines.append(f"{label:<7}: (shared with ledger)")
            continue
        seen.add(path)
        try:
            size = path.stat().st_size
            lines.append(f"{label:<7}: {size:,} bytes ({path})")
        except OSError:
            lines.append(f"{label:<7}: (missing) ({path})")
    return redact_secrets("\n".join(lines))


def recent_errors_text(max_errors: int = DEFAULT_MAX_ERRORS) -> str:
    """Render the in-app recorded errors/warnings (newest first) for the bundle.

    These are the same background failures shown on the Data Health page
    (:mod:`investment_dashboard.services.runtime_status`) — uncaught exceptions,
    failed price/FX refreshes and stray ``stderr`` writes. They live only in a
    process-local ring buffer, so without embedding them here a shared bundle
    would omit the very failures that prompted the report. Each entry is
    redacted defensively in case a message echoes a secret.
    """
    events = runtime_status.recent(limit=max_errors)
    if not events:
        return "(no errors or warnings recorded this session)"
    lines: list[str] = []
    for event in events:
        stamp = event.at.strftime("%Y-%m-%d %H:%M:%S UTC")
        level = "WARNING" if event.is_warning else "ERROR"
        lines.append(f"[{stamp}] {level:<7} {event.source}: {event.message}")
    return redact_secrets("\n".join(lines))


def _health_summary() -> str:
    """Best-effort Data Health snapshot (worst-first), or a note when unavailable.

    Runs the same diagnostics the Data Health page shows so a shared bundle
    carries the app's own assessment (stale prices, missing FX legs, provider
    config). Opens its own short-lived session and never raises: any failure
    degrades to a friendly note rather than breaking the bundle.
    """
    try:
        from investment_dashboard.db import session_scope  # noqa: PLC0415
        from investment_dashboard.services import diagnostics_service  # noqa: PLC0415

        with session_scope() as session:
            report = diagnostics_service.check_health(session)
    except Exception as exc:  # pragma: no cover - defensive: never break the bundle
        return f"(health check unavailable: {type(exc).__name__}: {exc})"
    lines = [f"overall : {report.worst_severity} ({report.problem_count} problem(s))"]
    # Problems worst-first (the page's own ordering), then the passing checks.
    ordered = list(report.problems) + [i for i in report.items if i.ok]
    for item in ordered:
        lines.append(f"[{item.severity.upper():<7}] {item.title}: {item.detail}")
    return redact_secrets("\n".join(lines))


def build_support_bundle(
    *,
    log_tail_bytes: int = DEFAULT_LOG_TAIL_BYTES,
    max_errors: int = DEFAULT_MAX_ERRORS,
) -> str:
    """Return the full support bundle as a single plain-text document."""
    now = datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S UTC")
    header = [
        _SEPARATOR,
        "Investment Dashboard — support bundle",
        _SEPARATOR,
        f"generated   : {now}",
        f"app version : {__version__}",
        f"python      : {sys.version.split()[0]}",
        f"platform    : {platform.platform()}",
        "",
        "Configuration (secrets redacted)",
        "-" * 32,
        _config_summary(),
        "",
        "Databases",
        "-" * 32,
        _database_summary(),
        "",
        "Data health",
        "-" * 32,
        _health_summary(),
        "",
        f"Recent errors and warnings (last {max_errors}, newest first)",
        "-" * 32,
        recent_errors_text(max_errors),
        "",
        f"Recent log (last {log_tail_bytes} bytes of dashboard.log)",
        "-" * 32,
    ]
    return "\n".join(header) + "\n" + read_recent_log_text(log_tail_bytes) + "\n"


def bundle_filename() -> str:
    """Timestamped filename for the downloaded bundle."""
    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    return f"inv-dashboard-support-{stamp}.txt"
