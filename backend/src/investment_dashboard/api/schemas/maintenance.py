"""Schemas for ``/api/maintenance`` (Health & Repair) and ``/api/system``."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import ConfigDict, Field

from investment_dashboard.api.schemas.common import ApiModel, DecStr

Danger = Literal["none", "confirm", "typed"]
JobStatus = Literal["running", "succeeded", "failed"]


class JobParam(ApiModel):
    name: str
    type: Literal["bool", "int", "date", "enum", "string"]
    label: str
    required: bool
    default: Any = None
    choices: list[str]
    help: str


class JobRun(ApiModel):
    id: str
    job: str
    params: dict[str, Any]
    actor: str
    status: JobStatus
    started_at: str
    finished_at: str | None
    result: dict[str, Any] | None
    error: str | None = Field(description="Exception message only (no traceback).")


class JobInfo(ApiModel):
    id: str
    label: str
    group: str
    description: str
    danger: Danger = Field(
        description="none: run; confirm: send confirm='yes'; typed: send confirm=confirm_word."
    )
    confirm_word: str | None
    heavy: bool = Field(description="Shares the one-at-a-time lock with other heavy jobs.")
    backup_first: bool
    params: list[JobParam]
    running: bool
    last_run: JobRun | None


class JobGroup(ApiModel):
    id: str
    label: str


class JobCatalogue(ApiModel):
    groups: list[JobGroup]
    jobs: list[JobInfo]
    recent: list[JobRun]
    heavy_job: str | None
    generated_at: str


class JobStart(ApiModel):
    model_config = ConfigDict(extra="forbid")

    params: dict[str, Any] = Field(default_factory=dict)
    confirm: str | None = None


class MaintenanceErrorDto(ApiModel):
    detail: str
    errors: dict[str, str]


class SchedulerJob(ApiModel):
    name: Literal["tick", "fx", "eod", "backup"]
    running: bool
    requested: bool
    last_run_at: str | None
    last_failed: bool
    paused_until: str | None


class SchedulerState(ApiModel):
    enabled: bool
    now: str | None = None
    market_state: str | None = None
    jobs: list[SchedulerJob] = Field(default_factory=list)
    last_eod_session: str | None = None
    heavy_job: str | None = None


class SchedulerPause(ApiModel):
    model_config = ConfigDict(extra="forbid")

    jobs: list[Literal["tick", "fx", "eod", "backup"]] = Field(min_length=1)
    paused: bool
    hours: int | None = Field(
        default=None, ge=1, le=168, description="Default: scheduler.pause_default_hours."
    )


class ProbeRequest(ApiModel):
    model_config = ConfigDict(extra="forbid")

    provider: Literal["yfinance", "tiingo"]
    symbol: str = Field(min_length=1, max_length=20, pattern=r"^[A-Za-z0-9^.\-=]+$")


class ProbeResult(ApiModel):
    provider: str
    provider_label: str
    symbol: str
    price: DecStr | None
    as_of: date | None
    duration_ms: int
    verdict: str
    detail: str


class LogLine(ApiModel):
    ts: str
    level: str
    logger: str
    message: str
    traceback: str | None


class LogsDto(ApiModel):
    source: str
    sources: list[str]
    entries: list[LogLine]


class BackupInfo(ApiModel):
    name: str
    created: datetime
    size_bytes: int


class BackupsDto(ApiModel):
    configured: bool
    directory: str
    snapshots: list[BackupInfo]


class ClosePoint(ApiModel):
    date: date
    close: DecStr
    source: str


class PricesDto(ApiModel):
    instrument_id: int
    closes: list[ClosePoint]


class ManualClose(ApiModel):
    model_config = ConfigDict(extra="forbid")

    close: DecStr


class RatePoint(ApiModel):
    date: date
    rate: DecStr
    source: str


class RatesDto(ApiModel):
    base: str
    quote: str
    rates: list[RatePoint]


class ManualRate(ApiModel):
    model_config = ConfigDict(extra="forbid")

    rate: DecStr


class SplitPoint(ApiModel):
    date: date
    ratio: DecStr
    source: str


class SplitsDto(ApiModel):
    instrument_id: int
    splits: list[SplitPoint]


class ManualSplit(ApiModel):
    model_config = ConfigDict(extra="forbid")

    ratio: DecStr


class AnomaliesDto(ApiModel):
    instrument_ids: list[int]


class SystemInfo(ApiModel):
    version: str
    image_tag: str | None
    started_at: str
    uptime_seconds: int
    server_mode: bool
    scheduler_enabled: bool
    encrypted: bool
    split_db: bool
    api_token_enabled: bool
    backup_passphrase_set: bool
    backup_falls_back_to_db_key: bool
    paths: dict[str, str]
    db_size_bytes: int | None
    migrations: dict[str, str | None] = Field(description="{current, head} Alembic revisions.")
    env_shadowed_by_app: list[str] = Field(
        description="Settings whose in-app value overrides an env value."
    )
