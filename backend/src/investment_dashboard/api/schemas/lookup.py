"""Schemas for ``/api/lookup`` (search, quote and chart for any symbol)."""

from __future__ import annotations

from typing import Literal

from investment_dashboard.api.schemas.common import ApiModel, DecStr

LookupRange = Literal["1d", "1w", "1m", "3m", "6m", "ytd", "1y", "all"]


class LookupHit(ApiModel):
    symbol: str
    name: str
    exchange: str | None = None
    type: str | None = None
    currency: str | None = None
    held_instrument_id: int | None = None


class LookupSearchResponse(ApiModel):
    results: list[LookupHit]


class LookupQuote(ApiModel):
    symbol: str
    name: str | None = None
    exchange: str | None = None
    type: str | None = None
    currency: str | None = None
    price_native: DecStr
    day_change_native: DecStr | None = None
    day_pct: DecStr | None = None
    captured_at: str
    week52_low: DecStr | None = None
    week52_high: DecStr | None = None
    fx_eur_usd: DecStr | None = None


class LookupPoint(ApiModel):
    t: str
    price_native: DecStr
    fx_eur_usd: DecStr | None = None


class LookupSession(ApiModel):
    open: str
    close: str


class LookupHistory(ApiModel):
    symbol: str
    currency: str | None = None
    range: LookupRange
    x_mode: Literal["date", "time"]
    sessions: list[LookupSession]
    points: list[LookupPoint]
