"""Schema for ``GET /api/live``: the latest tick plus what a returning client missed."""

from __future__ import annotations

from pydantic import Field

from investment_dashboard.api.schemas.common import ApiModel
from investment_dashboard.api.schemas.stream import TickEvent, TickPoint


class LiveResponse(ApiModel):
    #: Current tick sequence number (0: no tick in this process yet).
    seq: int
    #: The latest tick, or null before the first one.
    tick: TickEvent | None = None
    #: Intraday samples with a sequence number above ``since`` (oldest first).
    missed_points: list[TickPoint] = Field(default_factory=list)
    #: Random id of this server process; a new value means a restart (``seq`` began at 0).
    boot_id: str = ""
    #: Read-cache generation counters (``ledger`` / ``prices`` / ``fx``). A counter that
    #: moved since the client last saw it means reports changed while it was away.
    generations: dict[str, int] = Field(default_factory=dict)
