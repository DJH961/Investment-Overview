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
from dataclasses import dataclass, replace
from decimal import Decimal

from sqlalchemy.orm import Session

from investment_dashboard.domain.allocation import (
    RebalancePlan,
    expand_category_weights,
    plan_rebalance,
)
from investment_dashboard.errors import ValidationError
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


class RebalanceInputError(ValidationError):
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


def held_unticked_kept(
    target_pct: dict[int, Decimal],
    current_values: Mapping[int, Decimal],
    *,
    cash_eur: Decimal,
    cat_targets: Mapping[str, Decimal],
    cat_selected: Mapping[str, set[int]],
    cat_members: Mapping[str, list[int]],
    category_by_id: Mapping[int, str],
) -> tuple[dict[int, Decimal], set[int]]:
    """Keep held-but-un-ticked funds in a *rebalancing* category plan.

    Without this, a rebalance planned only over the ticked funds: the un-ticked
    holdings (say a mutual fund kept but no longer bought) vanished from the
    plan, so every target was measured against part of the portfolio and the
    plan over-bought the ticked funds and over-sold the other categories.

    Here an un-ticked held fund of a targeted category is *kept as it is*
    (never bought, never sold) and its value counts toward its category, like
    the buy-only credit. The ticked funds share what is left of the category's
    target (never below zero), and every weight is restated as a share of the
    whole plan total (current value of every row + the cash), summing to 100.
    Returns ``(new target_pct, kept ids)``; unchanged when nothing is kept.
    """
    kept: set[int] = set()
    for name, weight in cat_targets.items():
        if weight <= ZERO:
            continue
        selected = cat_selected.get(name, set())
        for mid in cat_members.get(name, []):
            if mid in selected or mid in target_pct:
                continue
            if current_values.get(mid, ZERO) > ZERO:
                kept.add(mid)
    if not kept:
        return target_pct, kept
    ids = [*target_pct, *sorted(kept)]
    total_after = sum((current_values.get(i, ZERO) for i in ids), start=ZERO) + cash_eur
    if total_after <= ZERO:
        return target_pct, set()
    cat_weight = {name: w for name, w in cat_targets.items() if w > ZERO}
    weight_sum = sum(cat_weight.values(), start=ZERO)
    kept_by_cat: dict[str, Decimal] = {}
    for mid in kept:
        cat = category_by_id.get(mid, UNCATEGORIZED)
        kept_by_cat[cat] = kept_by_cat.get(cat, ZERO) + current_values.get(mid, ZERO)
    # Each ticked fund's share of its category's ticked weight.
    ticked_by_cat: dict[str, Decimal] = {}
    for mid, w in target_pct.items():
        cat = category_by_id.get(mid, UNCATEGORIZED)
        ticked_by_cat[cat] = ticked_by_cat.get(cat, ZERO) + w
    value: dict[int, Decimal] = {}
    for mid, w in target_pct.items():
        cat = category_by_id.get(mid, UNCATEGORIZED)
        cat_value = total_after * cat_weight.get(cat, ZERO) / weight_sum if weight_sum else ZERO
        room = max(ZERO, cat_value - kept_by_cat.get(cat, ZERO))
        share = w / ticked_by_cat[cat] if ticked_by_cat.get(cat) else ZERO
        value[mid] = room * share
    kept_total = sum((current_values.get(i, ZERO) for i in kept), start=ZERO)
    ticked_total = sum(value.values(), start=ZERO)
    # A kept fund larger than its category's target leaves less for the rest:
    # scale the ticked targets so the plan still adds up to the whole.
    budget = total_after - kept_total
    factor = budget / ticked_total if ticked_total > ZERO else ZERO
    out = {mid: v * factor * HUNDRED / total_after for mid, v in value.items()}
    out.update({mid: current_values.get(mid, ZERO) * HUNDRED / total_after for mid in kept})
    return out, kept


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
    current_values: Mapping[int, Decimal] | None = None,
) -> RebalancePlan:
    """Run :func:`plan_rebalance` against the calculator data (EUR basis).

    ``current_values`` overrides the marks (used when held cash is being invested).
    """
    by_id = data.by_id()
    if current_values is None:
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
                "target_pct": dec(r.target_pct / HUNDRED),
                "current_value": dec(r.current_value),
                "add_value": dec(r.add_value),
                "current_price": dec(r.current_price),
                "add_shares": dec(r.add_shares),
                "no_buy": r.no_buy,
            }
            for r in plan.rows
        ],
    }


# -- v6 API: plan for an unsaved builder mix (``POST /allocations/plan``) -----


@dataclass(frozen=True)
class CategoryInput:
    """One category row of the builder: its target, split rule and ticked funds."""

    name: str
    weight: Decimal
    split: str = "value"
    selected: tuple[int, ...] = ()


def _ccy_out(value_eur: Decimal | None, ccy: str, fx: Decimal | None) -> str | None:
    return dec(_in_ccy(value_eur, ccy, fx))


def _pct(part: Decimal, whole: Decimal) -> Decimal:
    return part / whole if whole > ZERO else ZERO


