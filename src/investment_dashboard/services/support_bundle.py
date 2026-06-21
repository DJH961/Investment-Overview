"""Build a shareable *support bundle* — recent logs plus safe context.

When something is slow or broken, the fastest way to get help is to hand over
the exact logs. This service stitches together:

* a header (app version, Python/platform, timestamp, where logs live),
* a **redacted** summary of the effective configuration (never secrets), and
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

#: Default amount of the log file to include (bytes, counted from the end).
DEFAULT_LOG_TAIL_BYTES = 256_000

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
        f"api_enabled       : {settings.api_enabled}",
        f"publish_enabled   : {settings.publish_enabled}",
        f"shutdown_on_close : {settings.shutdown_on_tab_close}",
    ]
    return redact_secrets("\n".join(lines))


def build_support_bundle(*, log_tail_bytes: int = DEFAULT_LOG_TAIL_BYTES) -> str:
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
        f"Recent log (last {log_tail_bytes} bytes of dashboard.log)",
        "-" * 32,
    ]
    return "\n".join(header) + "\n" + read_recent_log_text(log_tail_bytes) + "\n"


def bundle_filename() -> str:
    """Timestamped filename for the downloaded bundle."""
    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    return f"inv-dashboard-support-{stamp}.txt"
