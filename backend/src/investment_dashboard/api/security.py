"""Request authentication (owned by task B4).

Contract: ``async def authenticate(request: Request) -> Principal`` raises
``HTTPException(401)`` unless the request carries a valid session cookie or the
configured bearer token (``settings.api_token``, kept for scripts and the
future LLM). On success it stores the principal on ``request.state.principal``.

STUB until B4 lands: always rejects, so nothing is ever accidentally open.
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import HTTPException, Request, status


@dataclass(frozen=True)
class Principal:
    """Who is calling: ``kind`` is ``"session"`` or ``"token"``."""

    kind: str
    session_id: str | None = None


async def authenticate(request: Request) -> Principal:
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated.")
