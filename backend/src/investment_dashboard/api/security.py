"""Request authentication.

``authenticate`` accepts a valid server-side session cookie (sliding idle
timeout, absolute max age) or, for scripts, the configured API token
(``Authorization: Bearer`` / ``X-API-Token``). The token is accepted only when
``settings.api_token`` is set; nothing is open by default. Cookie-authenticated
unsafe requests must carry an ``Origin`` equal to ``settings.webauthn_origin``.

Sensitive routes add :func:`require_fresh_session`: a cookie session (never the
API token) that signed in within ``settings.fresh_session_minutes``; otherwise
403 with ``detail.code == "reauth_required"`` (the frontend sends the user to
``/login?next=…``).
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


def _presented_token(request: Request) -> str | None:
    return _extract_token(request.headers.get("authorization"), request.headers.get("x-api-token"))


def client_key(request: Request) -> str:
    return auth_service.client_key(request.client.host if request.client else None)


def _token_ok(presented: str, settings: Settings) -> bool:
    configured = settings.api_token
    if not configured:
        return False
    return secrets.compare_digest(presented.encode("utf-8"), configured.encode("utf-8"))


def _session_lookup(token: str, settings: Settings) -> str | None:
    with config_session_scope() as db:
        return auth_service.validate_session(db, settings, token)


def _session_peek(token: str, settings: Settings) -> bool:
    with config_session_scope() as db:
        return auth_service.peek_session(db, settings, token)


async def still_authenticated(request: Request) -> bool:
    """Re-check a long-lived connection's credentials without extending the session.

    Unlike :func:`authenticate`, a valid session is NOT slid (so an open stream
    cannot keep an idle session alive) and failed tokens are not rate-counted.
    """
    settings = get_settings()
    token = request.cookies.get(cookie_name(settings))
    if token and await run_in_threadpool(_session_peek, token, settings):
        return True
    presented = _presented_token(request)
    return presented is not None and _token_ok(presented, settings)


async def resolve_principal(request: Request) -> Principal | None:
    """The caller's principal, or ``None`` (only side effect: sliding the session).

    A session is tried first. A presented API token that does not match counts
    as a failed attempt against the per-IP token limiter (429 once exceeded).
    Token failures have their own limiter, so they never use up the password
    login budget.
    """
    settings = get_settings()
    token = request.cookies.get(cookie_name(settings))
    if token:
        sid = await run_in_threadpool(_session_lookup, token, settings)
        if sid is not None:
            return Principal(kind="session", session_id=sid)
    presented = _presented_token(request)
    if presented is not None:
        key = client_key(request)
        wait = auth_service.token_limiter.retry_after(key, settings.login_rate_limit_per_minute)
        if wait is not None:
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many failed attempts; try again later.",
                headers={"Retry-After": str(wait)},
            )
        if _token_ok(presented, settings):
            return Principal(kind="token")
        auth_service.token_limiter.record_failure(key)
    return None


async def authenticate(request: Request) -> Principal:
    principal = await resolve_principal(request)
    if principal is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Not authenticated.")
    if principal.kind == "session":
        check_origin(request, get_settings())
    request.state.principal = principal
    return principal


REAUTH_REQUIRED = "reauth_required"
SESSION_REQUIRED = "session_required"


def _session_is_fresh(session_id: str, settings: Settings) -> bool:
    with config_session_scope() as db:
        return auth_service.session_is_fresh(db, settings, session_id)


async def require_fresh_session(request: Request) -> Principal:
    """Dependency: a cookie session that signed in recently (sensitive actions).

    The API token is refused (403 ``session_required``): a leaked script token
    must not be able to add a passkey or take the database off the server. A
    session older than ``settings.fresh_session_minutes`` gets 403
    ``reauth_required``; signing in again issues a new, fresh session.
    """
    principal = getattr(request.state, "principal", None)
    if not isinstance(principal, Principal):
        principal = await authenticate(request)
    if principal.kind != "session" or principal.session_id is None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail={"code": SESSION_REQUIRED, "message": "Sign in with the app to do this."},
        )
    settings = get_settings()
    if not await run_in_threadpool(_session_is_fresh, principal.session_id, settings):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            detail={"code": REAUTH_REQUIRED, "message": "Please sign in again to continue."},
        )
    return principal
