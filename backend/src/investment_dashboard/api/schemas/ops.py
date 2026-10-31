"""Schemas for the ops endpoints (refresh trigger/status)."""

from __future__ import annotations

from datetime import datetime

from investment_dashboard.api.schemas.common import ApiModel


class RefreshStatus(ApiModel):
    running: bool
    source: str | None = None
    seq: int
    last_update_at: datetime | None = None
    historical: bool = False
    progress_done: int = 0
    progress_total: int = 0
    progress_label: str | None = None
