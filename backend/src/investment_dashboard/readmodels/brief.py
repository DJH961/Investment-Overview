"""The Daily Brief payload (``BriefOut``), shaped from the cached Overview.

Every figure is taken from the Overview payload of that currency (never converted;
the session's market part is its Total minus the currency part, so the parts sum to the
headline), so the Brief cannot disagree with the hero. Session figures come from
``kpis.daily_move`` / ``daily_growth_pct`` / ``day_split`` / ``movers``; the weekend rate
line from ``currency.today``.

The figures of its own, the rate's effect over the whole window (EUR view:
``currency_effect_since`` on the book; USD view: ``investing_power_since`` on the
regular amount), come from ``brief_service.fx_since``, valued at the Overview's live
rate so they end where the hero ends.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.domain import brief as brief_domain
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.repositories import transactions_repo
from investment_dashboard.services import brief_service, brief_window_service

CURRENCIES = ("EUR", "USD")
MAX_EVENTS = 20


def _get(obj: Any, name: str) -> Any:
    """Attribute of a model or key of a dict (``None`` when absent)."""
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat()


def _dec(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        out = Decimal(str(value))
    except InvalidOperation:
        return None
    return out if out.is_finite() else None


def _move(overview: Any, session_date: str, ccy: str) -> dict[str, Any]:
    """The session's move on the hero's basis, its parts summing to the headline.

    ``day_move`` is the headline day Total the hero shows: ``day_split.price_move`` (the
    estimated book's when ``estimated``, the official one otherwise; the field's name is
    historical, it is the whole Total). ``price_move`` is its market part and
    ``currency_move`` the rate's part, so ``price_move + currency_move == day_move``.
    Only the euro view has a currency leg (the dollar book is valued in its own
    currency: ``currency_move`` null, the market is the whole move), and while the
    market is shut the currency since the close is beside the Total, not in it.
    """
    kpis = _get(overview, "kpis")
    split = _get(overview, "day_split")
    estimated = bool(_get(split, "estimated"))
    overnight = bool(_get(split, "overnight"))
    estimate = _get(kpis, "estimate") if estimated else None
    total = _dec(_get(split, "price_move"))
    if total is None:
        total = _dec(_get(estimate, "daily_move") if estimate else _get(kpis, "daily_move"))
    pct = _get(estimate, "daily_growth_pct") if estimate else _get(kpis, "daily_growth_pct")
    currency = _dec(_get(split, "currency_move")) if ccy == "EUR" else None
    market = total
    if total is not None and currency is not None and not overnight:
        market = total - currency
    return {
        "session_date": _get(kpis, "daily_growth_as_of") or session_date,
        "day_move": dec(total),
        "day_move_pct": pct,
        "price_move": dec(market),
        "currency_move": dec(currency),
        "currency_overnight": overnight,
        "estimated": estimated,
        "movers": _get(overview, "movers"),
    }


def _fx_move(overview: Any) -> dict[str, Any]:
    today = _get(_get(overview, "currency"), "today")
    move = _get(today, "move")
    return {
        "pair": _get(today, "pair"),
        "spot_display": _get(today, "spot_display"),
        "pct": _get(move, "pct"),
        "anchor_kind": _get(move, "anchor_kind"),
    }


def _events(session: Session, since: datetime) -> tuple[list[dict[str, Any]], int]:
    rows, total = transactions_repo.list_created_since(session, since, MAX_EVENTS)
    events = [
        {
            "id": row.id,
            "kind": str(row.kind),
            "date": row.date.isoformat(),
            "symbol": row.instrument.symbol if row.instrument is not None else None,
            "created_at": _iso(row.created_at.replace(tzinfo=UTC)),
        }
        for row in rows
    ]
    return events, total


def _live_rate(overview_both: Any) -> Decimal | None:
    """The live EUR/USD the Overview valued at (``currency.today.spot``), if any."""
    spot = _get(_get(_get(_get(overview_both, "EUR"), "currency"), "today"), "spot")
    if spot is None:
        return None
    try:
        rate = Decimal(str(spot))
    except InvalidOperation:
        return None
    return rate if rate.is_finite() and rate > 0 else None


def _fx_since(
    session: Session, overview_both: Any, since: datetime, now: datetime
) -> dict[str, Any]:
    """``currency_effect_since`` (EUR side) and ``investing_power_since`` (USD side).

    Each view does currency the way the Overview's currency box does: the EUR view
    the book's currency effect, the USD view the regular amount's investing power.
    The other side of each field is null.
    """
    fx = brief_service.fx_since(session, since=since, now=now, rate_now=_live_rate(overview_both))
    if fx is None:
        return {"currency_effect_since": None, "investing_power_since": None}
    rates = {
        "rate_then": dec(fx.rate_then),
        "rate_now": dec(fx.rate_now),
        "since": _iso(fx.since),
    }
    effect = fx.currency_effect
    power = fx.investing_power
    return {
        "currency_effect_since": {
            "EUR": None
            if effect is None
            else {"amount": dec(effect.amount), "pct": dec(effect.pct), **rates},
            "USD": None,
        },
        "investing_power_since": {
            "EUR": None,
            "USD": None
            if power is None
            else {
                "amount_eur": dec(power.amount_eur),
                "amount_usd_now": dec(power.amount_usd_now),
                "amount_usd_then": dec(power.amount_usd_then),
                "net": dec(power.net),
                "pct": dec(power.pct),
                **rates,
            },
        },
    }


def _mover_dict(row: brief_window_service.MoverRow) -> dict[str, Any]:
    return {
        "symbol": row.symbol,
        "name": row.name,
        "move": dec(row.move),
        "pct": dec(row.pct),
        "reason": "window",
        "twin": None,
    }


def _window_move(
    session: Session, overview_both: Any, since: datetime, now: datetime
) -> dict[str, Any] | None:
    """The whole window's move per currency, end value = the hero's headline book."""
    inputs = brief_window_service.collect(session, start_at=since, now=now)
    if inputs is None:
        return None
    rate_now = _live_rate(overview_both)
    if rate_now is None:
        rate_now = brief_service.live_rate(now)
    effect = (
        brief_domain.currency_effect_since(
            inputs.book, rate_then=inputs.rate_then, rate_now=rate_now
        )
        if rate_now is not None
        else None
    )
    out: dict[str, Any] = {}
    for ccy in CURRENCIES:
        overview = _get(overview_both, ccy)
        kpis = _get(overview, "kpis")
        estimate = _get(kpis, "estimate")
        end = _dec(_get(estimate, "total_value") if estimate else _get(kpis, "total_value"))
        usd = ccy == "USD"
        start = inputs.start_usd if usd else inputs.start_eur
        flows = inputs.flows_usd if usd else inputs.flows_eur
        if end is None or start <= 0:
            out[ccy] = None
            continue
        line = None if usd or effect is None else effect["EUR"]
        figures = brief_domain.window_figures(
            start_value=start,
            end_value=end,
            net_flows=flows,
            currency_move=line.amount if line is not None else None,
        )
        eligible, winners, losers = brief_window_service.movers(
            inputs.legs, view="USD" if usd else "EUR", rate_then=inputs.rate_then, rate_now=rate_now
        )
        out[ccy] = {
            "start_at": _iso(inputs.start_at),
            "end_at": _iso(inputs.end_at),
            "start_basis": inputs.start_basis,
            "start_value": dec(start),
            "end_value": dec(end),
            "net_flows": dec(flows),
            "move": dec(figures.move),
            "pct": dec(figures.pct),
            "price_move": dec(figures.price_move),
            "currency_move": dec(figures.currency_move),
            "estimated": estimate is not None,
            "movers": {
                "basis_date": inputs.start_date.isoformat(),
                "eligible_count": eligible,
                "winners": [_mover_dict(r) for r in winners],
                "losers": [_mover_dict(r) for r in losers],
            },
        }
    if all(v is None for v in out.values()):
        return None
    return out


def build(session: Session, *, overview_both: Any, now: datetime) -> dict[str, Any]:
    """The Brief for the owner's last absence ``(visit_from, visit_start]``; ``due`` false when none."""
    now = now.astimezone(UTC) if now.tzinfo is not None else now.replace(tzinfo=UTC)
    last_ack = brief_service.get_last_ack(session)
    visit = brief_service.get_visit(session)
    seen = brief_service.get_last_seen(session)
    window = brief_domain.brief_window(visit[0], visit[1]) if visit is not None else None
    if window is not None and last_ack is not None and last_ack >= window.end:
        window = None  # dismissed during this visit: hidden until the next one
    out: dict[str, Any] = {
        "due": window is not None,
        "last_ack_at": _iso(last_ack) if last_ack is not None else None,
        "now": _iso(now),
        "visit_from": _iso(visit[0]) if visit is not None else None,
        "last_seen_at": _iso(seen) if seen is not None else None,
    }
    if window is None or visit is None:
        out["due"] = False
        return out
    since, came_back = visit
    out["kind"] = window.kind
    out["boundaries"] = [
        {"at": _iso(b.at), "kind": b.kind, "session_date": b.session_date.isoformat()}
        for b in window.boundaries
    ]
    out["sessions"] = [d.isoformat() for d in window.sessions]
    out["sessions_passed"] = window.sessions_passed
    if window.kind == "session":
        day = window.sessions[0].isoformat()
        out["move"] = {c: _move(_get(overview_both, c), day, c) for c in CURRENCIES}
    elif window.kind == "fx_reopen":
        out["fx_move"] = {c: _fx_move(_get(overview_both, c)) for c in CURRENCIES}
    if overview_both is not None:
        # Only on the full build (the probe has no overview and is never returned due).
        out.update(_fx_since(session, overview_both, since, came_back))
        if window.kind in ("session", "sessions"):
            out["window_move"] = _window_move(session, overview_both, since, now)
    events, total = _events(session, since)
    out["events"] = events
    out["events_total"] = total
    return out
