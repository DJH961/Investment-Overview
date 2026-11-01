"""Request activity: one line per relevant API call into the subject's log.

Logged: every write (POST/PUT/PATCH/DELETE) except pure calculations, plus the
downloads that take data off the server (backup, support bundle). Never logged:
request bodies, query strings, cookies or tokens. See
:mod:`investment_dashboard.activity_log` for the files and their retention.
"""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable

from fastapi import Request, Response

from investment_dashboard.activity_log import activity

_WRITES = frozenset({"POST", "PUT", "PATCH", "DELETE"})
#: Writes that change nothing (they only compute a result).
_READ_ONLY_WRITES = frozenset({"/api/calculator", "/api/auth/passkey/login/options"})
#: Reads worth recording because they take data off the server.
_DOWNLOADS = {"/api/backup": "backups", "/api/diagnostics/support-bundle": "system"}

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
    ("POST", "/api/refresh"): ("manual refresh requested", "manual refresh refused"),
    ("GET", "/api/backup"): ("backup downloaded", "backup download failed"),
    ("GET", "/api/diagnostics/support-bundle"): (
        "support bundle downloaded",
        "support bundle failed",
    ),
}


def subject_for(method: str, path: str) -> str | None:
    """The activity subject for a request, or ``None`` when it is not logged."""
    if method in _WRITES:
        if path in _READ_ONLY_WRITES or not path.startswith("/api/"):
            return None
        if path.startswith("/api/auth/"):
            return "auth"
        if path.startswith("/api/imports"):
            return "imports"
        if path == "/api/refresh":
            return "market_data"
        return "changes"
    return _DOWNLOADS.get(path) if method == "GET" else None


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
        20 if ok else 30,  # INFO / WARNING
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
