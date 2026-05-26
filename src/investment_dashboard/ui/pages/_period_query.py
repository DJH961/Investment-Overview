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
from datetime import date
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
    if with_closing_value and buckets:
        # Local import to avoid a cycle: services -> repositories -> models,
        # while this module is imported by the UI layer which also imports
        # services elsewhere.
        from investment_dashboard.services import positions_service  # noqa: PLC0415

        for label in buckets:
            as_of = _period_end(label, monthly=monthly, today=today)
            try:
                closing_by_label[label] = positions_service.total_portfolio_value(
                    session, as_of=as_of
                )
            except Exception:  # pragma: no cover - defensive: keep page renderable
                closing_by_label[label] = ZERO

    rows = [
        PeriodRow(
            label=k,
            contributions=v["contrib"],
            dividends=v["div"],
            interest=v["int"],
            net_flow=v["contrib"] + v["div"] + v["int"],
            closing_value_eur=closing_by_label.get(k, ZERO),
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
        }
        for r in rows
    ]
