"""Query helpers for ``/overview`` — KPI quartet + position rows + treemap data."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.services.metrics_service import (
    PortfolioMetrics,
    compute_portfolio_metrics,
)
from investment_dashboard.services.positions_service import (
    Position,
    compute_positions,
)

ZERO = Decimal(0)


@dataclass(frozen=True)
class TreemapDatum:
    """One slice of the allocation treemap."""

    label: str
    value_eur: Decimal


def get_metrics(session: Session, *, as_of: date | None = None) -> PortfolioMetrics:
    return compute_portfolio_metrics(session, as_of=as_of)


def get_positions(session: Session, *, as_of: date | None = None) -> list[Position]:
    return compute_positions(session, as_of=as_of)


def position_rows(
    positions: list[Position],
    *,
    display_currency: str = "EUR",
    fx_rate: Decimal | None = None,
) -> list[dict[str, Any]]:
    """Shape positions for the AG-Grid table on the overview page.

    ``display_currency`` selects the secondary "Value" column the page
    highlights. The native and EUR columns are always present; a USD
    column is added so a single render carries both currencies (spec §1
    "simultaneous USD and EUR views"). ``fx_rate`` is EUR→USD; pass
    ``None`` to leave the USD column blank.
    """
    rows: list[dict[str, Any]] = []
    for p in positions:
        if p.current_value_eur is not None and fx_rate is not None and fx_rate != 0:
            value_usd = p.current_value_eur * fx_rate
            value_usd_str = f"{value_usd:,.2f}"
        elif p.account.native_currency == "USD":
            value_usd_str = f"{p.current_value_native:,.2f}"
        else:
            value_usd_str = ""
        rows.append(
            {
                "symbol": p.instrument.symbol,
                "name": p.instrument.name or "",
                "category": p.instrument.category or "",
                "shares": f"{p.shares:,.4f}",
                "avg_price": (f"{(p.cost_basis_native / p.shares):,.4f}" if p.shares else ""),
                "current_price": (
                    f"{p.current_price_native:,.4f}" if p.current_price_native is not None else ""
                ),
                "cost_basis_native": f"{p.cost_basis_native:,.2f}",
                "current_value_native": f"{p.current_value_native:,.2f}",
                "current_value_usd": value_usd_str,
                "current_value_eur": f"{p.current_value_eur:,.2f}",
                "total_growth_pct": _growth_pct(p),
                "display_currency": display_currency,
            }
        )
    return rows


def _growth_pct(p: Position) -> str:
    if p.cost_basis_native == ZERO:
        return ""
    pct = (p.current_value_native - p.cost_basis_native) / p.cost_basis_native * Decimal(100)
    return f"{pct:,.2f} %"


def allocation_treemap(positions: list[Position]) -> list[TreemapDatum]:
    """Aggregate positions by ``instrument.category`` (fallback ``asset_class``)."""
    bucket: dict[str, Decimal] = {}
    for p in positions:
        key = p.instrument.category or p.instrument.asset_class or "Uncategorized"
        bucket[key] = bucket.get(key, ZERO) + p.current_value_eur
    items = [TreemapDatum(label=k, value_eur=v) for k, v in bucket.items() if v > ZERO]
    items.sort(key=lambda d: d.value_eur, reverse=True)
    return items
