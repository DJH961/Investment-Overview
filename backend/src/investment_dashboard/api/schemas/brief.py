"""Schemas for ``GET /api/brief`` and ``POST /api/brief/ack`` (the Daily Brief)."""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from investment_dashboard.api.schemas.common import ApiModel, ByCurrency, DecStr
from investment_dashboard.api.schemas.overview import Movers

_FRAC = "fraction, 0.01 = 1%"

#: ``session``: the window touches one NYSE session (figures sent);
#: ``sessions``: it touches several (the "N sessions passed" strip, no figures);
#: ``fx_reopen``: no NYSE boundary, but the currency market reopened (weekend).
BriefKind = Literal["session", "sessions", "fx_reopen"]


class BriefBoundary(ApiModel):
    #: UTC ISO instant of the open or close.
    at: str
    kind: Literal["open", "close"]
    #: Exchange date of the session the boundary belongs to.
    session_date: str


class BriefMove(ApiModel):
    """One session's move in one currency: the Overview's day move, reused as is.

    Every figure is the same value the Overview payload carries for that currency
    (``kpis.daily_move``, ``kpis.daily_growth_pct``, ``day_split``, ``movers``), so
    the Brief can never disagree with the hero. Amounts in that currency.
    """

    session_date: str
    day_move: DecStr | None = None
    day_move_pct: DecStr | None = Field(default=None, description=_FRAC)
    #: ``day_split.price_move`` / ``currency_move`` (null when the split is missing).
    price_move: DecStr | None = None
    currency_move: DecStr | None = None
    #: True when ``currency_move`` is the move since the close, shown beside the
    #: total and not part of it (``day_split.overnight``).
    currency_overnight: bool = False
    estimated: bool = False
    movers: Movers | None = None


class BriefEvent(ApiModel):
    """A ledger row created since the last acknowledgement (``transactions.created_at``)."""

    id: int
    kind: str
    #: Trade date (ISO).
    date: str
    symbol: str | None = None
    #: UTC ISO instant the row was written.
    created_at: str


class BriefFxMove(ApiModel):
    """The weekend line: the Overview's ``currency.today`` rate move, copied."""

    #: "EUR/USD" in the USD view, "USD/EUR" in the EUR view (``today.pair``).
    pair: str | None = None
    #: ``today.spot_display``.
    spot_display: DecStr | None = None
    #: ``today.move.pct`` (fraction; positive = the foreign currency got stronger).
    pct: DecStr | None = Field(default=None, description=_FRAC)
    #: ``today.move.anchor_kind``: what ``pct`` is measured from.
    anchor_kind: Literal["prev_close", "overnight", "session_open"] | None = None


class BriefOut(ApiModel):
    """The Daily Brief. ``due`` false: show nothing (no "up to date" chrome)."""

    due: bool
    kind: BriefKind | None = None
    #: The last acknowledgement (UTC ISO); null on the first visit ever.
    last_ack_at: str | None = None
    #: Server clock when the window was computed (UTC ISO).
    now: str
    #: Session open/close instants in ``(last_ack_at, now]``, oldest first.
    boundaries: list[BriefBoundary] = []  # noqa: RUF012 - pydantic copies defaults
    #: Exchange dates of the sessions the window touches, oldest first.
    sessions: list[str] = []  # noqa: RUF012
    sessions_passed: int = 0
    #: ``kind == "session"`` only: that session's move per currency; null otherwise.
    move: ByCurrency[BriefMove] | None = None
    #: ``kind == "fx_reopen"`` only: the rate line, per currency view.
    fx_move: ByCurrency[BriefFxMove] | None = None
    #: Ledger rows created since ``last_ack_at`` (newest first, at most 20).
    events: list[BriefEvent] = []  # noqa: RUF012
    events_total: int = 0


class BriefAckIn(ApiModel):
    #: The ``now`` of the Brief that was shown; the marker never moves past the
    #: server clock and never moves backwards.
    seen_at: str | None = None


class BriefAckOut(ApiModel):
    last_ack_at: str
