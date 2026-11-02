"""Request guard: authenticate and cap the body size before a route reads it.

FastAPI parses a route's JSON/form body *before* it runs the route's
dependencies, so an auth dependency alone lets an anonymous client make the
server buffer (or spool) a large body. :class:`RequestGuard` is a plain ASGI
middleware in front of every route that:

* rejects a body larger than the route's cap with 413 — on ``Content-Length``
  up front and on the bytes actually streamed (chunked uploads);
* authenticates guarded ``/api/*`` paths (everything except the public
  ``health`` and ``auth`` routers) from headers/cookies only, stores the
  :class:`~investment_dashboard.api.security.Principal` in ``request.state``
  and answers 401/403/429 without ever reading the body.
  :func:`investment_dashboard.api.deps.require_auth` then reuses that principal.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from investment_dashboard.config import Settings, get_settings

API_PREFIX = "/api"
#: ``/api`` path prefixes that are not authenticated by the guard (they guard per route).
PUBLIC_API_PREFIXES: tuple[str, ...] = ("/api/health", "/api/auth")
#: (method, exact path) routes allowed the upload cap instead of the default cap.
UPLOAD_ROUTES: frozenset[tuple[str, str]] = frozenset({("POST", "/api/imports")})


def body_limit(method: str, path: str, settings: Settings) -> int:
    """Largest body (bytes) accepted for ``method path``."""
    if (method, path.rstrip("/") or "/") in UPLOAD_ROUTES:
        return settings.max_upload_body_bytes
    return settings.max_body_bytes


def is_guarded(path: str) -> bool:
    """True for ``/api`` paths the guard authenticates up front."""
    if path != API_PREFIX and not path.startswith(API_PREFIX + "/"):
        return False
    return not any(path == p or path.startswith(p + "/") for p in PUBLIC_API_PREFIXES)


class _BodyTooLarge(HTTPException):
    def __init__(self) -> None:
        super().__init__(413, detail="Request body is too large.")


def _error(exc: HTTPException) -> JSONResponse:
    return JSONResponse(
        {"detail": exc.detail}, status_code=exc.status_code, headers=dict(exc.headers or {})
    )


def _auth_overridden(scope: Scope) -> bool:
    """True when a test replaced ``require_auth`` via ``dependency_overrides``."""
    from investment_dashboard.api.deps import require_auth  # noqa: PLC0415

    app: Any = scope.get("app")
    overrides = getattr(app, "dependency_overrides", None) or {}
    return require_auth in overrides


class RequestGuard:
    """ASGI middleware: body caps for every request, auth-first for guarded APIs."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        settings = get_settings()
        limit = body_limit(scope["method"], scope["path"], settings)
        declared = _content_length(scope)
        if declared is not None and declared > limit:
            await _error(_BodyTooLarge())(scope, receive, send)
            return

        if is_guarded(scope["path"]) and not _auth_overridden(scope):
            from investment_dashboard.api import security  # noqa: PLC0415

            try:
                # Headers and cookies only: the body is not touched.
                await security.authenticate(Request(scope))
            except HTTPException as exc:
                await _error(exc)(scope, receive, send)
                return

        received = 0

        async def capped_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise _BodyTooLarge()
            return message

        started = False

        async def tracking_send(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, capped_receive, tracking_send)
        except _BodyTooLarge as exc:
            # Normally FastAPI turns the raise into a 413 itself; this covers a
            # body read outside its handler.
            if started:
                raise
            await _error(exc)(scope, receive, send)


def _content_length(scope: Scope) -> int | None:
    for name, value in scope.get("headers", ()):
        if name == b"content-length":
            try:
                return int(value)
            except ValueError:
                return None
    return None
