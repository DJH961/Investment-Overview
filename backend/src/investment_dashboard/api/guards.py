"""Extra guards for dangerous routes (maintenance jobs, secrets, settings import).

* :func:`require_session` — the caller must be a logged-in **browser session**,
  not the API token (scripts may read, but never run repairs or change secrets).
* :func:`require_fresh` — for destructive actions and secret changes. It runs
  :func:`require_session` and then the fresh-session check.

  TODO(security-branch): when ``security.require_fresh_session`` (re-auth within
  ``fresh_session_minutes``) is merged, call it from :func:`_fresh_session_check`
  below. Until then the fallback is a valid cookie session plus the server-side
  typed confirmation.

Both put the acting principal on ``request.state.actor`` (``session:<id8>`` or
``token``) for the settings audit and job log.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, HTTPException, Request, status

from investment_dashboard.api.security import Principal, resolve_principal


async def _principal(request: Request) -> Principal | None:
    principal = getattr(request.state, "principal", None)
    if isinstance(principal, Principal):
        return principal
    return await resolve_principal(request)


def actor_of(principal: Principal | None) -> str:
    if principal is None:
        return "unknown"
    if principal.kind == "session":
        return f"session:{(principal.session_id or '')[:8]}"
    return principal.kind


async def current_actor(request: Request) -> str:
    """Who is calling (any authenticated principal)."""
    return actor_of(await _principal(request))


async def require_session(request: Request) -> str:
    """403 unless the caller is a browser session; returns the actor string."""
    principal = await _principal(request)
    if principal is None or principal.kind != "session":
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, detail="This action needs a signed-in browser session."
        )
    return actor_of(principal)


async def _fresh_session_check(request: Request) -> None:
    """Hook for ``security.require_fresh_session`` (see the module TODO)."""
    return None


async def require_fresh(request: Request) -> str:
    actor = await require_session(request)
    await _fresh_session_check(request)
    return actor


def request_id(request: Request) -> str | None:
    value = request.headers.get("x-request-id")
    return value[:64] if value else None


ActorDep = Annotated[str, Depends(current_actor)]
SessionActorDep = Annotated[str, Depends(require_session)]
FreshActorDep = Annotated[str, Depends(require_fresh)]
RequestIdDep = Annotated[str | None, Depends(request_id)]
