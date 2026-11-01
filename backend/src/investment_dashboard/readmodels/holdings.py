"""Holdings read-model for ``GET /api/holdings`` (ccy-aware, one row per instrument).

💱 CURRENCY (rule in ``AGENTS.md``): money and returns are *selected* from the
existing EUR / USD legs of :class:`HoldingCard` (each computed independently per
currency); a return is never converted. ``price_native`` stays in the
instrument's native currency. A USD leg that does not exist is ``None``.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from investment_dashboard.readmodels._context import build_context
from investment_dashboard.readmodels._serialize import dec, iso
from investment_dashboard.readmodels.queries.overview_query import (
    HoldingCard,
    InstrumentMetrics,
    build_holding_cards,
    compute_instrument_metrics,
    holding_freshness,
)
from investment_dashboard.services import prices_service
from investment_dashboard.services.positions_service import Position, compute_positions

ZERO = Decimal(0)


def merge_positions_by_instrument(positions: list[Position]) -> list[Position]:
    """Collapse the per-(account, instrument) positions to one per instrument.

    The per-instrument metrics already span every account, so a card per account
    would repeat the instrument-wide value on each (double counting). Shares,
    cost basis and values are summed; the first account stands for the row.
    """
    merged: dict[int, Position] = {}
    for p in positions:
        iid = p.instrument.id
        prev = merged.get(iid)
        if prev is None:
            merged[iid] = p
            continue
        merged[iid] = replace(
            prev,
            shares=prev.shares + p.shares,
            cost_basis_native=prev.cost_basis_native + p.cost_basis_native,
            current_value_native=prev.current_value_native + p.current_value_native,
            current_value_eur=prev.current_value_eur + p.current_value_eur,
            cumulative_dividends_cash_native=(
                prev.cumulative_dividends_cash_native + p.cumulative_dividends_cash_native
            ),
            value_warning=prev.value_warning or p.value_warning,
        )
    return list(merged.values())


def pick(eur: Decimal | None, usd: Decimal | None, ccy: str) -> Decimal | None:
    """Select the leg for ``ccy`` (no conversion)."""
    return usd if ccy == "USD" else eur


def _gain_split(
    card: HoldingCard, ccy: str
) -> tuple[Decimal | None, Decimal | None, Decimal | None]:
    """``(capital_gain, dividends, total_return)`` for one holding in ``ccy``.

    The card's gain already includes cash dividends (``value + dividends -
    cost``): that is the *total return*. Capital gain is ``value - cost basis``;
    dividends are the remainder.
    """
    total_return = pick(card.capital_gain_eur, card.capital_gain_usd, ccy)
    value = pick(card.value_eur, card.value_usd, ccy)
    cost = pick(card.cost_basis_eur, card.cost_basis_usd, ccy)
    if total_return is None or value is None or cost is None:
        return None, None, total_return
    capital_gain = value - cost
    return capital_gain, total_return - capital_gain, total_return


def holding_row(
    card: HoldingCard,
    position: Position,
    metrics: InstrumentMetrics | None,
    ccy: str,
) -> dict[str, Any]:
    eff = position.effective
    asset_class = (eff.asset_class if eff is not None else position.instrument.asset_class) or ""
    value = pick(card.value_eur, card.value_usd, ccy)
    gain, dividends, total_return = _gain_split(card, ccy)
    return {
        "instrument_id": card.instrument_id,
        "symbol": card.symbol,
        "name": card.name,
        "category": card.category,
        "asset_class": asset_class,
        "account": position.account.account_label,
        "native_currency": card.native_currency,
        "shares": dec(card.shares),
        "avg_price_native": dec(card.avg_price_native),
        "price_native": dec(card.current_price_native),
        "price_as_of": iso(card.price_as_of),
        "updated_at": iso(card.updated_at),
        "price_type": "nav" if card.is_money_market else "market",
        "is_money_market": card.is_money_market,
        "market_open": card.market_open,
        "expense_ratio": dec(card.expense_ratio),
        "cost_basis": dec(pick(card.cost_basis_eur, card.cost_basis_usd, ccy)),
        "value": dec(value),
        "capital_gain": dec(gain),
        "dividends": dec(dividends),
        "total_return": dec(total_return),
        "xirr": dec(pick(card.xirr_eur, card.xirr_usd, ccy)),
        "total_growth": dec(pick(card.total_growth_eur, card.total_growth_usd, ccy)),
        "ytd_growth": dec(pick(card.ytd_growth_eur, card.ytd_growth_usd, ccy)),
        "mtd_growth": dec(
            pick(
                metrics.mtd_growth_eur if metrics else None,
                metrics.mtd_growth_usd if metrics else None,
                ccy,
            )
        ),
        "today_pct": dec(pick(card.daily_growth_eur, card.daily_growth_usd, ccy)),
        "today_move": dec(pick(card.daily_move_eur, card.daily_move_usd, ccy)),
        "daily_growth_as_of": iso(card.daily_growth_as_of),
        "daily_is_stale": card.daily_is_stale,
        "weight_pct": dec(card.weight),
        "value_warning": card.value_warning,
        "price_data_warning": card.price_data_warning,
    }


def _summary(rows: list[dict[str, Any]], cards: list[HoldingCard], ccy: str) -> dict[str, Any]:
    scored = [
        (c, pick(c.total_growth_eur, c.total_growth_usd, ccy))
        for c in cards
        if pick(c.total_growth_eur, c.total_growth_usd, ccy) is not None
    ]
    best = max(scored, key=lambda t: t[1], default=None)  # type: ignore[arg-type,return-value]
    worst = min(scored, key=lambda t: t[1], default=None)  # type: ignore[arg-type,return-value]
    largest = max(cards, key=lambda c: c.weight or ZERO, default=None)
    gainers = sum(1 for c in cards if (c.daily_move_eur or ZERO) > ZERO)
    losers = sum(1 for c in cards if (c.daily_move_eur or ZERO) < ZERO)
    splits = [_gain_split(c, ccy)[0] for c in cards]
    in_profit = sum(1 for g in splits if g is not None and g > ZERO)
    in_loss = sum(1 for g in splits if g is not None and g < ZERO)
    return {
        "best_symbol": best[0].symbol if best else None,
        "best_growth": dec(best[1]) if best else None,
        "worst_symbol": worst[0].symbol if worst else None,
        "worst_growth": dec(worst[1]) if worst else None,
        "most_concentrated_symbol": largest.symbol if largest and largest.weight else None,
        "most_concentrated_weight_pct": dec(
            largest.weight if largest and largest.weight is not None else None
        ),
        "gainers": gainers,
        "losers": losers,
        "in_profit": in_profit,
        "in_loss": in_loss,
    }


def build(session: Session, *, ccy: str, as_of: date | None = None) -> dict[str, Any]:
    """The ``GET /api/holdings`` payload."""
    ctx = build_context(session, as_of=as_of)
    positions = merge_positions_by_instrument(compute_positions(session, as_of=ctx.as_of))
    metrics = compute_instrument_metrics(session, positions, as_of=ctx.as_of)
    freshness = holding_freshness(session, positions)
    anomalies = prices_service.instruments_with_price_anomalies(
        session, [p.instrument.id for p in positions]
    )
    cards = build_holding_cards(
        positions, metrics=metrics, freshness=freshness, price_anomaly_ids=anomalies
    )
    by_id = {p.instrument.id: p for p in positions}
    rows = [
        holding_row(c, by_id[c.instrument_id], metrics.get(c.instrument_id), ccy) for c in cards
    ]
    total_value = _sum([pick(c.value_eur, c.value_usd, ccy) for c in cards])
    splits = [_gain_split(c, ccy) for c in cards]
    total_gain = _sum([s[0] for s in splits])
    total_dividends = _sum([s[1] for s in splits])
    total_return = _sum([s[2] for s in splits])
    total_cost = _sum([pick(c.cost_basis_eur, c.cost_basis_usd, ccy) for c in cards])
    return {
        "ccy": ccy,
        "as_of": ctx.as_of.isoformat(),
        "fx_eur_usd": dec(ctx.fx_rate_eur_usd),
        "total_value": dec(total_value),
        "total_cost_basis": dec(total_cost),
        "total_capital_gain": dec(total_gain),
        "total_dividends": dec(total_dividends),
        "total_return": dec(total_return),
        "holdings": rows,
        "summary": _summary(rows, cards, ccy),
    }


def _sum(values: list[Decimal | None]) -> Decimal | None:
    """Sum of the present legs; ``None`` when any holding lacks the leg."""
    if any(v is None for v in values):
        return None
    return sum((v for v in values if v is not None), start=ZERO)
