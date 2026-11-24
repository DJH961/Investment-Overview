"""The Currency page's investing view (Impact, USD side): what the rate did to your deposits.

The USD view reads the currency the way you invest: you send euros, they become
dollars. Each USD deposit's euro cost is the rate you actually got
(``fx_conversion_service``'s matching of your recorded conversions, the same
effective euro cost the cashflow legs use) or, unmatched, the ECB fixing of that
day (forward-filled: a weekend deposit takes Friday's fixing). Against the rate at
the range start, :mod:`domain.deposit_effect` gives each deposit's effect in
dollars: positive when your euros bought more dollars than they would have then.

Reference rate (``start_rate``): the settled rate on the range's start close; for
All, the rate on your first transaction's day (there is no earlier close of yours
to measure from). 💱 Native dollars received, euros at their own date's rate; the
effect is a sum of dollar amounts, never a return or a converted figure.
"""

from __future__ import annotations

import bisect
from collections.abc import Callable, Sequence
from datetime import date, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.domain import deposit_effect as de
from investment_dashboard.domain.kinds import DEPOSIT
from investment_dashboard.readmodels import fx_attribution_rows as rows_rm
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.repositories import transactions_repo
from investment_dashboard.services import fx_conversion_service, investing_power_service
from investment_dashboard.services.read_cache import cached_read

ZERO = Decimal(0)
Q_MONEY = Decimal("0.000001")
Q_FRAC = Decimal("0.00000001")
#: Above this many deposits the per-deposit list is cut (the sub-page shows them all).
MAX_DEPOSIT_ROWS = 500


def _m(v: Decimal) -> str:
    return dec(v.quantize(Q_MONEY)) or "0"


def _kind(v: Decimal) -> str:
    q = v.quantize(Q_MONEY)
    return "tailwind" if q > 0 else "headwind" if q < 0 else "neutral"


def rate_lookup(session: Session) -> Callable[[date], Decimal | None]:
    """The settled EUR/USD on or before a date (no live overlay on a past day)."""
    items = sorted((d, r) for d, r in rows_rm.settled_rates(session, "USD").items() if r > 0)
    dates = [d for d, _ in items]
    rates = [r for _, r in items]

    def at(on: date) -> Decimal | None:
        i = bisect.bisect_right(dates, on)
        return rates[i - 1] if i else None

    return at


@cached_read
def usd_deposits(session: Session) -> list[de.Deposit]:
    """Every deposit into a USD account with its euro cost (see the module doc)."""
    txns = [
        t
        for t in transactions_repo.list_transactions(session)
        if t.kind == DEPOSIT
        and t.account is not None
        and t.account.native_currency.upper() == "USD"
        and (t.net_native or ZERO) > 0
    ]
    if not txns:
        return []
    matches = {}
    if fx_conversion_service.list_conversions(session):
        matches = {
            m.deposit_id: m for m in fx_conversion_service.pool_report(session).result.deposits
        }
    rate_at = rate_lookup(session)
    out: list[de.Deposit] = []
    for t in txns:
        usd = t.net_native or ZERO
        m = matches.get(t.id)
        if m is not None and not m.rate_missing and m.eur_total > 0 and m.matched_usd > 0:
            source = "matched" if m.fallback_usd == 0 else "partly"
            out.append(de.Deposit(t.id, t.date, usd, m.eur_total, source))
            continue
        r = rate_at(t.date)
        if r is None:
            continue  # no rate on file: an honest gap, never a rate of 1
        out.append(de.Deposit(t.id, t.date, usd, usd / r, "ecb"))
    return out


def start_of(after: date, first: date | None) -> date | None:
    """The reference day: the range's start close, or (All) the first transaction day."""
    if after == date.min:
        return first
    return after


def window_effect(
    session: Session, after: date, through: date, first: date | None
) -> Decimal | None:
    """The investing effect over ``(after, through]`` (``None`` without deposits ever)."""
    deposits = usd_deposits(session=session)
    start_on = start_of(after, first)
    if not deposits or start_on is None:
        return None
    r0 = rate_lookup(session)(start_on)
    if r0 is None:
        return None
    items = de.effects([d for d in deposits if after < d.on <= through], r0)
    return de.totals(items).effect


def _bars(groups: Sequence[tuple[str, Decimal]]) -> list[dict[str, Any]]:
    return [{"label": k, "currency": _m(v), "kind": _kind(v)} for k, v in groups]


def _grid(months: Sequence[tuple[str, Decimal]]) -> list[dict[str, Any]]:
    by_year: dict[int, list[Decimal | None]] = {}
    for label, v in months:
        year, month = int(label[:4]), int(label[5:7])
        by_year.setdefault(year, [None] * 12)[month - 1] = v
    out = []
    for year in sorted(by_year):
        cells = by_year[year]
        total = sum((c for c in cells if c is not None), ZERO)
        out.append(
            {
                "year": year,
                "months": [None if c is None else _m(c) for c in cells],
                "total": _m(total),
                "kind": _kind(total),
            }
        )
    return out


