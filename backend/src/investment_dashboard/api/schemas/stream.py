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


def event_schema() -> dict[str, Any]:
    """OpenAPI schema (``anyOf``) of every event, for the stream route docs."""
    return {
        "anyOf": [m.model_json_schema() for m in (HelloEvent, TickEvent, RefreshEvent, FxEvent)]
    }
