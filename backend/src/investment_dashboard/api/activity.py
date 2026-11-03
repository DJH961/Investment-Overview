"""Request activity: one line per relevant API call into the subject's log.

Logged: every write (POST/PUT/PATCH/DELETE) except pure calculations, plus the
downloads that take data off the server (backup, support bundle). Never logged:
request bodies, query strings, cookies or tokens. See
:mod:`investment_dashboard.activity_log` for the files and their retention.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Awaitable, Callable

from fastapi import Request, Response

from investment_dashboard.activity_log import activity

_WRITES = frozenset({"POST", "PUT", "PATCH", "DELETE"})
#: Writes that change nothing (they only compute a result).
_READ_ONLY_WRITES = frozenset(
    {
        "/api/calculator",
        "/api/allocations/plan",
        "/api/auth/passkey/login/options",
        "/api/maintenance/probe",
    }
)
#: Reads worth recording because they take data off the server.
_DOWNLOADS = {
    "/api/backup": "backups",
    "/api/diagnostics/support-bundle": "system",
    "/api/maintenance/logs": "system",
    "/api/settings/export": "changes",
}
#: Write-path prefix -> subject (checked in order, after auth/imports).
_WRITE_PREFIXES: tuple[tuple[str, str], ...] = (
    ("/api/maintenance/prices/", "market_data"),
    ("/api/maintenance/fx/", "market_data"),
    ("/api/maintenance/splits/", "market_data"),
    ("/api/maintenance/scheduler/", "market_data"),
    ("/api/maintenance/jobs/backup.", "backups"),
    ("/api/maintenance/jobs/", "system"),
)

#: (method, route) -> what happened, by response status class (ok / refused).
_LABELS: dict[tuple[str, str], tuple[str, str]] = {
    ("POST", "/api/auth/login"): ("login ok (password)", "login FAILED (password)"),
    ("POST", "/api/auth/passkey/login/verify"): ("login ok (passkey)", "login FAILED (passkey)"),
    ("POST", "/api/auth/logout"): ("logout", "logout refused"),
    ("POST", "/api/auth/passkey/register/verify"): ("passkey added", "passkey add failed"),
    ("DELETE", "/api/auth/passkeys/{passkey_id}"): ("passkey removed", "passkey remove failed"),
    ("POST", "/api/imports"): ("import file uploaded (preview)", "import upload rejected"),
    ("POST", "/api/imports/{import_id}/confirm"): ("import confirmed", "import confirm failed"),
    ("DELETE", "/api/imports/{import_id}"): ("import discarded", "import discard failed"),
    ("POST", "/api/imports/{import_id}/reparse"): ("import re-previewed", "import reparse failed"),
    ("POST", "/api/imports/{import_id}/resolve"): (
        "import rows resolved (re-previewed)",
        "import row resolve rejected",
    ),
    ("POST", "/api/imports/{import_id}/layout"): (
        "import columns changed (re-previewed)",
        "import column change failed",
    ),
    ("PUT", "/api/imports/action-overrides/{broker}"): (
        "import action mapping changed",
        "import action mapping rejected",
    ),
    ("POST", "/api/imports/batches/{batch_id}/undo"): ("import UNDONE", "import undo refused"),
    ("POST", "/api/ops/announce-restart"): ("restart announced", "restart announce refused"),
    ("POST", "/api/refresh"): ("manual refresh requested", "manual refresh refused"),
    ("POST", "/api/graphs/{range_key}/reload"): (
        "graph reload requested",
        "graph reload refused",
    ),
    ("PUT", "/api/graphs/range"): ("graph range remembered", "graph range refused"),
    ("GET", "/api/backup"): ("backup downloaded", "backup download failed"),
    ("GET", "/api/diagnostics/support-bundle"): (
        "support bundle downloaded",
        "support bundle failed",
    ),
    ("GET", "/api/maintenance/logs"): ("log viewer opened", "log viewer refused"),
    ("POST", "/api/diagnostics/problems/dismiss-all"): (
        "problems dismissed",
        "problem dismiss failed",
    ),
    ("POST", "/api/diagnostics/problems/{problem_id}/dismiss"): (
        "problem dismissed",
        "problem dismiss failed",
    ),
    ("GET", "/api/settings/export"): ("settings exported", "settings export failed"),
    ("PATCH", "/api/settings/values"): ("settings changed", "settings change rejected"),
    ("POST", "/api/settings/reset"): ("settings reset", "settings reset rejected"),
    ("POST", "/api/settings/history/{audit_id}/revert"): (
        "settings change reverted",
        "settings revert rejected",
    ),
    ("POST", "/api/settings/import"): ("settings imported", "settings import rejected"),
    ("POST", "/api/maintenance/jobs/{job_id}"): ("repair job started", "repair job refused"),
    ("PATCH", "/api/instruments/{instrument_id}"): (
        "instrument settings changed",
        "instrument change rejected",
    ),
    ("POST", "/api/maintenance/scheduler/{job}/run"): (
        "scheduler run-now requested",
        "scheduler run-now refused",
    ),
    ("PUT", "/api/maintenance/scheduler/pause"): (
        "scheduler pause changed",
        "scheduler pause refused",
    ),
    ("PUT", "/api/maintenance/prices/{instrument_id}/{on}"): (
        "manual close set",
        "manual close rejected",
    ),
    ("DELETE", "/api/maintenance/prices/{instrument_id}/{on}"): (
        "close removed",
        "close remove failed",
    ),
    ("PUT", "/api/maintenance/fx/{quote}/{on}"): ("manual FX rate set", "manual FX rate rejected"),
    ("DELETE", "/api/maintenance/fx/{quote}/{on}"): ("FX rate removed", "FX rate remove failed"),
    ("PUT", "/api/maintenance/splits/{instrument_id}/{on}"): (
        "manual split set",
        "manual split rejected",
    ),
    ("DELETE", "/api/maintenance/splits/{instrument_id}/{on}"): (
        "split removed",
        "split remove failed",
    ),
}


def subject_for(method: str, path: str) -> str | None:  # noqa: PLR0911 - flat routing table
    """The activity subject for a request, or ``None`` when it is not logged."""
    if method in _WRITES:
        if path in _READ_ONLY_WRITES or not path.startswith("/api/"):
            return None
        if path.startswith("/api/auth/"):
            return "auth"
        if path.startswith("/api/imports"):
            return "imports"
        if path == "/api/ops/announce-restart":
            return "system"
        if path == "/api/refresh" or (path.startswith("/api/graphs/") and path.endswith("/reload")):
            return "market_data"
        for prefix, subject in _WRITE_PREFIXES:
            if path.startswith(prefix):
                return subject
        return "changes"
    return _DOWNLOADS.get(path) if method == "GET" else None


def _level(status: int, path: str) -> int:
    """INFO for success and for requests turned away for lack of a session.

    A 401/403 outside ``/api/auth/`` is the guard working: internet scanners
    probing ``/api/v1/execute`` or ``/api/settings/export`` with no cookie. It
    stays in the activity file but must not land in Recent problems. Failed
    logins (``/api/auth/*``) and every other refusal stay WARNING.
    """
    if status < 400:
        return logging.INFO
    if status in (401, 403) and not path.startswith("/api/auth/"):
        return logging.INFO
    return logging.WARNING


async def log_request_activity(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    method, path = request.method, request.url.path
    subject = subject_for(method, path)
    if subject is None:
        return await call_next(request)
    started = time.perf_counter()
    response = await call_next(request)
    route = getattr(request.scope.get("route"), "path", path)
    ok = response.status_code < 400
    label = _LABELS.get((method, route))
    what = label[0 if ok else 1] if label else f"{method} {route}"
    client = request.client.host if request.client else "-"
    agent = (request.headers.get("user-agent") or "-")[:120]
    activity(subject).log(
        _level(response.status_code, path),
        "%s status=%d ip=%s ms=%d path=%s %s ua=%s",
        what,
        response.status_code,
        client,
        (time.perf_counter() - started) * 1000,
        path,
        method,
        agent,
    )
    return response
