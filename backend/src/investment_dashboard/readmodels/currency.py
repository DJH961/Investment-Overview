"""Currency page read model (v7.0): the strip, Today block and rate range per side.

``today`` / ``lifetime`` / ``return_split`` are copied from the Overview payload of
the same side, so the two pages can never disagree. Everything extra is built here:

* ``rate_range``: low/high of the stored intraday EUR/USD samples of the session;
* ``buys``: what a fixed EUR amount buys in dollars at one instant (a dollars figure
  from a euro notional at a single rate; allowed by the currency rule);
* ``one_cent``: the dollar book valued at the rate and at the rate + 0.01 at ONE
  instant, each currency from its own ``value_at_rate`` leg (never converted);
* ``stats``: the strip tiles (a tile without data is omitted).

Inputs are the Overview payloads as plain JSON-shaped dicts (``ccy -> payload``).
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.domain import session_fx
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.services import intraday_snapshots_service, metrics_service

ZERO = Decimal(0)
ONE_CENT = Decimal("0.01")
#: The euro notional of the "EUR 1,000 buys ..." line.
BUYS_AMOUNT_EUR = Decimal(1000)


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
    market_open = bool(today["regime"]["market_open"])
    split = session_fx.fx_buying_power_split(
        market_open=market_open,
        amount_eur=BUYS_AMOUNT_EUR,
        live_fx=spot,
        prev_fx=prev,
        session_close_fx=intraday_snapshots_service.session_close_fx(session, now=now),
        session_open_fx=intraday_snapshots_service.session_open_fx(session, now=now),
    )
    return {
        "amount_eur": dec(BUYS_AMOUNT_EUR),
        "usd_now": dec(BUYS_AMOUNT_EUR * spot),
        "usd_prev": dec(BUYS_AMOUNT_EUR * prev) if prev is not None and prev > 0 else None,
        "change_usd": dec(split.total_usd),
        "market_hours_usd": dec(split.market_hours_usd),
        "overnight_usd": dec(split.overnight_usd),
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
        net = _d((today.get("effect_eur") or {}).get("net"))
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
            "stats": _stats(ccy, payload, one_cent),
        }
    return out
