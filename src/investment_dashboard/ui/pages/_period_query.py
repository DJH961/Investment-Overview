"""Period aggregation helpers used by ``/monthly`` and ``/yearly``.

Both pages share a common shape — bucket cashflow transactions by month/year,
compute contributions + dividends + closing-balance proxy.

The closing balance is **best-effort** at this stage: it uses the cumulative
sum of all cashflow rows (deposits + interest + dividends − withdrawals)
as a contribution-driven proxy. v1.1 will use proper end-of-period
mark-to-market with historical prices.
"""

from __future__ import annotations

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


def _amount_eur(t: Transaction) -> Decimal:
    if t.net_eur is not None:
        return t.net_eur
    return t.net_native or ZERO


def _period_key(d: date, *, monthly: bool) -> str:
    return d.strftime("%Y-%m") if monthly else str(d.year)


def aggregate(session: Session, *, monthly: bool) -> list[PeriodRow]:
    """Return one :class:`PeriodRow` per non-empty period, oldest first."""
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
    rows = [
        PeriodRow(
            label=k,
            contributions=v["contrib"],
            dividends=v["div"],
            interest=v["int"],
            net_flow=v["contrib"] + v["div"] + v["int"],
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
        }
        for r in rows
    ]
