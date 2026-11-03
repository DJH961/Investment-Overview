"""Payload models for the ``/api/stream`` server-sent events.

Each SSE message is one ``data:`` line holding a JSON object whose ``type``
discriminates it (the frontend ``lib/live.ts`` reads ``type`` only).
"""

from __future__ import annotations

from typing import Any, Literal

from investment_dashboard.api.schemas.common import ApiModel, DecStr

MarketState = Literal["open", "closed", "holiday"]


class HelloEvent(ApiModel):
    type: Literal["hello"] = "hello"
    ts: str
    market_state: MarketState


class TickEvent(ApiModel):
    """A market-hours poll finished: prices, FX and the intraday sample are fresh."""

    type: Literal["tick"] = "tick"
    ts: str
    market_state: MarketState
    total_value_eur: DecStr | None = None
    #: EUR total x the live spot at ``ts`` (single instant, so the conversion is valid).
    total_value_usd: DecStr | None = None
    #: Live EUR->USD rate at ``ts`` (USD per EUR).
    fx_eur_usd: DecStr | None = None
    #: When the last refresh brought in new prices (null: none yet in this process).
    last_update_at: str | None = None
    #: Market open and a price landed within the live window.
    prices_live: bool | None = None


class RefreshEvent(ApiModel):
    """End-of-day jobs finished: clients should refetch everything."""

    type: Literal["refresh"] = "refresh"
    ts: str
    market_state: MarketState


class FxEvent(ApiModel):
    """Off-hours FX refresh."""

    type: Literal["fx"] = "fx"
    ts: str
    market_state: MarketState
    fx_eur_usd: DecStr | None = None


class RefreshStartedEvent(ApiModel):
    """A price refresh (scheduled tick, manual or historic download) started."""

    type: Literal["refresh_started"] = "refresh_started"
    ts: str
    market_state: MarketState
    source: str


class RefreshProgressEvent(ApiModel):
    """A historic-data download advanced one stage."""

    type: Literal["refresh_progress"] = "refresh_progress"
    ts: str
    market_state: MarketState
    historical: bool
    progress_done: int
    progress_total: int
    progress_label: str | None = None


class RefreshFinishedEvent(ApiModel):
    """Every running price refresh finished (``updated``: new data landed)."""

    type: Literal["refresh_finished"] = "refresh_finished"
    ts: str
    market_state: MarketState
    source: str
    updated: bool
    last_update_at: str | None = None


class GraphsEvent(ApiModel):
    """A ``POST /api/graphs/{range}/reload`` finished: refetch that graph."""

    type: Literal["graphs"] = "graphs"
    ts: str
    market_state: MarketState
    range: str
    ok: bool
    #: Points rebuilt (1d/1w); null for daily ranges.
    points: int | None = None


class ServerEvent(ApiModel):
    """The server is about to restart (a deploy) or has one planned.

    ``restarting``: sent by ``deploy.sh`` (via the loopback-only announce
    endpoint) right before the old container stops; clients show "Updating to
    <version>, back in about <eta_s> s" and keep their cached data. ``restart_planned``:
    a scheduled deploy at ``at`` (ISO time).
    """

    type: Literal["server"] = "server"
    ts: str
    market_state: MarketState
    state: Literal["restarting", "restart_planned"]
    reason: Literal["deploy"] = "deploy"
    #: Version being deployed (``app_version`` of the new image), if known.
    version: str | None = None
    #: Rough expected downtime in seconds.
    eta_s: int | None = None
    #: ``restart_planned`` only: when the deploy will start (ISO time).
    at: str | None = None


EVENT_MODELS: tuple[type[ApiModel], ...] = (
    HelloEvent,
    TickEvent,
    RefreshEvent,
    FxEvent,
    RefreshStartedEvent,
    RefreshProgressEvent,
    RefreshFinishedEvent,
    GraphsEvent,
    ServerEvent,
)


def event_schema() -> dict[str, Any]:
    """OpenAPI schema (``anyOf``) of every event, for the stream route docs."""
    return {"anyOf": [m.model_json_schema() for m in EVENT_MODELS]}
