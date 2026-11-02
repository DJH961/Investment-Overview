"""Schemas for ``GET /api/graphs/{range}`` and the graph write routes."""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from investment_dashboard.api.deps import Ccy
from investment_dashboard.api.schemas.common import ApiModel, DecStr

GraphRange = Literal["1d", "1w", "1m", "3m", "6m", "ytd", "1y", "all"]
GrowthMode = Literal["reference", "simple", "xirr", "total"]


class GraphPoint(ApiModel):
    #: ISO-8601: a UTC timestamp for intraday ranges, a date for daily ranges.
    t: str
    v: DecStr | None = None


class GraphGrowth(ApiModel):
    """Growth over the drawn window, computed in this line's own currency."""

    pct: DecStr = Field(description="Growth over the window (fraction, 0.01 = 1%)")
    mode: GrowthMode = Field(
        description=(
            "reference: move vs the previous close (1d); simple: Modified Dietz (1w); "
            "xirr: window XIRR compounded over the window (1m..1y); "
            "total: lifetime compounded growth (all)"
        )
    )


class GraphSecondary(ApiModel):
    """The other currency's line, built independently (never converted)."""

    ccy: Ccy
    #: Only the timestamps also present in the primary line (unmatched ones dropped).
    points: list[GraphPoint]
    scale: DecStr | None = Field(
        default=None,
        description=(
            "Display factor secondary/primary at the window's first shared point. "
            "Plot secondary at v/scale on the primary axis so both lines start at the "
            "same pixel; right-axis ticks = left ticks x scale. Not a conversion."
        ),
    )
    #: Timestamp of the shared start point ``scale`` was taken at.
    anchor_t: str | None = None
    growth: GraphGrowth | None = None


class GraphSession(ApiModel):
    """One exchange session inside an intraday window (UTC instants)."""

    date: str
    open: str
    close: str


class GraphCoverage(ApiModel):
    """How many of the window's finished sessions reached their intraday target."""

    covered: int
    total: int
    complete: bool


class GraphResponse(ApiModel):
    ccy: Ccy
    range: GraphRange
    as_of: str
    intraday: bool
    points: list[GraphPoint]
    #: Settled value at the previous session close (1d only).
    reference: DecStr | None = None
    secondary: GraphSecondary | None = None
    #: Exchange date of the session the intraday window ends on (1d/1w), else null.
    session_date: str | None = None
    market_open: bool = False
    #: 1d only: last point vs ``reference``.
    direction: Literal["up", "down", "flat"] | None = None
    #: Exchange sessions in the window, oldest first (intraday ranges only).
    sessions: list[GraphSession] = []
    coverage: GraphCoverage | None = None
    growth: GraphGrowth | None = None


class GraphRangePref(ApiModel):
    range: GraphRange


class GraphRangePrefResponse(ApiModel):
    #: The range just stored.
    range: GraphRange
    #: What ``GET /api/overview`` will now report as ``default_range``.
    default_range: GraphRange


class GraphReloadResponse(ApiModel):
    range: GraphRange
    status: Literal["started"]
