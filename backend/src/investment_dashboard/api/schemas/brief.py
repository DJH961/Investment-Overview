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
    #: The parts of ``day_move`` (same basis as the hero: estimated when ``estimated``):
    #: ``price_move`` (market) + ``currency_move`` == ``day_move``. The euro view only has
    #: a currency part; the dollar view's is null and its market part is the whole move.
    price_move: DecStr | None = None
    currency_move: DecStr | None = None
    #: True when ``currency_move`` is the move since the close, shown beside the
    #: total and not part of it (``day_split.overnight``; ``day_move`` already excludes it).
    currency_overnight: bool = False
    estimated: bool = False
    movers: Movers | None = None


class BriefEvent(ApiModel):
    """A ledger row created since the previous visit (``transactions.created_at``)."""

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


class BriefCurrencyEffect(ApiModel):
    """EUR view: the EUR/USD rate's effect on the portfolio over the whole window.

    The current book valued at ``rate_now`` minus the same book at ``rate_then``
    (holdings held constant, only the rate moves: the Overview currency box's
    revaluation). USD holdings move by ``usd x (1/rate_now - 1/rate_then)``; EUR
    holdings do not move. Euros.
    """

    amount: DecStr
    #: ``amount`` / the same book at ``rate_then``, in euros.
    pct: DecStr = Field(description=_FRAC)
    #: EUR/USD (USD per 1 EUR) at ``since`` and now.
    rate_then: DecStr
    rate_now: DecStr
    #: The window's start (the previous visit's last heartbeat, UTC ISO).
    since: str


class BriefWindowMove(ApiModel):
    """The book's move over the whole window (``visit_from`` to now) in one currency.

    ``move = end_value - start_value - net_flows``; ``pct`` is the period-growth
    definition ``move / (start_value + net_flows)``. EUR view: ``price_move +
    currency_move == move`` (the currency part is the rate's effect on the start
    book); USD view: ``currency_move`` is null and ``price_move == move``.
    """

    start_at: str
    end_at: str
    #: ``intraday``: a stored sample at most 30 minutes before ``start_at``;
    #: ``close``: the last official close at or before it.
    start_basis: Literal["intraday", "close"]
    start_value: DecStr
    #: The hero's headline book now (the estimate while the hero estimates).
    end_value: DecStr
    #: Money put into the book inside the window (deposits minus withdrawals).
    net_flows: DecStr
    move: DecStr
    pct: DecStr | None = Field(default=None, description=_FRAC)
    price_move: DecStr
    currency_move: DecStr | None = None
    estimated: bool = False
    #: Top three up and down holdings by percentage over the window.
    movers: Movers


class BriefInvestingPower(ApiModel):
    """USD view: the regular euro amount in dollars now versus at the window's start.

    The Overview's ``investing_power_usd`` maths over the whole window: the fixed
    ``amount_eur`` buys ``amount_eur x rate`` dollars; ``net`` = now - then (USD).
    """

    amount_eur: DecStr
    amount_usd_now: DecStr
    amount_usd_then: DecStr
    net: DecStr
    #: ``net / amount_usd_then`` (= ``rate_now / rate_then - 1``).
    pct: DecStr = Field(description=_FRAC)
    #: EUR/USD (USD per 1 EUR) at ``since`` and now.
    rate_then: DecStr
    rate_now: DecStr
    #: The window's start (the previous visit's last heartbeat, UTC ISO).
    since: str


class BriefOut(ApiModel):
    """The Daily Brief. ``due`` false: show nothing (no "up to date" chrome)."""

    due: bool
    kind: BriefKind | None = None
    #: The last dismissal (UTC ISO); null when never dismissed. Hides the card for the
    #: visit it was dismissed in.
    last_ack_at: str | None = None
    #: Server clock when the window was computed (UTC ISO).
    now: str
    #: The current visit's frozen window start (when the owner left; UTC ISO), null before
    #: the first absence. ``last_seen_at``: the newest visible read (UTC ISO).
    visit_from: str | None = None
    last_seen_at: str | None = None
    #: Session open/close instants in ``(previous visit, now]``, oldest first.
    boundaries: list[BriefBoundary] = []  # noqa: RUF012 - pydantic copies defaults
    #: Exchange dates of the sessions the window touches, oldest first.
    sessions: list[str] = []  # noqa: RUF012
    sessions_passed: int = 0
    #: ``kind == "session"`` only: that session's move per currency; null otherwise.
    move: ByCurrency[BriefMove] | None = None
    #: ``kind == "fx_reopen"`` only: the rate line, per currency view.
    fx_move: ByCurrency[BriefFxMove] | None = None
    #: ``session`` and ``sessions`` kinds: the book's move over the whole window, per
    #: currency (null when the window has no start value).
    window_move: ByCurrency[BriefWindowMove | None] | None = None
    #: Each view's currency line since the previous visit, as the Overview's currency box
    #: does it. EUR side: the currency effect on the book (the USD side is always
    #: null). Null when the window is empty or no rate is known at its start.
    currency_effect_since: ByCurrency[BriefCurrencyEffect | None] | None = None
    #: USD side: investing power on the regular amount (the EUR side is always null).
    investing_power_since: ByCurrency[BriefInvestingPower | None] | None = None
    #: Ledger rows created since the previous visit (newest first, at most 20).
    events: list[BriefEvent] = []  # noqa: RUF012
    events_total: int = 0


class BriefAckIn(ApiModel):
    #: The ``now`` of the Brief that was shown; the marker never moves past the
    #: server clock and never moves backwards.
    seen_at: str | None = None


class BriefVisitIn(ApiModel):
    #: ISO 8601 datetime WITH offset, in the past and at most 30 days old.
    visit_from: str


class BriefAckOut(ApiModel):
    last_ack_at: str
