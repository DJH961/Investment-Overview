"""Schemas for the ops endpoints (refresh trigger/status)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import Field

from investment_dashboard.api.schemas.common import ApiModel


class AnnounceRestart(ApiModel):
    """Body of the loopback-only ``POST /api/ops/announce-restart``."""

    state: Literal["restarting", "restart_planned"]
    version: str | None = Field(default=None, max_length=64)
    eta_s: int | None = Field(default=None, ge=0, le=3600)
    at: str | None = Field(default=None, max_length=64)


class RefreshStatus(ApiModel):
    running: bool
    source: str | None = None
    seq: int
    last_update_at: datetime | None = None
    historical: bool = False
    progress_done: int = 0
    progress_total: int = 0
    progress_label: str | None = None
