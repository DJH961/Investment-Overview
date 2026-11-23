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
    #: What the conversion paid out (USD received).
    amount_to: DecStr | None = None
    from_ccy: str
    to_ccy: str
    #: Against the settled ECB fixing of the conversion's date (all-in, fees included).
    kind: Literal["above_reference", "below_reference"] | None = None
    #: ``all_in_rate / ecb_rate - 1``; negative = fewer dollars per euro than the ECB.
    off_pct: DecStr | None = None
    conversion_id: int


class RateSession(ApiModel):
    """One continuous forex trading day (UTC instants), for the chart's session axis."""

    open: str
    close: str


class RangeWindow(ApiModel):
    """The page range as dates (``readmodels/currency_range``), the same in every section."""

    key: str
    #: The day the range is measured from (``all``: your first transaction).
    start: str
    #: The last settled close inside the range.
    through: str
    #: Today's live move is part of the range.
    live: bool
    #: Drawn from intraday samples (1D / 1W).
    intraday: bool
    #: ``max`` only: days on or before this are before you started (context only).
    context_until: str | None = None


class RateHistoryOut(ApiModel):
    range: RateRange
    granularity: Literal["intraday", "daily", "weekly"]
    #: ISO date of the last settled row, or ISO datetime (UTC) of the live point.
    as_of: str | None = None
    source: Literal["ECB reference rate", "live samples"]
    #: ``1w`` only: the last 5 forex days (Sun 17:00 ET to Fri 17:00 ET), oldest first.
    sessions: list[RateSession] = Field(default_factory=list)
    #: ``1d`` / ``1w`` only: the US stock market's regular sessions inside the window
    #: (09:30 to 16:00 New York, 13:00 on half days; holidays left out), for shading.
    us_market_hours: list[RateSession] = Field(default_factory=list)
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
    #: The range as dates (one meaning for the whole page, 7.3.1).
    window: RangeWindow | None = None


__all__ = [
    "ConversionMarker",
    "RateChange",
    "RateHistoryOut",
    "RateHistoryPoint",
    "RatePercentiles",
    "RateRange",
    "RateSession",
    "RateTrend",
    "RateValue",
]
