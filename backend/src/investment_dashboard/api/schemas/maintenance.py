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


class TiingoUse(ApiModel):
    title: str
    detail: str


class TiingoUsage(ApiModel):
    """The Tiingo backup: key present, the app's own caps, calls used and left."""

    configured: bool
    hourly_cap: int
    daily_cap: int
    hour_used: int
    day_used: int
    #: Calls still allowed now (the smaller of what is left this hour and today).
    remaining: int
    #: Next reset of the hourly bucket (top of the UTC hour) and the daily one
    #: (midnight New York time), ISO UTC.
    hour_resets_at: str
    day_resets_at: str
    #: Tiingo answered HTTP 429 (its own allowance spent) this hour, if it did.
    rate_limited_at: str | None = None
    nav_probes_today: int = 0
    last_status: str | None = None
    last_message: str | None = None
    last_at: str | None = None
    uses: list[TiingoUse]


class TwinDivergenceStats(ApiModel):
    """Twin-vs-fund divergence over the configured look-back window.

    Every figure here is in PERCENTAGE POINTS (``0.03`` = 0.03 pp — the same
    convention as ``TwinDivergence`` in the Holdings API), never a fraction like
    ``currency_effect_pp`` elsewhere (``/api/overview``) despite the similar name.
    Gaps are ``twin return - fund return``: positive means the twin ran ahead,
    i.e. the estimate was too high. Sessions with a dividend or distribution are
    left out.
    """

    last_gap_pp: DecStr = Field(description="Newest usable session's gap, in percentage points")
    last_date: str = Field(description="Session the last_gap_pp figure is from (ISO date)")
    median_abs_pp: DecStr = Field(description="Median absolute gap over the window, in pp")
    bias_pp: DecStr = Field(
        description="Mean signed gap over the window, in pp (positive: twin ran ahead)"
    )
    sessions: int = Field(description="Sessions actually used (at most the configured window)")


class TwinFundHealth(ApiModel):
    """One fund's ETF-twin mapping: live status + stored history + accuracy."""

    instrument_id: int
    symbol: str = Field(description="The fund's own ticker")
    name: str
    twin_symbol: str = Field(description="The mapped ETF twin's ticker")
    estimating: bool = Field(
        description="Being estimated from the twin right now (NAV pending, held, estimates on)"
    )
    stored_sessions: int = Field(description="Session-close rows stored for this twin")
    first_session: str | None = Field(
        default=None, description="Oldest stored twin session-close date (ISO), or null"
    )
    last_session: str | None = Field(
        default=None, description="Newest stored twin session-close date (ISO), or null"
    )
    last_price_at: str | None = Field(
        default=None,
        description="Instant of the newest stored twin price of any kind (ISO UTC), or null",
    )
    year_backfill_done: bool = Field(
        description="Whether the one-year daily-close backfill has completed for this twin"
    )
    divergence: TwinDivergenceStats | None = Field(
        default=None, description="Null when there are not enough shared sessions yet"
    )


class TwinHealth(ApiModel):
    """ETF-twin settings + one entry per fund with a twin mapping, for Health & Repair."""

    enabled: bool = Field(description="Setting twin.estimates_enabled")
    window: int = Field(description="Setting twin.divergence_window, in sessions")
    funds: list[TwinFundHealth]


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
