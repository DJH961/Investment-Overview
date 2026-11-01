"""``GET /api/health`` — unauthenticated liveness/version probe."""

from __future__ import annotations

from fastapi import APIRouter

from investment_dashboard import __version__
from investment_dashboard.api.schemas.common import ApiModel

router = APIRouter(tags=["health"])


class Health(ApiModel):
    status: str
    app_version: str


@router.get("/health", response_model=Health)
def health() -> Health:
    return Health(status="ok", app_version=__version__)
