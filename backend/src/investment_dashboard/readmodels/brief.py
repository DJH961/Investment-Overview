"""The Daily Brief payload (``BriefOut``), shaped from the cached Overview.

Every figure is COPIED from the Overview payload of that currency (never recomputed,
never converted), so the Brief cannot disagree with the hero. Session figures come from
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
from investment_dashboard.services import brief_service

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


def _move(overview: Any, session_date: str) -> dict[str, Any]:
    kpis = _get(overview, "kpis")
    split = _get(overview, "day_split")
    return {
        "session_date": _get(kpis, "daily_growth_as_of") or session_date,
        "day_move": _get(kpis, "daily_move"),
        "day_move_pct": _get(kpis, "daily_growth_pct"),
        "price_move": _get(split, "price_move"),
        "currency_move": _get(split, "currency_move"),
        "currency_overnight": bool(_get(split, "overnight")),
        "estimated": bool(_get(split, "estimated")),
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


def build(session: Session, *, overview_both: Any, now: datetime) -> dict[str, Any]:
    """The Brief for the window since the stored marker; ``due`` false when none."""
    now = now.astimezone(UTC) if now.tzinfo is not None else now.replace(tzinfo=UTC)
    last_ack = brief_service.get_last_ack(session)
    window = brief_domain.brief_window(last_ack, now)
    out: dict[str, Any] = {
        "due": window is not None,
        "last_ack_at": _iso(last_ack) if last_ack is not None else None,
        "now": _iso(now),
    }
    if window is None or last_ack is None:
        out["due"] = False
        return out
    out["kind"] = window.kind
    out["boundaries"] = [
        {"at": _iso(b.at), "kind": b.kind, "session_date": b.session_date.isoformat()}
        for b in window.boundaries
    ]
    out["sessions"] = [d.isoformat() for d in window.sessions]
    out["sessions_passed"] = window.sessions_passed
    if window.kind == "session":
        day = window.sessions[0].isoformat()
        out["move"] = {c: _move(_get(overview_both, c), day) for c in CURRENCIES}
    elif window.kind == "fx_reopen":
        out["fx_move"] = {c: _fx_move(_get(overview_both, c)) for c in CURRENCIES}
    if overview_both is not None:
        # Only on the full build (the probe has no overview and is never returned due).
        out.update(_fx_since(session, overview_both, last_ack, now))
    events, total = _events(session, last_ack)
    out["events"] = events
    out["events_total"] = total
    return out
