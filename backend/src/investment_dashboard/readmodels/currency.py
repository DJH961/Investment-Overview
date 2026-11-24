"""Currency page read model (v7.0): the strip, Today block and rate range per side.

``today`` / ``lifetime`` / ``return_split`` are copied from the Overview payload of
the same side, so the two pages can never disagree. Everything extra is built here:

* ``rate_range``: low/high of the stored intraday EUR/USD samples of the session;
* ``buys``: what the owner's regular EUR amount (the investing-power setting) buys in dollars at one instant (a dollars figure
  from a euro notional at a single rate; allowed by the currency rule);
* ``one_cent``: the dollar book valued at the rate and at the rate + 0.01 at ONE
  instant, each currency from its own ``value_at_rate`` leg (never converted);
* ``stats``: the strip tiles (a tile without data is omitted).

Inputs are the Overview payloads as plain JSON-shaped dicts (``ccy -> payload``).
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any, Literal

from sqlalchemy.orm import Session

from investment_dashboard.domain.market_hours import exchange_today
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.services import (
    intraday_snapshots_service,
    investing_power_service,
    metrics_service,
)

log = logging.getLogger(__name__)

ZERO = Decimal(0)
ONE_CENT = Decimal("0.01")
Q6 = Decimal("0.000001")
Q8 = Decimal("0.00000001")


def _d(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except ArithmeticError:
        return None


def _iso_utc(at: datetime) -> str:
    return (at if at.tzinfo is not None else at.replace(tzinfo=UTC)).isoformat()


def _kind(value: Decimal) -> str:
    if value > 0:
        return "tailwind"
    if value < 0:
        return "headwind"
    return "neutral"


def _rate_range(
    session: Session, *, now: datetime, quote_usd_per_eur: bool
) -> dict[str, Any] | None:
    samples = [
        (at, fx)
        for at, _eur, fx in intraday_snapshots_service.day_series_with_fx(session, now=now)
        if fx is not None and fx > 0
    ]
    if not samples:
        return None
    rates = [fx for _at, fx in samples]
    low, high = min(rates), max(rates)
    low_display, high_display = (low, high) if quote_usd_per_eur else (1 / high, 1 / low)
    return {
        "session_date": intraday_snapshots_service.last_session_date(now).isoformat(),
        "low": dec(low),
        "high": dec(high),
        "low_display": dec(low_display),
        "high_display": dec(high_display),
        "samples": len(samples),
        "first_at": _iso_utc(samples[0][0]),
        "last_at": _iso_utc(samples[-1][0]),
    }


def _buys(session: Session, today: dict[str, Any], *, now: datetime) -> dict[str, Any] | None:
    spot, prev = _d(today.get("spot")), _d(today.get("prev"))
    if spot is None or spot <= 0:
        return None
    # One source: the Overview card's own investing-power figures (``today`` is copied from
    # the Overview payload), never re-derived here from other anchors. The owner's regular
    # amount is the same setting the card values.
    card = today.get("investing_power_usd") or {}
    amount = _d(card.get("amount_eur")) or investing_power_service.get_amount_eur(session)
    net = _d(card.get("net"))
    if net is None and prev is not None and prev > 0:
        net = amount * (spot - prev)  # no card (no swing / no anchor): the whole move only
    return {
        "amount_eur": dec(amount),
        "usd_now": dec(amount * spot),
        "usd_prev": dec(amount * prev) if prev is not None and prev > 0 else None,
        "change_usd": dec(net),
        "market_hours_usd": dec(_d(card.get("market_hours"))),
        "overnight_usd": dec(_d(card.get("overnight"))),
    }


def _one_cent(session: Session, payload: dict[str, Any], *, ccy: str) -> dict[str, Any] | None:
    """The market-price book (holdings, no cash, like the day split) at rate and rate + 0.01."""
    spot = _d(payload["currency"]["today"].get("spot"))
    on_raw = payload["kpis"].get("daily_growth_as_of")
    if spot is None or spot <= 0 or on_raw is None:
        return None
    on = on_raw if isinstance(on_raw, date) else date.fromisoformat(str(on_raw)[:10])
    values = metrics_service.value_at_two_rates(session, on, spot, spot + ONE_CENT)
    if values is None:
        return None
    (eur, usd), (eur_plus, usd_plus) = values
    base, plus = (usd, usd_plus) if ccy == "USD" else (eur, eur_plus)
    return {
        "rate": dec(spot),
        "value_at_rate": dec(base),
        "value_at_rate_plus": dec(plus),
        "change": dec(plus - base),
    }


def _stat(key: str, value: Decimal, unit: str, **extra: Any) -> dict[str, Any]:
    return {"key": key, "value": dec(value), "unit": unit, **extra}


def _lifetime_tile(ccy: str, life: dict[str, Any], gap: Decimal | None) -> list[dict[str, Any]]:
    """EUR: the lifetime currency P&L in euros (gap as secondary); USD: the gap itself."""
    if ccy != "EUR":
        return [] if gap is None else [_stat("lifetime_effect", gap, "fraction", kind="neutral")]
    pnl = _d(life.get("fx_pnl_eur"))
    if pnl is None:
        return []
    extra: dict[str, Any] = {"currency": "EUR", "kind": _kind(pnl)}
    if gap is not None:
        extra |= {"secondary": dec(gap), "secondary_unit": "fraction"}
    return [_stat("lifetime_effect", pnl, "money", **extra)]


def _stats(ccy: str, payload: dict[str, Any], one_cent: dict[str, Any] | None) -> list[Any]:
    cur = payload["currency"]
    today, life, split = cur["today"], cur["lifetime"], cur["return_split"]
    out: list[dict[str, Any]] = []

    spot = _d(today.get("spot"))
    if spot is not None:
        out.append(_stat("rate_now", spot, "rate"))

    if ccy == "EUR":
        net = effect_today_eur(payload)
        if net is not None:
            out.append(_stat("effect_today", net, "money", currency="EUR", kind=_kind(net)))
    else:
        net = _d((today.get("investing_power_usd") or {}).get("net"))
        if net is not None:
            out.append(
                _stat("investing_power_today", net, "money", currency="USD", kind=_kind(net))
            )

    out.extend(_lifetime_tile(ccy, life, _d(split.get("eur_minus_usd_pp"))))

    avg, current = _d(life.get("avg_invest_rate")), _d(life.get("current_rate"))
    if avg is not None and current is not None:
        kind = "neutral"
        if ccy == "EUR" and current != avg:
            kind = "tailwind" if current < avg else "headwind"
        out.append(
            _stat(
                "avg_rate_vs_now",
                avg,
                "rate",
                secondary=dec(current),
                secondary_unit="rate",
                kind=kind,
            )
        )

    if one_cent is not None:
        change = _d(one_cent["change"])
        if change is not None:
            out.append(
                _stat(
                    "one_cent",
                    change,
                    "money",
                    currency=ccy,
                    secondary=one_cent["rate"],
                    secondary_unit="rate",
                )
            )
    return out


def effect_today_eur(eur_payload: Mapping[str, Any]) -> Decimal | None:
    """Today's currency effect in EUR: the Overview day split's currency part.

    One source for "today" on the whole page (strip, Impact 1D, the hero's split);
    the fx_effect net is only the fallback when no day split exists yet (7.3.1).
    """
    split = eur_payload.get("day_split") or {}
    cur = _d(split.get("currency_move"))
    if cur is not None:
        return cur
    return _d((eur_payload["currency"]["today"].get("effect_eur") or {}).get("net"))


def _gap_tile(key: str, gap: Decimal | None, eur_money: Decimal | None) -> list[dict[str, Any]]:
    """A USD-view tile led by the gap (euro return minus dollar return), euros beside it."""
    if gap is None:
        return []
    extra: dict[str, Any] = {"kind": _kind(gap)}
    if eur_money is not None:
        extra |= {
            "secondary": dec(eur_money.quantize(Q6)),
            "secondary_unit": "money",
            "secondary_currency": "EUR",
        }
    return [_stat(key, gap, "fraction", **extra)]


def _gap_tiles(
    session: Session, payload: dict[str, Any], eur_payload: dict[str, Any]
) -> list[dict[str, Any]]:
    """The USD view of an all-dollar book: the rate never moves its dollar value, so
    each tile is the gap between the euro and the dollar return (each computed in its
    own currency), with the EUR side's own money effect beside it (never USD / rate)."""
    from investment_dashboard.readmodels import currency_effect  # noqa: PLC0415

    eur_day, usd_day = (
        _d(eur_payload["kpis"].get("daily_growth_pct")),
        _d(payload["kpis"].get("daily_growth_pct")),
    )
    day_gap = eur_day - usd_day if eur_day is not None and usd_day is not None else None
    eur_today = effect_today_eur(eur_payload)
    both = {"EUR": eur_payload, "USD": payload}
    usd = currency_effect.strip_figures(session, "USD", overview=both)
    eur = currency_effect.strip_figures(session, "EUR", overview=both)
    life_gap = usd.effect_lifetime_pp
    return [
        *_gap_tile("effect_today", day_gap, eur_today),
        *_gap_tile("effect_this_year", usd.effect_year_pp, eur.effect_year),
        *_gap_tile("effect_lifetime", life_gap, eur.effect_lifetime),
    ]


def _investing_tiles(
    session: Session,
    payload: dict[str, Any],
    eur_payload: dict[str, Any],
    overview: Mapping[str, Mapping[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """The USD view's tiles on the investing perspective (Impact's USD view):

    * today: how many more or fewer dollars your regular EUR amount buys than at the last close;
    * this year / lifetime: what the rate did to the euros you sent into your
      dollar accounts (``readmodels/currency_deposits``), the return gap beside.

    Empty without any USD deposit (the gap tiles then stand in).
    """
    from investment_dashboard.readmodels import currency_deposits, currency_effect  # noqa: PLC0415

    if not currency_deposits.usd_deposits(session=session):
        return []
    today = exchange_today()
    first = currency_effect.first_ledger_date(session)
    figures = currency_effect.strip_figures(session, "USD", today=today, overview=overview)
    out: list[dict[str, Any]] = []
    cur = payload["currency"]["today"]
    spot, prev = _d(cur.get("spot")), _d(cur.get("prev"))
    if spot is not None and prev is not None and prev > 0:
        change = (investing_power_service.get_amount_eur(session) * (spot - prev)).quantize(Q6)
        eur_day, usd_day = (
            _d(eur_payload["kpis"].get("daily_growth_pct")),
            _d(payload["kpis"].get("daily_growth_pct")),
        )
        extra: dict[str, Any] = {"currency": "USD", "kind": _kind(change)}
        if eur_day is not None and usd_day is not None:
            extra |= {"secondary": dec(eur_day - usd_day), "secondary_unit": "fraction"}
        out.append(_stat("effect_today", change, "money", **extra))
    for key, rng, gap in (
        ("effect_this_year", "ytd", figures.effect_year_pp),
        ("effect_lifetime", "all", figures.effect_lifetime_pp),
    ):
        after, through = currency_effect.range_window(rng, today, first)
        value = currency_deposits.window_effect(session, after, through, first)
        if value is None:
            continue
        extra = {"currency": "USD", "kind": _kind(value.quantize(Q6))}
        if gap is not None:
            extra |= {"secondary": dec(gap), "secondary_unit": "fraction"}
        out.append(_stat(key, value.quantize(Q6), "money", **extra))
    return out


def _effect_tiles(
    session: Session,
    ccy: str,
    payload: dict[str, Any],
    eur_payload: dict[str, Any] | None = None,
    overview: Mapping[str, Mapping[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """7.2 strip tiles: USD effect today, this year, lifetime (day by day), dollar trend.

    Built from the Impact read model (``readmodels/currency_effect``) so the strip
    and the Impact section show one number. A tile without data is left out. In the
    USD view of a book the rate never moved (all dollars), the three effect tiles
    lead with the euro-vs-dollar gap instead (:func:`_gap_tiles`), as Impact does.
    """
    from investment_dashboard.readmodels import currency_effect  # noqa: PLC0415

    out: list[dict[str, Any]] = []
    if ccy == "USD" and eur_payload is not None:
        investing = _investing_tiles(session, payload, eur_payload, overview)
        if investing:
            return investing + _trend_tile(session, ccy)
        figures = currency_effect.strip_figures(session, ccy, overview=overview)
        if not figures.effect_lifetime:
            out.extend(_gap_tiles(session, payload, eur_payload))
            out.extend(_trend_tile(session, ccy))
            return out
    if ccy == "USD":
        split = payload.get("day_split") or {}
        cur = _d(split.get("currency_move"))
        if cur is not None and cur != 0:
            out.append(_stat("effect_today", cur, "money", currency="USD", kind=_kind(cur)))
    figures = currency_effect.strip_figures(session, ccy, overview=overview)
    if figures.effect_year is not None:
        extra: dict[str, Any] = {"currency": ccy, "kind": _kind(figures.effect_year)}
        if figures.effect_year_pp is not None:
            extra |= {"secondary": dec(figures.effect_year_pp), "secondary_unit": "fraction"}
        out.append(_stat("effect_this_year", figures.effect_year.quantize(Q6), "money", **extra))
    if figures.effect_lifetime is not None:
        extra = {"currency": ccy, "kind": _kind(figures.effect_lifetime)}
        gap = figures.effect_lifetime_pp  # the Impact All gap (time-weighted)
        if gap is not None:
            extra |= {"secondary": dec(gap), "secondary_unit": "fraction"}
        out.append(_stat("effect_lifetime", figures.effect_lifetime.quantize(Q6), "money", **extra))
    out.extend(_trend_tile(session, ccy))
    return out


def _trend_tile(session: Session, ccy: str) -> list[dict[str, Any]]:
    """The trend tile: the dollar's in the EUR view, the euro's in the USD view."""
    from investment_dashboard.readmodels import currency_effect  # noqa: PLC0415

    of: Literal["dollar", "euro"] = "dollar" if ccy == "EUR" else "euro"
    trend = currency_effect.dollar_trend(session=session, of=of)
    if trend is None:
        return []
    return [
        _stat(
            "dollar_trend",
            trend["since_change_pct"].quantize(Q8),
            "fraction",
            direction=trend["direction"],
            normal=trend["normal"],
            since=trend["since"],
        )
    ]


def _safe_effect_tiles(
    session: Session,
    ccy: str,
    payload: dict[str, Any],
    eur_payload: dict[str, Any] | None,
    overview: Mapping[str, Mapping[str, Any]] | None = None,
) -> list[Any]:
    """:func:`_effect_tiles`, never failing the strip (the 7.0 tiles still show)."""
    try:
        return _effect_tiles(session, ccy, payload, eur_payload, overview)
    except Exception:
        log.warning("currency strip: Impact tiles failed", exc_info=True)
        return []


def build_currency_both(
    session: Session, overview: dict[str, dict[str, Any]], *, now: datetime | None = None
) -> dict[str, dict[str, Any]]:
    """``{"EUR": ..., "USD": ...}`` currency payloads from the two Overview payloads."""
    now = now or datetime.now(UTC)
    out: dict[str, dict[str, Any]] = {}
    for ccy in ("EUR", "USD"):
        payload = overview[ccy]
        cur = payload["currency"]
        one_cent = _one_cent(session, payload, ccy=ccy)
        out[ccy] = {
            "ccy": ccy,
            "as_of": payload["as_of"],
            "generated_at": payload["generated_at"],
            "today": cur["today"],
            "lifetime": cur["lifetime"],
            "return_split": cur["return_split"],
            "rate_range": _rate_range(session, now=now, quote_usd_per_eur=ccy == "USD"),
            "buys": _buys(session, cur["today"], now=now),
            "one_cent": one_cent,
            "stats": _stats(ccy, payload, one_cent)
            + _safe_effect_tiles(session, ccy, payload, overview.get("EUR"), overview),
        }
    return out
