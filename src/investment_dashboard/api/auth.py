"""Minimal, optional bearer-token auth for the JSON API.

Security model (deliberately small, per the project's single-user,
local-first design):

* When ``settings.api_token`` is unset the API is **open** — fine on a
  trusted home LAN, which is the default deployment.
* When a token is set, every guarded route requires it, supplied either
  as a bearer token in the ``Authorization`` header or as an
  ``X-API-Token`` header. The comparison is constant-time to avoid
  leaking the token via timing.

This is the "minimal safety that stays efficient" the owner asked for:
enough to stop casual access once the server is exposed beyond the LAN
(e.g. through a VPN or reverse proxy), without dragging in OAuth/session
infrastructure a single user doesn't need.
"""

from __future__ import annotations

import secrets

from fastapi import Header, HTTPException, status

from investment_dashboard.config import get_settings


def _extract_token(authorization: str | None, x_api_token: str | None) -> str | None:
    if x_api_token:
        return x_api_token
    if authorization:
        scheme, _, credentials = authorization.partition(" ")
        if scheme.lower() == "bearer" and credentials:
            return credentials
    return None


async def require_token(
    authorization: str | None = Header(default=None),
    x_api_token: str | None = Header(default=None, alias="X-API-Token"),
) -> None:
    """FastAPI dependency enforcing the configured API token, if any."""
    configured = get_settings().api_token
    if not configured:
        return  # Auth disabled — open API (trusted LAN default).
    presented = _extract_token(authorization, x_api_token)
    if presented is None or not secrets.compare_digest(presented, configured):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid API token.",
            headers={"WWW-Authenticate": "Bearer"},
        )
