"""Schemas for ``GET /api/graphs/{range}``."""

from __future__ import annotations

from typing import Literal

from investment_dashboard.api.deps import Ccy
from investment_dashboard.api.schemas.common import ApiModel, DecStr

GraphRange = Literal["1d", "1w", "1m", "3m", "6m", "ytd", "1y", "all"]


class GraphPoint(ApiModel):
    #: ISO-8601: a UTC timestamp for intraday ranges, a date for daily ranges.
    t: str
    v: DecStr | None = None


class GraphSecondary(ApiModel):
    ccy: Ccy
    points: list[GraphPoint]


class GraphResponse(ApiModel):
    ccy: Ccy
    range: GraphRange
    as_of: str
    intraday: bool
    points: list[GraphPoint]
    #: Settled value at the previous session close (1d only).
    reference: DecStr | None = None
    secondary: GraphSecondary | None = None
