"""Month and year recap (7.4 P8, ``GET /api/recap?period=``).

One period's story, per reporting currency, built only from figures other pages
already show, so the recap can never disagree with them:

* **contributed, dividends, interest, nominal return, real return** are the
  Periods row of the same label (:func:`readmodels.periods.build_for_ccy`, months
  gap-filled like the Periods page): the
  test ``test_recap_equals_periods`` holds them equal.
* **market, currency** are the Currency page attribution's bridge for the same
  month or year (:mod:`domain.fx_attribution` ``month_totals`` / ``year_totals``).
  Dividends and interest are part of ``market`` there (they are earned inside the
  portfolio), so the card shows them as "of which".
* **conversion cost** is ``fx_spread`` (fees + spread against the ECB fixing) of
  the conversions dated in the period, in each side's own currency.
* **cashed out** is the Periods row's ``cashed_out_eur`` (euros back from cash-outs
  dated in the period, ``journey_fields``); ``0`` in the dollar view.

Every money figure is computed in each reporting currency on its own; nothing is
converted from the other side. The real return is a euro figure (euro-area prices)
and is ``null`` in USD.

The first visit of a new month (or, in January, of a new year) shows the card on
the Overview: :func:`state` compares the default period with ``recap.last_ack``
(an ``app_config`` row, like the Brief's ``brief.last_ack_at``).
"""

from __future__ import annotations

import re
from datetime import date
from decimal import Decimal
from typing import TYPE_CHECKING, Any, Literal

from investment_dashboard.activity_log import activity
from investment_dashboard.domain import fx_attribution as fa
from investment_dashboard.readmodels import currency_effect, periods
from investment_dashboard.readmodels._context import build_context
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.services import app_config_service, fx_cost_service
from investment_dashboard.services.read_cache import cached_read

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

#: ``app_config`` key: the last period label the owner dismissed ("2026-10" / "2026").
ACK_KEY = "recap.last_ack"
CCYS = ("EUR", "USD")
ZERO = Decimal(0)
_PERIOD = re.compile(r"^\d{4}(-(0[1-9]|1[0-2]))?$")


def valid_period(period: str) -> bool:
    return bool(_PERIOD.match(period))


def default_period(today: date) -> str:
    """The last finished month; in January the last finished year."""
    if today.month == 1:
        return f"{today.year - 1:04d}"
    return f"{today.year:04d}-{today.month - 1:02d}"


def _bounds(period: str) -> tuple[date, date]:
    year = int(period[:4])
    if len(period) == 4:
        return date(year, 1, 1), date(year, 12, 31)
    month = int(period[5:7])
    nxt = date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)
    return date(year, month, 1), date.fromordinal(nxt.toordinal() - 1)


def _bridge(session: Session, ccy: str, period: str) -> fa.Bridge | None:
    life = currency_effect.lifetime(session, ccy)
    if life is None or not life.parts:
        return None
    totals = fa.year_totals(life.parts) if len(period) == 4 else fa.month_totals(life.parts)
    return next((b for b in totals if b.label == period), None)


_DIRECTIONS: tuple[Literal["to_usd", "to_eur"], ...] = ("to_usd", "to_eur")


def _conversion_cost(
    session: Session, period: str
) -> tuple[dict[str, Decimal | None], int, dict[str, dict[str, Any]]]:
    """Cost of the conversions dated in the period, both directions (7.4).

    ``(cost per side, count, by direction)``: the total adds the conversions back
    (``fx_spread`` prices each in its own direction); ``by direction`` is
    ``{side: {"to_usd": {...}, "to_eur": {...}}}`` with each direction's cost and count.
    """
    first, last = _bounds(period)
    per: dict[str, list[Any]] = {
        d: [
            c
            for c in fx_cost_service.conversion_costs(session, direction=d)
            if first <= c.date <= last
        ]
        for d in _DIRECTIONS
    }
    by_dir: dict[str, dict[str, Any]] = {"EUR": {}, "USD": {}}
    for d, rows in per.items():
        for side, attr in (("EUR", "cost_eur"), ("USD", "cost_usd")):
            by_dir[side][d] = {
                "cost": dec(sum((getattr(c, attr) or ZERO for c in rows), ZERO)) if rows else None,
                "count": len(rows),
            }
    in_period = [c for rows in per.values() for c in rows]
    if not in_period:
        return {"EUR": None, "USD": None}, 0, by_dir
    eur = sum((c.cost_eur or ZERO for c in in_period), ZERO)
    usd = sum((c.cost_usd or ZERO for c in in_period), ZERO)
    return {"EUR": eur, "USD": usd}, len(in_period), by_dir


