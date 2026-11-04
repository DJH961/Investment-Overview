"""``/api/auth`` router: password + passkey login, logout, passkey management.

Public router: every route except login/logout/passkey-login/``me`` depends on
:func:`investment_dashboard.api.deps.require_auth`. State-changing routes check
the ``Origin`` header; routes with a body also require ``Content-Type:
application/json``. Adding or removing a passkey needs a *fresh* cookie session
(:func:`investment_dashboard.api.security.require_fresh_session`).

Login attempts are counted *before* the check (a reserved slot, refunded on
success), so concurrent guesses cannot all slip past the limit. Password checks
are capped at ``settings.login_max_concurrent_verifies`` at a time (503 +
``Retry-After`` when busy). Passkey failures use their own per-IP limiter and
never touch the global password cap.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Annotated, Any

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response, status
from sqlalchemy.orm import Session

from investment_dashboard.api import security
from investment_dashboard.api.deps import ConfigSessionDep, require_auth
from investment_dashboard.api.schemas.auth import (
    LoginBody,
    MeResponse,
    PasskeyLoginOptionsBody,
    PasskeyNameBody,
    PasskeyOut,
)
from investment_dashboard.config import Settings, get_settings
from investment_dashboard.services import auth_service

if TYPE_CHECKING:
    from investment_dashboard.models import AuthPasskey

router = APIRouter(prefix="/auth", tags=["auth"])

SettingsDep = Annotated[Settings, Depends(get_settings)]


def _same_origin(request: Request, settings: SettingsDep) -> None:
    security.check_origin(request, settings)


def _json_only(request: Request) -> None:
    ctype = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if ctype != "application/json":
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="Content-Type must be application/json."
        )


OriginGuard = Depends(_same_origin)
JsonGuard = Depends(_json_only)


def _challenge_cookie_name(settings: Settings) -> str:
    return "__Host-wa" if settings.cookie_secure else "wa"


def _set_cookie(
    response: Response, settings: Settings, name: str, value: str, max_age: int
) -> None:
    response.set_cookie(
        key=name,
        value=value,
        max_age=max_age,
        path="/",
        secure=settings.cookie_secure,
        httponly=True,
        samesite="strict",
    )


def _clear_cookie(response: Response, settings: Settings, name: str) -> None:
    response.delete_cookie(
        key=name, path="/", secure=settings.cookie_secure, httponly=True, samesite="strict"
    )


def _client_key(request: Request) -> str:
    return security.client_key(request)


def _too_many(wait: int) -> HTTPException:
    return HTTPException(
        status.HTTP_429_TOO_MANY_REQUESTS,
        detail="Too many failed attempts; try again later.",
        headers={"Retry-After": str(wait)},
    )


def _has_session(request: Request, settings: Settings, db: Session) -> bool:
    token = request.cookies.get(security.cookie_name(settings))
    return bool(token) and auth_service.validate_session(db, settings, token or "") is not None


def _reserve(
    request: Request,
    settings: Settings,
    db: Session,
    limiter: auth_service.RateLimiter,
    limit: int | None = None,
) -> auth_service.Reservation:
    """Count this attempt up front (429 when over); a live session skips the global cap."""
    try:
        return limiter.reserve(
            _client_key(request),
            limit
            if limit is not None
            else auth_service.limit(settings, "login_rate_limit_per_minute"),
            bypass_global=_has_session(request, settings, db),
        )
    except auth_service.RateLimitedError as exc:
        raise _too_many(exc.retry_after) from None


def _start_session(request: Request, response: Response, db: Session, settings: Settings) -> None:
    """Rotate: drop any session presented with the request, then issue a new one."""
    old = request.cookies.get(security.cookie_name(settings))
    if old:
        auth_service.delete_session(db, old)
    token = auth_service.create_session(db, settings, request.headers.get("user-agent"))
    _set_cookie(
        response,
        settings,
        security.cookie_name(settings),
        token,
        auth_service.limit(settings, "session_max_age_days") * 86400,
    )


@router.post(
    "/login",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[OriginGuard, JsonGuard],
)
def login(
    body: LoginBody,
    request: Request,
    db: ConfigSessionDep,
    settings: SettingsDep,
) -> Response:
    if not auth_service.has_password(db):
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="password not set: run inv-dashboard-set-password",
        )
    slot = _reserve(request, settings, db, auth_service.rate_limiter)
    try:
        ok = auth_service.verify_password(
            db, body.password, max_concurrent=settings.login_max_concurrent_verifies
        )
    except auth_service.VerifierBusyError:
        slot.refund()  # nothing was checked: do not count it
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Sign-in is busy; try again in a moment.",
            headers={"Retry-After": str(auth_service.VerifierBusyError.retry_after)},
        ) from None
    if not ok:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials.")
    slot.refund()
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    _start_session(request, response, db, settings)
    return response


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT, dependencies=[OriginGuard])
def logout(request: Request, db: ConfigSessionDep, settings: SettingsDep) -> Response:
    token = request.cookies.get(security.cookie_name(settings))
    if token:
        auth_service.delete_session(db, token)
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    _clear_cookie(response, settings, security.cookie_name(settings))
    return response


@router.get("/me", response_model=MeResponse)
async def me(request: Request, db: ConfigSessionDep) -> MeResponse:
    principal = await security.resolve_principal(request)
    if principal is None:
        return MeResponse(authenticated=False)
    return MeResponse(authenticated=True, passkeys=auth_service.passkey_count(db))


# ------------------------------------------------------------------ passkey login (public)


@router.post("/passkey/login/options", dependencies=[OriginGuard])
def passkey_login_options(
    request: Request,
    db: ConfigSessionDep,
    settings: SettingsDep,
    body: Annotated[PasskeyLoginOptionsBody | None, Body()] = None,
) -> Response:
    # Every request counts (options are unauthenticated and allocate a challenge).
    limit = max(auth_service.limit(settings, "login_rate_limit_per_minute") * 6, 30)
    _reserve(request, settings, db, auth_service.options_limiter, limit)
    options_json, key = auth_service.authentication_options(
        settings, db, body.credential_id if body else None
    )
    response = Response(content=options_json, media_type="application/json")
    _set_cookie(
        response,
        settings,
        _challenge_cookie_name(settings),
        key,
        auth_service.CHALLENGE_TTL_SECONDS,
    )
    return response


@router.post(
    "/passkey/login/verify",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[OriginGuard, JsonGuard],
)
def passkey_login_verify(
    request: Request,
    db: ConfigSessionDep,
    settings: SettingsDep,
    credential: Annotated[dict[str, Any], Body()],
) -> Response:
    slot = _reserve(request, settings, db, auth_service.passkey_limiter)
    cname = _challenge_cookie_name(settings)
    try:
        auth_service.authenticate_passkey(db, settings, request.cookies.get(cname), credential)
    except auth_service.PasskeyError:
        # Persist nothing from a failed ceremony; the scope rolls back on raise.
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials.") from None
    slot.refund()
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    _clear_cookie(response, settings, cname)
    _start_session(request, response, db, settings)
    return response


# ------------------------------------------------------------------ passkey management


FreshSession = Depends(security.require_fresh_session)


@router.post("/passkey/register/options", dependencies=[FreshSession])
def passkey_register_options(
    db: ConfigSessionDep,
    settings: SettingsDep,
    body: Annotated[PasskeyNameBody | None, Body()] = None,
) -> Response:
    options_json, key = auth_service.registration_options(db, settings, body.name if body else None)
    response = Response(content=options_json, media_type="application/json")
    _set_cookie(
        response,
        settings,
        _challenge_cookie_name(settings),
        key,
        auth_service.CHALLENGE_TTL_SECONDS,
    )
    return response


@router.post(
    "/passkey/register/verify",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[FreshSession, JsonGuard],
)
def passkey_register_verify(
    request: Request,
    db: ConfigSessionDep,
    settings: SettingsDep,
    credential: Annotated[dict[str, Any], Body()],
) -> Response:
    cname = _challenge_cookie_name(settings)
    name = credential.get("name")
    try:
        auth_service.register_passkey(
            db,
            settings,
            request.cookies.get(cname),
            credential,
            name if isinstance(name, str) else None,
        )
    except auth_service.PasskeyError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from None
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    _clear_cookie(response, settings, cname)
    return response


def _out(row: AuthPasskey) -> PasskeyOut:
    return PasskeyOut(
        id=row.id,
        name=row.name,
        created_at=row.created_at.isoformat() if row.created_at else None,
        last_used_at=row.last_used_at.isoformat() if row.last_used_at else None,
    )


@router.get("/passkeys", response_model=list[PasskeyOut], dependencies=[Depends(require_auth)])
def list_passkeys(db: ConfigSessionDep) -> list[PasskeyOut]:
    return [_out(r) for r in auth_service.list_passkeys(db)]


@router.delete(
    "/passkeys/{passkey_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[FreshSession],
)
def delete_passkey(passkey_id: int, db: ConfigSessionDep) -> Response:
    if not auth_service.delete_passkey(db, passkey_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Passkey not found.")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
