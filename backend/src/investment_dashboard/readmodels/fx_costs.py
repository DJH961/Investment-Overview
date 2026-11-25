"""Currency page, Conversions section (7.3): what converting costs you.

One payload per reporting currency. The EUR side is the cost in euros (``cost_eur``); the
USD side is the same conversions as dollars you did not get, each computed at its own
ECB fixing (never a EUR total at today's rate). See :mod:`domain.fx_spread`.
"""

from __future__ import annotations

from datetime import date
from typing import TYPE_CHECKING, Any

from investment_dashboard.domain import fx_spread
from investment_dashboard.domain.fx_spread import ConversionCost, CostSummary
from investment_dashboard.readmodels import currency_range
from investment_dashboard.readmodels._serialize import dec, iso
from investment_dashboard.repositories import transactions_repo
from investment_dashboard.services import fx_cost_service

if TYPE_CHECKING:
    from sqlalchemy.orm import Session


def _summary(s: CostSummary, ccy: str) -> dict[str, Any]:
    eur = ccy == "EUR"
    return {
        "count": s.count,
        "converted": dec(s.converted_eur if eur else s.converted_usd),
        "fees": dec(s.fees_eur if eur else s.fees_usd),
        "spread": dec(s.spread_eur if eur else s.spread_usd),
        "cost": dec(s.cost_eur if eur else s.cost_usd),
        "cost_pct": dec(s.cost_pct if eur else s.cost_pct_usd),
        "avg_off_pct": dec(s.avg_off_pct),
        "all_in_rate": dec(s.all_in_rate),
    }


def _row(r: ConversionCost, ccy: str) -> dict[str, Any]:
    eur = ccy == "EUR"
    return {
        "id": r.id,
        "date": iso(r.date),
        "provider": None if r.provider == "none" else r.provider,
        "eur_sent": dec(r.eur_sent),
        "usd_received": dec(r.usd_received),
        "ecb_rate": dec(r.ecb_rate),
        "ecb_rate_date": iso(r.ecb_rate_date),
        "off_pct": dec(r.off_pct),
        "fees": dec(r.fees_eur if eur else r.fees_usd),
        "spread": dec(r.spread_eur if eur else r.spread_usd),
        "cost": dec(r.cost_eur if eur else r.cost_usd),
        "month_avg": dec(r.month_avg),
        "month_so_far": r.month_so_far,
        "timing_pct": dec(r.timing_pct),
        "direction": r.direction,
    }


def _cheaper(report: fx_spread.CostReport, ccy: str) -> tuple[str | None, str | None, str | None]:
    """The provider with the lowest cost % of what it converted, and the gap to the next."""
    eur = ccy == "EUR"
    ranked = sorted(
        (
            (s.cost_pct if eur else s.cost_pct_usd, p)
            for p, s in report.by_provider
            if p != "none" and s.count > 0
        ),
        key=lambda t: (t[0] is None, t[0]),
    )
    ranked = [t for t in ranked if t[0] is not None]
    if len(ranked) < 2:
        return None, None, None
    return ranked[0][1], ranked[1][1], dec(ranked[1][0] - ranked[0][0])  # type: ignore[operator]


def _side(
    report: fx_spread.CostReport, ccy: str, range_key: str, start: date | None
) -> dict[str, Any]:
    eur = ccy == "EUR"
    cheaper, cheaper_than, gap = _cheaper(report, ccy)
    return {
        "currency": ccy,
        "range": range_key,
        "start": iso(start),
        "unpriced": report.unpriced,
        "summary": _summary(report.summary, ccy),
        "best": None if report.best is None else _row(report.best, ccy),
        "worst": None if report.worst is None else _row(report.worst, ccy),
        "cumulative": [
            {"date": iso(p.date), "cost": dec(p.cost_eur if eur else p.cost_usd)}
            for p in report.cumulative
        ],
        "timing": {
            "count": report.timing.count,
            "avg_pct": dec(report.timing.avg_pct),
            "better": report.timing.better,
            "worse": report.timing.worse,
            "so_far": report.timing.so_far,
        },
        "by_year": [{"year": y, **_summary(s, ccy)} for y, s in report.by_year],
        "by_month": [{"month": m, **_summary(s, ccy)} for m, s in report.by_month],
        "by_provider": [
            {"provider": None if p == "none" else p, **_summary(s, ccy)}
            for p, s in report.by_provider
        ],
        "cheaper_provider": cheaper,
        "cheaper_than": cheaper_than,
        "cheaper_gap_pct": gap,
        "rows": [_row(r, ccy) for r in report.rows],
    }


def build_costs_both(session: Session, range_key: str, today: date) -> dict[str, dict[str, Any]]:
    """``{"EUR": ..., "USD": ...}`` for conversions dated in the range.

    The top level is EUR -> USD (the 7.3 figures). ``back_to_eur`` is the same payload
    for the conversions back (7.4: cost, timing and providers in that direction, each
    row with ``direction``), or ``None`` when there has been none.
    """
    convs = fx_cost_service.conversions_with_fixings(session)
    backs = fx_cost_service.conversions_with_fixings(session, direction="to_eur")
    first = transactions_repo.earliest_transaction_date(session) or min(
        (c.date for c in (*convs, *backs)), default=None
    )
    # Conversions dated inside the range (``after`` is the close before it).
    window = currency_range.resolve(range_key, today, first)
    start = window.start
    report = fx_spread.build_report(convs, start=start, end=today)
    back = fx_spread.build_report(backs, start=start, end=today) if backs else None
    return {
        ccy: _side(report, ccy, range_key, start)
        | {
            "window": window.to_dict(),
            "back_to_eur": None if back is None else _side(back, ccy, range_key, start),
        }
        for ccy in ("EUR", "USD")
    }