def _side(
    row: dict[str, Any] | None,
    bridge: fa.Bridge | None,
    cost: Decimal | None,
    conversions: int,
    ccy: str,
) -> dict[str, Any]:
    eur = ccy == "EUR"
    return {
        "contributed": row["contributions"] if row else None,
        # Euros back from cash-outs (the Periods row's); a euro story, so 0 in dollars.
        "cashed_out": (row.get("cashed_out_eur") or "0") if (row and eur) else "0",
        "market": dec(bridge.market) if bridge else None,
        "currency": dec(bridge.currency) if bridge else None,
        "dividends": row["dividends"] if row else None,
        "interest": row["interest"] if row else None,
        "conversion_cost": dec(cost) if cost is not None else None,
        "conversions": conversions,
        "opening_value": row["opening_value"] if row else None,
        "closing_value": row["closing_value"] if row else None,
        "nominal_return": row["growth_pct"] if row else None,
        "real_return": row.get("real_return") if (row and eur) else None,
        "real_to": row.get("real_to") if (row and eur) else None,
    }


@cached_read
def _figures(*, session: Session, period: str, as_of: str) -> dict[str, Any]:
    monthly = len(period) == 7
    cost, count, by_dir = _conversion_cost(session, period)
    out: dict[str, Any] = {}
    for ccy in CCYS:
        rows = periods.build_for_ccy(session, monthly=monthly, ccy=ccy, fill_gaps=monthly)["rows"]
        row = next((r for r in rows if r["label"] == period), None)
        out[ccy] = _side(row, _bridge(session, ccy, period), cost[ccy], count, ccy) | {
            "conversion_cost_by_direction": by_dir[ccy]
        }
    return out


def get_last_ack(session: Session) -> str | None:
    raw = app_config_service.get(session, ACK_KEY)
    return raw if raw and valid_period(raw) else None


def state(session: Session, *, today: date | None = None) -> dict[str, Any]:
    """Which period the Overview offers and whether it is still to be seen."""
    day = today or build_context(session).as_of
    default = default_period(day)
    last = get_last_ack(session)
    return {"default_period": default, "last_ack": last, "due": last != default}


def build(session: Session, *, period: str | None = None) -> dict[str, Any]:
    """The recap for ``period`` (``YYYY-MM`` / ``YYYY``; default the last finished one)."""
    ctx = build_context(session)
    st = state(session, today=ctx.as_of)
    label = period or st["default_period"]
    first, last = _bounds(label)
    figures = _figures(session=session, period=label, as_of=ctx.as_of.isoformat())
    has_data = any(
        figures[c][k] is not None for c in CCYS for k in ("contributed", "closing_value")
    )
    return {
        "period": label,
        "granularity": "year" if len(label) == 4 else "month",
        "start": first.isoformat(),
        "end": last.isoformat(),
        "is_complete": last < ctx.as_of,
        "has_data": has_data,
        # Shown on the Overview only for the default period, until dismissed.
        "due": st["due"] and label == st["default_period"] and has_data,
        "default_period": st["default_period"],
        "last_ack": st["last_ack"],
        **figures,
    }


def ack(session: Session, period: str) -> str:
    """The owner dismissed the recap of ``period``: remember it (logged)."""
    app_config_service.set_value(session, ACK_KEY, period)
    activity("changes").info("recap for %s dismissed", period)
    return period
