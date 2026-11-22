"""Schemas for ``GET /api/currency/rate-history`` (the Currency page EUR/USD chart, v7.2).

``rate`` is always USD per 1 EUR (the ECB quote); ``inverse`` is 1 / rate (EUR per
1 USD, the dollar's terms: up = dollar stronger), computed on the server to 6 dp.
Fractions: 0.01 = 1 %. The payload is the same for both reporting currencies.
"""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from investment_dashboard.api.schemas.common import ApiModel, DecStr

RateRange = Literal["1d", "1w", "1m", "3m", "ytd", "1y", "all", "5y", "10y", "max"]


class RateHistoryPoint(ApiModel):
    #: ISO date (daily / weekly) or ISO datetime in UTC (intraday).
    t: str
    rate: DecStr
    inverse: DecStr


class RateValue(ApiModel):
    rate: DecStr
    inverse: DecStr


class RateChange(ApiModel):
    start_rate: DecStr
    end_rate: DecStr
    #: ``end_rate / start_rate - 1``.
    rate_pct: DecStr
    #: The dollar's change: ``start_rate / end_rate - 1``.
    inverse_pct: DecStr


class RateTrend(ApiModel):
    """The dollar's regime and how unusual its recent move is (full daily history)."""

    direction: Literal["dollar_up", "dollar_down", "sideways"]
    #: ISO date the current regime started.
    since: str
    #: Dollar (inverse) change since ``since``, fraction.
    since_change_pct: DecStr
    vs_ma200: Literal["above", "below"]
    normal: Literal["normal", "large", "unusual"]
    #: The dollar's move over the last ``window_days`` ECB days, signed fraction.
    move_pct: DecStr
    #: Median absolute move over that window across the history, fraction.
    typical_move_pct: DecStr
    #: Percentile of today's absolute move among all, 0..1.
    move_percentile: DecStr
    window_days: int


class RatePercentiles(ApiModel):
    """Share of days (0..1) the dollar was cheaper than today, per window."""

    since_start: DecStr | None = None
    y5: DecStr | None = None
    y10: DecStr | None = None
    since_1999: DecStr | None = None


class ConversionMarker(ApiModel):
    date: str
    #: The conversion's own rate: ``usd_received / eur_sent`` (USD per 1 EUR).
    rate: DecStr
    amount_from: DecStr
    from_ccy: str
    to_ccy: str
    #: 7.3 fills it against the settled fixing of the conversion's date.
    kind: Literal["above_reference", "below_reference"] | None = None
    conversion_id: int


class RateHistoryOut(ApiModel):
    range: RateRange
    granularity: Literal["intraday", "daily", "weekly"]
    #: ISO date of the last settled row, or ISO datetime (UTC) of the live point.
    as_of: str | None = None
    source: Literal["ECB reference rate", "live samples"]
    points: list[RateHistoryPoint] = Field(default_factory=list)
    #: 200-day moving average (ranges >= 1y, daily / weekly only).
    ma200: list[RateHistoryPoint] = Field(default_factory=list)
    #: The Overview's lifetime ``avg_invest_rate``.
    avg_rate: RateValue | None = None
    low: RateHistoryPoint | None = None
    high: RateHistoryPoint | None = None
    change: RateChange | None = None
    trend: RateTrend | None = None
    percentiles: RatePercentiles = Field(default_factory=RatePercentiles)
    markers: list[ConversionMarker] = Field(default_factory=list)


__all__ = [
    "ConversionMarker",
    "RateChange",
    "RateHistoryOut",
    "RateHistoryPoint",
    "RatePercentiles",
    "RateRange",
    "RateTrend",
    "RateValue",
]
