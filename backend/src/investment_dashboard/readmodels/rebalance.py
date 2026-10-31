"""Rebalance-plan assembly, shared by the NiceGUI calculator and the v6 API.

Extracted from ``ui/pages/calculator.py`` (behaviour unchanged): category target
expansion, the "held but un-ticked" category credit, and the call into
:func:`investment_dashboard.domain.allocation.plan_rebalance`.

💱 CURRENCY (rule in ``AGENTS.md``): every figure is planned in EUR (the existing
calculator basis). :func:`build_target_plan` converts the cash in at the single
spot rate and the rows back out at the same rate - single-instant conversions
only, never a return.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.domain.allocation import (
    RebalancePlan,
    expand_category_weights,
    plan_rebalance,
)
from investment_dashboard.readmodels._serialize import dec
from investment_dashboard.readmodels.queries.calculator_query import (
    UNCATEGORIZED,
    CalcData,
    build_calculator_data,
)
from investment_dashboard.repositories import allocations_repo

ZERO = Decimal(0)
HUNDRED = Decimal(100)
TENTH = Decimal("0.1")


class RebalanceInputError(ValueError):
    """The requested plan cannot be assembled from the given inputs."""


def round_to_100(weights: dict[int, Decimal]) -> dict[int, Decimal]:
    """Round weights to one decimal and absorb the residual into the largest."""
    rounded = {i: w.quantize(TENTH) for i, w in weights.items() if w > ZERO}
    if not rounded:
        return {}
    residual = HUNDRED - sum(rounded.values(), start=ZERO)
    if residual != ZERO:
        biggest = max(rounded, key=lambda i: rounded[i])
        rounded[biggest] += residual
    return rounded


def scale_to_100(weights: dict[int, Decimal]) -> dict[int, Decimal]:
    """Normalise positive weights so they sum to exactly 100."""
    total = sum((w for w in weights.values() if w > ZERO), start=ZERO)
    if total <= ZERO:
        return {}
    return {i: w * HUNDRED / total for i, w in weights.items() if w > ZERO}


def expand_category_targets(
    cat_targets: Mapping[str, Decimal],
    *,
    cat_members: Mapping[str, list[int]],
    cat_selected: Mapping[str, set[int]],
    cat_split: Mapping[str, str],
    current_values: Mapping[int, Decimal],
) -> dict[int, Decimal]:
    """Expand category-level target weights into per-fund weights.

    Each category's % is split across only the ticked (selected) funds. Raises
    :class:`RebalanceInputError` when no category has a positive target, or a
    targeted category has no ticked fund.
    """
    cat_weights = {name: w for name, w in cat_targets.items() if w > ZERO}
    if not cat_weights:
        raise RebalanceInputError("Set at least one category target")
    weights: dict[int, Decimal] = {}
    for name, weight in cat_weights.items():
        members = cat_members.get(name, [])
        if not members:
            continue
        selected = [mid for mid in members if mid in cat_selected.get(name, set())]
        if not selected:
            raise RebalanceInputError(
                f"Tick at least one fund to invest in for “{name}”, or set its target to 0."
            )
        expanded = expand_category_weights(
            {name: weight},
            {name: selected},
            current_values,
            split=cat_split.get(name, "value"),  # type: ignore[arg-type]
        )
        for mid, w in expanded.items():
            weights[mid] = weights.get(mid, ZERO) + w
    return weights


def held_unticked_extras(
    target_pct: dict[int, Decimal],
    current_values: Mapping[int, Decimal],
    *,
    category_mode: bool,
    allow_sell: bool,
    cat_targets: Mapping[str, Decimal],
    cat_selected: Mapping[str, set[int]],
    cat_members: Mapping[str, list[int]],
    category_by_id: Mapping[int, str],
) -> tuple[set[int], dict[int, str] | None]:
    """Fold held-but-un-ticked funds into a buy-only category plan.

    The held, un-ticked members of every *targeted* category are added to
    ``target_pct`` (mutated in place) as 0 %-target rows, returned in the
    ``no_buy`` set so they are never bought, and a ``{id: category}`` map is
    returned so :func:`plan_rebalance` measures each category's shortfall as a
    whole. Returns ``(set(), None)`` outside buy-only category mode.
    """
    if not category_mode or allow_sell:
        return set(), None
    no_buy_ids: set[int] = set()
    for name, weight in cat_targets.items():
        if weight <= ZERO:
            continue
        selected = cat_selected.get(name, set())
        for mid in cat_members.get(name, []):
            if mid in selected or mid in target_pct:
                continue
            if current_values.get(mid, ZERO) <= ZERO:
                continue
            target_pct.setdefault(mid, ZERO)
            no_buy_ids.add(mid)
    category_of = {mid: category_by_id.get(mid, UNCATEGORIZED) for mid in target_pct}
    return no_buy_ids, category_of


def compute_plan(
    data: CalcData,
    target_pct: dict[int, Decimal],
    *,
    cash_eur: Decimal,
    no_buy: set[int],
    extra_no_buy: set[int],
    category_of: dict[int, str] | None,
    allow_fractional: bool,
    allow_sell: bool,
) -> RebalancePlan:
    """Run :func:`plan_rebalance` against the calculator data (EUR basis)."""
    by_id = data.by_id()
    current_values = {i.instrument_id: i.current_value_eur for i in data.instruments}
    no_buy_ids = set(no_buy) | extra_no_buy
    current_prices = {
        mid: by_id[mid].price_eur
        for mid in target_pct
        if mid in by_id and by_id[mid].price_eur is not None
    }
    return plan_rebalance(
        cash_eur,
        target_pct,
        {mid: current_values.get(mid, ZERO) for mid in target_pct},
        current_prices,  # type: ignore[arg-type]
        allow_fractional_shares=allow_fractional,
        allow_sell=allow_sell,
        no_buy_ids=no_buy_ids & set(target_pct),
        category_of=category_of,
    )


# -- v6 API: plan for the saved (active) target -------------------------------


@dataclass(frozen=True)
class PlanRow:
    instrument_id: int
    symbol: str
    name: str
    target_pct: Decimal
    current_value: Decimal | None
    add_value: Decimal | None
    current_price: Decimal | None
    add_shares: Decimal
    no_buy: bool


@dataclass(frozen=True)
class TargetPlan:
    ccy: str
    target_id: int
    target_name: str
    cash_to_invest: Decimal | None
    residual_cash: Decimal | None
    allow_sell: bool
    allow_fractional: bool
    fx_eur_usd: Decimal | None
    rows: list[PlanRow]


def _in_ccy(value_eur: Decimal | None, ccy: str, fx: Decimal | None) -> Decimal | None:
    if value_eur is None:
        return None
    if ccy == "EUR":
        return value_eur
    return value_eur * fx if fx is not None and fx > ZERO else None


def build_target_plan(
    session: Session,
    *,
    amount: Decimal,
    ccy: str,
    allow_fractional: bool = False,
    allow_sell: bool | None = None,
    target_id: int | None = None,
) -> TargetPlan:
    """Rebalance plan for the active (or ``target_id``) saved target allocation.

    ``amount`` is in ``ccy``; it is converted to EUR at the spot rate, planned in
    EUR and the rows converted back at the same spot. ``allow_sell`` defaults to
    the target's own flag. Raises :class:`RebalanceInputError` for any input the
    planner rejects (no target, no weights, bad amount, ``ValueError`` inside).
    """
    if target_id is None:
        target = allocations_repo.get_active(session)
    else:
        target = next(
            (a for a in allocations_repo.list_allocations(session) if a.id == target_id), None
        )
    if target is None:
        raise RebalanceInputError("No target allocation found - save and activate one first")
    sell = bool(target.allow_sell) if allow_sell is None else allow_sell
    if amount < ZERO or (amount == ZERO and not sell):
        raise RebalanceInputError(
            "Enter a positive cash amount (or allow selling to rebalance only)"
        )
    data = build_calculator_data(session)
    fx = data.fx_rate_usd_per_eur
    if ccy != "EUR" and (fx is None or fx <= ZERO):
        raise RebalanceInputError("FX rate unavailable")
    raw = {i.instrument_id: Decimal(i.weight_pct) for i in target.items if i.weight_pct > ZERO}
    no_buy = {i.instrument_id for i in target.items if i.no_buy}
    target_pct = scale_to_100(raw)
    if not target_pct:
        raise RebalanceInputError("The target has no positive weights")
    cash_eur = amount if ccy == "EUR" else amount / fx  # type: ignore[operator]
    try:
        plan = compute_plan(
            data,
            target_pct,
            cash_eur=cash_eur,
            no_buy=no_buy,
            extra_no_buy=set(),
            category_of=None,
            allow_fractional=allow_fractional,
            allow_sell=sell,
        )
    except ValueError as exc:
        raise RebalanceInputError(str(exc)) from exc
    by_id = data.by_id()
    rows = [
        PlanRow(
            instrument_id=r.instrument_id,
            symbol=by_id[r.instrument_id].symbol if r.instrument_id in by_id else "",
            name=by_id[r.instrument_id].name if r.instrument_id in by_id else "",
            target_pct=r.target_pct,
            current_value=_in_ccy(r.current_value, ccy, fx),
            add_value=_in_ccy(r.add_value, ccy, fx),
            current_price=_in_ccy(r.current_price, ccy, fx),
            add_shares=r.add_shares,
            no_buy=r.no_buy,
        )
        for r in plan.rows
    ]
    return TargetPlan(
        ccy=ccy,
        target_id=target.id,
        target_name=target.name,
        cash_to_invest=_in_ccy(plan.cash_to_invest, ccy, fx),
        residual_cash=_in_ccy(plan.residual_cash, ccy, fx),
        allow_sell=sell,
        allow_fractional=allow_fractional,
        fx_eur_usd=fx,
        rows=rows,
    )


def plan_to_dict(plan: TargetPlan) -> dict[str, object]:
    """JSON-ready dict (decimals as strings)."""
    return {
        "ccy": plan.ccy,
        "target_id": plan.target_id,
        "target_name": plan.target_name,
        "cash_to_invest": dec(plan.cash_to_invest),
        "residual_cash": dec(plan.residual_cash),
        "allow_sell": plan.allow_sell,
        "allow_fractional": plan.allow_fractional,
        "fx_eur_usd": dec(plan.fx_eur_usd),
        "rows": [
            {
                "instrument_id": r.instrument_id,
                "symbol": r.symbol,
                "name": r.name,
                "target_pct": dec(r.target_pct),
                "current_value": dec(r.current_value),
                "add_value": dec(r.add_value),
                "current_price": dec(r.current_price),
                "add_shares": dec(r.add_shares),
                "no_buy": r.no_buy,
            }
            for r in plan.rows
        ],
    }
