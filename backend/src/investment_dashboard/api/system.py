"""``/api/system``: read-only facts about the running server (version, paths, flags)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from investment_dashboard.api.schemas.maintenance import SystemInfo
from investment_dashboard.services import system_service

router = APIRouter(tags=["system"])


@router.get("/system", response_model=SystemInfo)
def get_system() -> dict[str, Any]:
    return system_service.info()
