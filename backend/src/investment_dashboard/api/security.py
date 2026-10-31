"""Request authentication.

``authenticate`` accepts a valid server-side session cookie (sliding idle
timeout, absolute max age) or, for scripts, the configured API token
(``Authorization: Bearer`` / ``X-API-Token``). The token is accepted only when
``settings.api_token`` is set; nothing is open by default. Cookie-authenticated
unsafe requests must carry an ``Origin`` equal to ``settings.webauthn_origin``.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass

from fastapi import HTTPException, Request, status
from starlette.concurrency import run_in_threadpool

from investment_dashboard.api.token_auth import _extract_token
from investment_dashboard.config import Settings, get_settings
from investment_dashboard.db import config_session_scope
from investment_dashboard.services import auth_service

UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


@dataclass(frozen=True)
class Principal:
    """Who is calling: ``kind`` is ``"session"`` or ``"token"``."""

    kind: str
    session_id: str | None = None


def cookie_name(settings: Settings) -> str:
    return "__Host-session" if settings.cookie_secure else "session"


def check_origin(request: Request, settings: Settings) -> None:
    """Reject unsafe requests whose Origin is missing or not the app's own."""
    if request.method not in UNSAFE_METHODS:
        return
    origin = request.headers.get("origin")
    if origin is None or not secrets.compare_digest(
        origin.rstrip("/").encode("utf-8"), settings.webauthn_origin.rstrip("/").encode("utf-8")
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Cross-origin request rejected.")


def _token_ok(request: Request, settings: Settings) -> bool:
    configured = settings.api_token
    if not configured:
        return False
    presented = _extract_token(
        request.headers.get("authorization"), request.headers.get("x-api-token")
    )
    if presented is None:
        return False
    return secrets.compare_digest(presented.encode("utf-8"), configured.encode("utf-8"))


def _session_lookup(token: str, settings: Settings) -> str | None:
    with config_session_scope() as db:
        return auth_service.validate_session(db, settings, token)


async def resolve_principal(request: Request) -> Principal | None:
    """The caller's principal, or ``None`` (only side effect: sliding the session)."""
    settings = get_settings()
    if _token_ok(request, settings):
        return Principal(kind="token")
    token = request.cookies.get(cookie_name(settings))
    if token:
        sid = await run_in_threadpool(_session_lookup, token, settings)
        if sid is not None:
            return Principal(kind="session", session_id=sid)
    return None


async def authenticate(request: Request) -> Principal:
    principal = await resolve_principal(request)
    if principal is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Not authenticated.")
    if principal.kind == "session":
        check_origin(request, get_settings())
    request.state.principal = principal
    return principal
