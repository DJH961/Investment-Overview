"""``/api/auth`` router (stub — filled by task B4; see docs/v6_progress.md).

Public router: each route except login/passkey-login must itself depend on
:func:`investment_dashboard.api.deps.require_auth`.
"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(prefix="/auth", tags=["auth"])