def _best_worst(
    groups: Sequence[tuple[str, Decimal]],
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    if not groups:
        return None, None
    best = max(groups, key=lambda g: g[1])
    worst = min(groups, key=lambda g: g[1])
    return (
        {"label": best[0], "currency": _m(best[1])},
        {"label": worst[0], "currency": _m(worst[1])},
    )


def _week_ends(lo: date, hi: date) -> list[date]:
    """The last day of each ISO week in ``[lo, hi]``, plus ``hi``."""
    out: list[date] = []
    d = lo
    while d <= hi:
        nxt = d + timedelta(days=1)
        if nxt > hi or nxt.isocalendar()[:2] != d.isocalendar()[:2]:
            out.append(d)
        d = nxt
    return out


def build_investing(
    session: Session, after: date, through: date, *, first: date | None
) -> dict[str, Any] | None:
    """The USD view's investing block for ``(after, through]``; ``None`` without any
    USD deposit or rate (the side then keeps its book view)."""
    deposits = usd_deposits(session=session)
    start_on = start_of(after, first)
    if not deposits or start_on is None:
        return None
    rate_at = rate_lookup(session)
    amount = investing_power_service.get_amount_eur(session)
    r0 = rate_at(start_on)
    r_end = rate_at(through)
    if r0 is None or r_end is None:
        return None
    in_range = [d for d in deposits if after < d.on <= through]
    items = de.effects(in_range, r0)
    tot = de.totals(items)
    points = de.cumulative(items, start_on)
    if points[-1].on < through:
        points.append(de.SeriesPoint(through, points[-1].usd, points[-1].usd_at_start))
    months = de.month_totals(items)
    years = de.year_totals(items)
    best_day, worst_day = _best_worst([(e.deposit.on.isoformat(), e.effect) for e in items])
    best_month, worst_month = _best_worst(months)
    best_year, worst_year = _best_worst(years)

    # Lifetime: from the first transaction day's rate, as the All range.
    life_start = first or deposits[0].on
    r_life = rate_at(life_start)
    lifetime_effect = average = months_of = None
    if r_life is not None:
        lifetime_effect = de.totals(de.effects(deposits, r_life)).effect
        n_months = (through.year - life_start.year) * 12 + through.month - life_start.month + 1
        if n_months > 0:
            average = sum((d.usd for d in deposits), ZERO) / Decimal(n_months)
        if lifetime_effect and average:
            months_of = lifetime_effect / average

    roll_lo = max(start_on, life_start + timedelta(days=365))
    rolling = (
        de.rolling(deposits, rate_at, _week_ends(roll_lo, through)) if roll_lo < through else []
    )

    up = sum(1 for _k, v in months if v.quantize(Q_MONEY) > 0)
    stats: list[dict[str, Any]] = []
    if months:
        stats.append(
            {
                "key": "tailwind_share",
                "value": dec((Decimal(up) / Decimal(len(months))).quantize(Q_FRAC)),
                "unit": "fraction",
                "secondary": dec(Decimal(len(months))),
                "secondary_unit": "count",
            }
        )
    if items:
        largest = max(items, key=lambda e: abs(e.effect))
        stats.append(
            {
                "key": "largest_day",
                "value": _m(largest.effect),
                "unit": "money",
                "currency": "USD",
                "label": largest.deposit.on.isoformat(),
                "kind": _kind(largest.effect),
            }
        )
    rows = sorted(items, key=lambda e: abs(e.effect), reverse=True)[:MAX_DEPOSIT_ROWS]
    return {
        "start_on": start_on.isoformat(),
        "end_on": through.isoformat(),
        "start_rate": dec(r0),
        "end_rate": dec(r_end),
        "effect": _m(tot.effect),
        "kind": _kind(tot.effect),
        "deposit_count": len(items),
        "eur_sent": _m(tot.eur),
        "usd_received": _m(tot.usd),
        "usd_at_start": _m(tot.usd_at_start),
        "average_rate": dec(tot.usd / tot.eur) if tot.eur > 0 else None,
        "series": [
            {
                "t": p.on.isoformat(),
                "value": _m(p.usd),
                "constant_currency": _m(p.usd_at_start),
                "currency": _m(p.effect),
            }
            for p in points
        ],
        "months": _bars(months),
        "years": _bars(years),
        "grid": _grid(months),
        "rolling": [{"t": t.isoformat(), "currency": _m(v)} for t, v in rolling],
        "records": {
            "best_day": best_day,
            "worst_day": worst_day,
            "best_month": best_month,
            "worst_month": worst_month,
            "best_year": best_year,
            "worst_year": worst_year,
            "lifetime_effect": None if lifetime_effect is None else _m(lifetime_effect),
            "average_monthly_contribution": None if average is None else _m(average),
            "lifetime_months_of_contributions": None
            if months_of is None
            else dec(months_of.quantize(Q_FRAC)),
        },
        "deposits": [
            {
                "transaction_id": e.deposit.id,
                "on": e.deposit.on.isoformat(),
                "usd": _m(e.deposit.usd),
                "eur": _m(e.deposit.eur),
                "rate": dec(e.deposit.rate.quantize(Q_FRAC)),
                "start_rate": dec(r0),
                "effect": _m(e.effect),
                "source": e.deposit.source,
            }
            for e in rows
        ],
        "rate_only": {
            "amount_eur": dec(amount),
            "start_rate": dec(r0),
            "end_rate": dec(r_end),
            "usd_at_start": _m(amount * r0),
            "usd_now": _m(amount * r_end),
            "change": _m(amount * (r_end - r0)),
            "kind": _kind(r_end - r0),
        },
        "stats": stats,
    }


__all__ = ["build_investing", "rate_lookup", "usd_deposits", "window_effect"]
