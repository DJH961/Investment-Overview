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


class TickPrice(ApiModel):
    """One instrument's latest price in its native currency."""

    px: DecStr
    ccy: str
    #: Previous session close (native), for the day change; null if unknown.
    prev_close: DecStr | None = None
    #: A mutual fund whose NAV for the last session has not posted: ``px`` is the
    #: previous NAV, so ``px - prev_close`` would read 0 (and ``prev_close`` is then
    #: null). Clients keep the server's day move for this row; its estimate (if it
    #: has a twin) arrives in ``estimates``.
    stale_nav: bool = False
    #: The server's day move of this holding (all accounts), money in each reporting
    #: currency, rounded to the cent: the same figure as the holdings row's
    #: ``today_move`` (today's share count, each mark at its own rate; the current
    #: mark at this tick's rate while the session trades). Null: not computable
    #: (money-market fund, no previous close, missing rate).
    day_move_eur: DecStr | None = None
    day_move_usd: DecStr | None = None
    #: The matching day % as a fraction (``0.0123`` = +1.23 %), FX-aware per
    #: currency (the EUR % is never the USD % reused). Null as above.
    day_pct_eur: DecStr | None = None
    day_pct_usd: DecStr | None = None


class TickCategory(ApiModel):
    """One allocation category's day move (the holdings rows' ``category``)."""

    #: Sum of the members' ``day_move_*`` (null when no member has one).
    day_move_eur: DecStr | None = None
    day_move_usd: DecStr | None = None
    #: Summed move over the members' summed previous value, a fraction (null: none priced).
    day_pct_eur: DecStr | None = None
    day_pct_usd: DecStr | None = None


class TickEstimatePct(ApiModel):
    """The estimated move since the previous close, a fraction per currency."""

    EUR: DecStr | None = None
    USD: DecStr | None = None


class TickEstimate(ApiModel):
    """One pending mutual fund valued from its ETF twin (native price per share)."""

    est_px: DecStr
    prev_nav: DecStr
    pct: TickEstimatePct
    #: When the twin price behind the estimate was struck (ISO).
    at: str


class TickPoint(ApiModel):
    """The new intraday portfolio sample, in both currencies (single instant)."""

    t: str
    EUR: DecStr | None = None
    USD: DecStr | None = None


class TickEvent(ApiModel):
    """A market-hours poll finished: prices, FX and the intraday sample are fresh."""

    type: Literal["tick"] = "tick"
    ts: str
    market_state: MarketState
    #: Monotonic per process; ``GET /api/live?since=`` catches up from it.
    seq: int | None = None
    #: Latest price per instrument id (as a string key).
    prices: dict[str, TickPrice] | None = None
    #: Day move per allocation category, keyed by the holdings rows' ``category``
    #: (``""`` for uncategorised); null when nothing is priced.
    categories: dict[str, TickCategory] | None = None
    #: The intraday sample this tick added (1D/1W graphs append it).
    point: TickPoint | None = None
    total_value_eur: DecStr | None = None
    #: EUR total x the live spot at ``ts`` (single instant, so the conversion is valid).
    total_value_usd: DecStr | None = None
    #: Live EUR->USD rate at ``ts`` (USD per EUR).
    fx_eur_usd: DecStr | None = None
    #: The total with pending mutual funds at their ETF-twin estimate (null when none
    #: is estimating). ``total_value_est_eur - total_value_eur`` is the adjustment;
    #: equals the overview's ``kpis.estimate.total_value`` and ``point.EUR``.
    total_value_est_eur: DecStr | None = None
    #: ``total_value_est_eur`` x the live spot at ``ts`` (single instant).
    total_value_est_usd: DecStr | None = None
    #: Pending mutual funds by instrument id (as a string key); null/empty when none.
    estimates: dict[str, TickEstimate] | None = None
    #: When the last refresh brought in new prices (null: none yet in this process).
    last_update_at: str | None = None
    #: When the newest stock/ETF price was struck on the exchange (provider time).
    price_market_at: str | None = None
    #: Market open, a fresh pull, a recent price and no frozen feed.
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
    #: When the app last fetched new data (prices or this FX rate): the "Updated" stamp.
    last_update_at: str | None = None


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


def _inline_defs(schema: dict[str, Any]) -> dict[str, Any]:
    """Replace local ``#/$defs/X`` refs with the definitions themselves.

    The event schemas are embedded inline in the OpenAPI document, where a model's
    own ``$defs`` (nested models such as :class:`TickPrice`) can't be resolved.
    """
    defs = schema.pop("$defs", {})

    def walk(node: Any) -> Any:
        if isinstance(node, dict):
            ref = node.get("$ref")
            if isinstance(ref, str) and ref.startswith("#/$defs/"):
                return walk(defs[ref.removeprefix("#/$defs/")])
            return {k: walk(v) for k, v in node.items()}
        if isinstance(node, list):
            return [walk(v) for v in node]
        return node

    return walk(schema)  # type: ignore[no-any-return]


def event_schema() -> dict[str, Any]:
    """OpenAPI schema (``anyOf``) of every event, for the stream route docs."""
    return {"anyOf": [_inline_defs(m.model_json_schema()) for m in EVENT_MODELS]}