def _shape_rows(
    plan: RebalancePlan,
    data: CalcData,
    *,
    ccy: str,
    extra_no_buy: set[int],
    cat_order: Mapping[str, Decimal] | None,
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    """Plan rows (with before/after shares) and their per-category subtotals."""
    fx = data.fx_rate_usd_per_eur
    by_id = data.by_id()
    category_by_id = {i.instrument_id: i.category for i in data.instruments}
    total_after = sum((r.current_value + r.add_value for r in plan.rows), start=ZERO)
    rows: list[dict[str, object]] = []
    groups: dict[str, dict[str, Decimal]] = {}
    order: list[str] = []
    for r in sorted(plan.rows, key=lambda row: row.add_value, reverse=True):
        instr = by_id.get(r.instrument_id)
        category = category_by_id.get(r.instrument_id, UNCATEGORIZED)
        after = r.current_value + r.add_value
        rows.append(
            {
                "instrument_id": r.instrument_id,
                "symbol": instr.symbol if instr else str(r.instrument_id),
                "name": instr.name if instr else "",
                "category": category,
                "target_pct": dec(r.target_pct / HUNDRED),
                "current_pct": dec(instr.current_pct / HUNDRED if instr else ZERO),
                "before_pct": dec(_pct(r.current_value, total_after)),
                "after_pct": dec(_pct(after, total_after)),
                "current_value": _ccy_out(r.current_value, ccy, fx),
                "add_value": _ccy_out(r.add_value, ccy, fx),
                "current_price": _ccy_out(r.current_price, ccy, fx),
                "add_shares": dec(r.add_shares),
                "no_buy": r.no_buy,
                "held_unticked": r.instrument_id in extra_no_buy,
            }
        )
        g = groups.get(category)
        if g is None:
            order.append(category)
            g = groups[category] = {"target": ZERO, "add": ZERO, "before": ZERO, "after": ZERO}
        g["target"] += r.target_pct
        g["add"] += r.add_value
        g["before"] += r.current_value
        g["after"] += after
    if cat_order is not None:
        order.sort(key=lambda n: cat_order.get(n, ZERO), reverse=True)
    cat_pct_now = {c.name: c.current_pct for c in data.categories}
    category_rows: list[dict[str, object]] = [
        {
            "name": name,
            "target_pct": dec(groups[name]["target"] / HUNDRED),
            "current_pct": dec(cat_pct_now.get(name, ZERO) / HUNDRED),
            "before_pct": dec(_pct(groups[name]["before"], total_after)),
            "after_pct": dec(_pct(groups[name]["after"], total_after)),
            "add_value": _ccy_out(groups[name]["add"], ccy, fx),
        }
        for name in order
    ]

    return rows, category_rows


def _spend_held_cash(data: CalcData, cash_eur: Decimal) -> tuple[dict[int, Decimal], Decimal]:
    """Marks with ``cash_eur`` taken out of the cash holdings, and the amount taken.

    Investing cash you already hold is a move out of the Cash group, not new money:
    the cash positions fall by what is invested (pro rata, never below zero) so a
    targeted Cash row is not counted twice. Returns ``(values, taken)``.
    """
    values = {i.instrument_id: i.current_value_eur for i in data.instruments}
    held = data.cash_eur
    taken = min(cash_eur, held) if held > ZERO else ZERO
    if taken > ZERO:
        for i in data.instruments:
            if i.is_cash and i.current_value_eur > ZERO:
                values[i.instrument_id] = i.current_value_eur * (held - taken) / held
    return values, taken


def _summary(
    plan: RebalancePlan,
    *,
    amount: Decimal,
    cash_eur: Decimal,
    ccy: str,
    data: CalcData,
    from_cash_eur: Decimal | None = None,
) -> dict[str, object]:
    """Plan KPIs in ``ccy`` and restated in the other currency at the same spot."""
    fx = data.fx_rate_usd_per_eur
    buys = sum((r.add_value for r in plan.rows if r.add_value > ZERO), start=ZERO)
    sells = sum((-r.add_value for r in plan.rows if r.add_value < ZERO), start=ZERO)
    other = "USD" if ccy == "EUR" else "EUR"
    wealth = data.total_value_eur
    return {
        "cash": dec(amount),
        "buying": _ccy_out(buys, ccy, fx),
        "selling": _ccy_out(sells, ccy, fx),
        "leftover": _ccy_out(plan.residual_cash, ccy, fx),
        "other_ccy": other,
        "other_cash": _ccy_out(cash_eur, other, fx),
        "other_buying": _ccy_out(buys, other, fx),
        "other_selling": _ccy_out(sells, other, fx),
        "other_leftover": _ccy_out(plan.residual_cash, other, fx),
        "pct_of_wealth": dec(cash_eur / wealth) if wealth > ZERO else None,
        "held_cash": _ccy_out(data.cash_eur, ccy, fx),
        "from_held_cash": _ccy_out(from_cash_eur, ccy, fx) if from_cash_eur is not None else None,
    }


def build_builder_plan(
    session: Session,
    *,
    amount: Decimal,
    ccy: str,
    allow_fractional: bool,
    allow_sell: bool,
    mode: str,
    fund_weights: Mapping[int, Decimal] | None = None,
    fund_no_buy: set[int] | None = None,
    categories: list[CategoryInput] | None = None,
    use_held_cash: bool = False,
) -> dict[str, object]:
    """Plan for the builder's current (unsaved) mix, by fund or by category.

    Plans in EUR like the desktop calculator; ``amount`` is in ``ccy`` and is
    converted in at the single spot rate, and every money figure is converted
    back out at that same rate (a single-instant valuation conversion). The
    summary also restates the figures in the other currency at that rate.
    Percentages are fractions (0.01 = 1 %). Raises :class:`RebalanceInputError`.

    ``use_held_cash``: the amount is funded from the cash the portfolio holds
    (money-market funds and cash positions). Those holdings drop by what is
    invested, so the money is moved, not counted twice.
    """
    if amount < ZERO or (amount == ZERO and not allow_sell):
        raise RebalanceInputError(
            "Enter a positive cash amount (or allow selling to rebalance only)"
        )
    data = build_calculator_data(session)
    fx = data.fx_rate_usd_per_eur
    if ccy != "EUR" and (fx is None or fx <= ZERO):
        raise RebalanceInputError("FX rate unavailable")
    by_id = data.by_id()
    current_values = {i.instrument_id: i.current_value_eur for i in data.instruments}
    cash_eur = amount if ccy == "EUR" else amount / fx  # type: ignore[operator]
    from_cash_eur: Decimal | None = None
    if use_held_cash:
        current_values, from_cash_eur = _spend_held_cash(data, cash_eur)
    category_by_id = {i.instrument_id: i.category for i in data.instruments}
    category_mode = mode == "category"
    no_buy: set[int] = set()
    cat_targets: dict[str, Decimal] = {}
    cat_selected: dict[str, set[int]] = {}
    cat_members: dict[str, list[int]] = {
        c.name: [m.instrument_id for m in c.members] for c in data.categories
    }
    if category_mode:
        cats = categories or []
        cat_targets = {c.name: c.weight for c in cats}
        cat_selected = {c.name: set(c.selected) for c in cats}
        raw = expand_category_targets(
            cat_targets,
            cat_members=cat_members,
            cat_selected=cat_selected,
            cat_split={c.name: c.split for c in cats},
            current_values=current_values,
        )
    else:
        raw = {i: w for i, w in (fund_weights or {}).items() if i in by_id}
        no_buy = set(fund_no_buy or set())
    if any(w < ZERO for w in raw.values()):
        raise RebalanceInputError("Weights must not be negative")
    target_pct = scale_to_100(raw)
    if not target_pct:
        raise RebalanceInputError("Set at least one positive target weight")
    extra_no_buy, category_of = held_unticked_extras(
        target_pct,
        current_values,
        category_mode=category_mode,
        allow_sell=allow_sell,
        cat_targets=cat_targets,
        cat_selected=cat_selected,
        cat_members=cat_members,
        category_by_id=category_by_id,
    )
    if category_mode and allow_sell:
        target_pct, extra_no_buy = held_unticked_kept(
            target_pct,
            current_values,
            cash_eur=cash_eur,
            cat_targets=cat_targets,
            cat_selected=cat_selected,
            cat_members=cat_members,
            category_by_id=category_by_id,
        )
    try:
        plan = compute_plan(
            data,
            target_pct,
            cash_eur=cash_eur,
            no_buy=no_buy,
            extra_no_buy=extra_no_buy,
            category_of=category_of,
            allow_fractional=allow_fractional,
            allow_sell=allow_sell,
            current_values=current_values,
        )
    except ValueError as exc:
        raise RebalanceInputError(str(exc)) from exc
    if category_mode and allow_sell and extra_no_buy:
        # Kept funds are held as they are: no rounding-dust trade on them.
        kept_rows = [
            replace(r, add_value=ZERO, add_shares=ZERO) if r.instrument_id in extra_no_buy else r
            for r in plan.rows
        ]
        spent = sum((r.add_value for r in kept_rows), start=ZERO)
        plan = replace(plan, rows=kept_rows, residual_cash=max(ZERO, cash_eur - spent))

    rows, category_rows = _shape_rows(
        plan,
        data,
        ccy=ccy,
        extra_no_buy=extra_no_buy,
        cat_order=cat_targets if category_mode else None,
    )
    summary = _summary(
        plan, amount=amount, cash_eur=cash_eur, ccy=ccy, data=data, from_cash_eur=from_cash_eur
    )
    extras = sorted(by_id[i].symbol for i in extra_no_buy if i in by_id)
    return {
        "ccy": ccy,
        "mode": "category" if category_mode else "fund",
        "allow_sell": allow_sell,
        "allow_fractional": allow_fractional,
        "fx_usd_per_eur": dec(fx),
        "summary": summary,
        "rows": rows,
        "categories": category_rows,
        "extras": extras,
    }
