"""Schemas for ``/api/diagnostics``."""

from __future__ import annotations

from investment_dashboard.api.schemas.common import ApiModel


class CheckOut(ApiModel):
    id: str
    title: str
    severity: str
    count: int
    detail: str
    examples: list[str]


class ProviderOut(ApiModel):
    name: str
    status: str | None
    message: str | None
    at: str | None
    last_fetch_at: str | None
    last_fetch_symbols: list[str]


class ProviderEventOut(ApiModel):
    provider: str
    status: str
    message: str
    at: str | None


class ProblemOut(ApiModel):
    id: int
    source: str
    message: str
    severity: str
    at: str | None


class RefreshOut(ApiModel):
    active: bool
    source: str | None
    last_update_at: str | None
    historical: bool
    progress_done: int
    progress_total: int
    progress_label: str | None


class DiagnosticsOut(ApiModel):
    """Data-health report. Provider/problem lists are process-local (empty after a restart)."""

    status: str
    count: int
    generated_at: str
    checks: list[CheckOut]
    providers: list[ProviderOut]
    provider_log: list[ProviderEventOut]
    problems: list[ProblemOut]
    refresh: RefreshOut
