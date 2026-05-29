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
from investment_dashboard.ui.money_format import dual_money

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


def _to_eur_usd(
    amount_native: Decimal, native: str, fx_rate: Decimal | None
) -> tuple[Decimal | None, Decimal | None]:
    """Convert a native-currency amount to (EUR, USD) using today's spot FX.

    ``fx_rate`` is EUR→USD. Returns ``(None, None)`` when the FX rate is
    missing for non-EUR/USD accounts.
    """
    if native == "EUR":
        eur = amount_native
        usd = amount_native * fx_rate if fx_rate is not None and fx_rate != 0 else None
    elif native == "USD":
        usd = amount_native
        eur = amount_native / fx_rate if fx_rate is not None and fx_rate != 0 else None
    else:  # pragma: no cover - DKK removed in v2.4
        eur = usd = None
    return eur, usd


def position_rows(
    positions: list[Position],
    *,
    display_currency: str = "EUR",
    fx_rate: Decimal | None = None,
) -> list[dict[str, Any]]:
    """Shape positions for the AG-Grid table on the overview page.

    v2.5 — every monetary column is rendered as a dual ``$X / €Y`` pair
    via :func:`dual_money` so EUR and USD are always shown together.
    ``display_currency`` controls which currency appears first;
    ``fx_rate`` (EUR→USD) is used to translate values to the
    non-native currency. The legacy single-currency keys
    (``current_value_usd``, ``current_value_eur``) are retained for
    backwards compatibility with any caller / test that still reads
    them.
    """
    rows: list[dict[str, Any]] = []
    for p in positions:
        native = p.account.native_currency
        value_eur, value_usd = (
            (p.current_value_eur, p.current_value_eur * fx_rate if fx_rate else None)
            if native == "EUR"
            else _to_eur_usd(p.current_value_native, native, fx_rate)
        )
        cost_eur, cost_usd = _to_eur_usd(p.cost_basis_native, native, fx_rate)
        gain_eur = value_eur - cost_eur if value_eur is not None and cost_eur is not None else None
        gain_usd = value_usd - cost_usd if value_usd is not None and cost_usd is not None else None
        eff = p.effective
        rows.append(
            {
                "symbol": p.instrument.symbol,
                "name": (eff.name if eff is not None else p.instrument.name) or "",
                "category": p.category or "",
                "shares": f"{p.shares:,.4f}",
                "avg_price": (f"{(p.cost_basis_native / p.shares):,.4f}" if p.shares else ""),
                "current_price": (
                    f"{p.current_price_native:,.4f}" if p.current_price_native is not None else ""
                ),
                # Legacy single-currency keys (kept for back-compat).
                "cost_basis_native": f"{p.cost_basis_native:,.2f}",
                "current_value_native": f"{p.current_value_native:,.2f}",
                "current_value_usd": (f"{value_usd:,.2f}" if value_usd is not None else ""),
                "current_value_eur": (
                    f"{value_eur:,.2f}" if value_eur is not None else f"{p.current_value_eur:,.2f}"
                ),
                # v2.5 dual columns.
                "value_dual": dual_money(value_eur, value_usd, primary=display_currency),
                "cost_basis_dual": dual_money(cost_eur, cost_usd, primary=display_currency),
                "capital_gain_dual": dual_money(gain_eur, gain_usd, primary=display_currency),
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
    """Aggregate positions by user-tier ``category`` (fallback effective ``asset_class``)."""
    bucket: dict[str, Decimal] = {}
    for p in positions:
        eff = p.effective
        fallback_class = eff.asset_class if eff is not None else p.instrument.asset_class
        key = p.category or fallback_class or "Uncategorized"
        bucket[key] = bucket.get(key, ZERO) + p.current_value_eur
    items = [TreemapDatum(label=k, value_eur=v) for k, v in bucket.items() if v > ZERO]
    items.sort(key=lambda d: d.value_eur, reverse=True)
    return items
