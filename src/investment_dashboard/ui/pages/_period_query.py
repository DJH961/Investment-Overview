"""Period aggregation helpers used by ``/monthly`` and ``/yearly``.

Both pages share a common shape — bucket cashflow transactions by month/year,
compute contributions + dividends + end-of-period mark-to-market closing
balance.

Closing balance is computed via
:func:`investment_dashboard.services.positions_service.total_portfolio_value`
evaluated at the last day of the period (capped at today). It uses
last-known prices and FX rates with forward-fill, so periods preceding
the first available price tick will report a best-effort value.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from investment_dashboard.models import Transaction

ZERO = Decimal(0)


@dataclass(frozen=True)
class PeriodRow:
    """One row of the monthly or yearly aggregation."""

    label: str
    contributions: Decimal
    dividends: Decimal
    interest: Decimal
    net_flow: Decimal
    closing_value_eur: Decimal = ZERO
    opening_value_eur: Decimal = ZERO
    growth_pct: Decimal | None = None


def _amount_eur(t: Transaction) -> Decimal:
    if t.net_eur is not None:
        return t.net_eur
    return t.net_native or ZERO


def _period_key(d: date, *, monthly: bool) -> str:
    return d.strftime("%Y-%m") if monthly else str(d.year)


def _period_end(label: str, *, monthly: bool, today: date) -> date:
    """End-of-period date (capped at ``today``) for a bucket label."""
    if monthly:
        year, month = (int(p) for p in label.split("-"))
        last_day = calendar.monthrange(year, month)[1]
        period_end = date(year, month, last_day)
    else:
        period_end = date(int(label), 12, 31)
    return min(period_end, today)


def _period_start(label: str, *, monthly: bool) -> date:
    """First-of-period date for a bucket label (uncapped)."""
    if monthly:
        year, month = (int(p) for p in label.split("-"))
        return date(year, month, 1)
    return date(int(label), 1, 1)


def _modified_dietz(
    opening: Decimal,
    closing: Decimal,
    net_external_flow: Decimal,
) -> Decimal | None:
    """Modified Dietz period return: ``(V_end - V_start - F) / (V_start + 0.5·F)``.

    ``net_external_flow`` is contributions (positive) minus withdrawals
    (negative-already-signed) — dividends and interest stay *inside* the
    portfolio for this calc (they're internal gains, not external cash).
    Returns ``None`` if the denominator is non-positive.
    """
    denom = opening + net_external_flow / Decimal(2)
    if denom <= 0:
        return None
    return (closing - opening - net_external_flow) / denom


def aggregate(
    session: Session,
    *,
    monthly: bool,
    with_closing_value: bool = True,
    today: date | None = None,
) -> list[PeriodRow]:
    """Return one :class:`PeriodRow` per non-empty period, oldest first.

    If ``with_closing_value`` is true (default) the row's
    ``closing_value_eur`` is the mark-to-market portfolio value at the
    end of that period (capped at ``today``). Set it to ``False`` for
    callers that only need cashflow buckets and want to skip the
    per-period position roll-up.
    """
    txns = session.scalars(select(Transaction)).all()
    buckets: dict[str, dict[str, Decimal]] = {}
    for t in txns:
        key = _period_key(t.date, monthly=monthly)
        b = buckets.setdefault(key, {"contrib": ZERO, "div": ZERO, "int": ZERO})
        amt = _amount_eur(t)
        if t.kind == "deposit":
            b["contrib"] += amt
        elif t.kind == "withdrawal":
            b["contrib"] -= amt
        elif t.kind == "dividend_cash":
            b["div"] += amt
        elif t.kind == "interest":
            b["int"] += amt

    today = today or date.today()
    closing_by_label: dict[str, Decimal] = {}
    opening_by_label: dict[str, Decimal] = {}
    growth_by_label: dict[str, Decimal | None] = {}
    if with_closing_value and buckets:
        # Local import to avoid a cycle: services -> repositories -> models,
        # while this module is imported by the UI layer which also imports
        # services elsewhere.
        from investment_dashboard.services import snapshots_service  # noqa: PLC0415

        for label, agg in buckets.items():
            period_end = _period_end(label, monthly=monthly, today=today)
            period_open = _period_start(label, monthly=monthly)
            try:
                closing_by_label[label] = snapshots_service.get_or_compute(session, period_end)
                # Opening = previous day's close (capped if start > today).
                if period_open <= today:
                    opening_by_label[label] = snapshots_service.get_or_compute(
                        session, period_open - timedelta(days=1)
                    )
                else:
                    opening_by_label[label] = ZERO
            except Exception:  # pragma: no cover - defensive: keep page renderable
                closing_by_label[label] = ZERO
                opening_by_label[label] = ZERO
            growth_by_label[label] = _modified_dietz(
                opening_by_label[label],
                closing_by_label[label],
                agg["contrib"],
            )

    rows = [
        PeriodRow(
            label=k,
            contributions=v["contrib"],
            dividends=v["div"],
            interest=v["int"],
            net_flow=v["contrib"] + v["div"] + v["int"],
            closing_value_eur=closing_by_label.get(k, ZERO),
            opening_value_eur=opening_by_label.get(k, ZERO),
            growth_pct=growth_by_label.get(k),
        )
        for k, v in sorted(buckets.items())
    ]
    return rows


def to_table_rows(rows: list[PeriodRow]) -> list[dict[str, str]]:
    return [
        {
            "label": r.label,
            "contributions": f"{r.contributions:,.2f}",
            "dividends": f"{r.dividends:,.2f}",
            "interest": f"{r.interest:,.2f}",
            "net_flow": f"{r.net_flow:,.2f}",
            "closing_value": f"{r.closing_value_eur:,.2f}",
            "growth_pct": (
                f"{r.growth_pct * Decimal(100):,.2f} %" if r.growth_pct is not None else "—"
            ),
        }
        for r in rows
    ]
