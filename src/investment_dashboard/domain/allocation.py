"""Target-allocation rebalancing math (spec §6.8).

Given a pot of cash, a target weight per instrument, and the current EUR
value of each holding, produce a buy plan that drives the portfolio toward
the target *without* selling anything (the v1 default).

All math is in :class:`decimal.Decimal`. Currency mixing is the caller's
responsibility — feed values already converted to a single currency (EUR
is the natural choice for this app).
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal

HUNDRED = Decimal(100)
ZERO = Decimal(0)

#: How a category-level weight is divided across the funds the user picked for
#: that category. ``"value"`` mirrors the current portfolio (split proportional
#: to each fund's current value); ``"equal"`` gives every picked fund the same
#: share. ``"value"`` falls back to ``"equal"`` when the picked funds have no
#: value yet (a brand-new category), so a target is never silently dropped.
CategorySplit = str


def current_weights_pct(values: Mapping[int, Decimal]) -> dict[int, Decimal]:
    """Return each instrument's share of the total as a percentage.

    ``{instrument_id: current_value}`` → ``{instrument_id: weight_pct}`` summing
    to 100 (or all zeros when the total is zero). Used by the calculator to show
    "how much percent each holding currently has" next to the target inputs.
    """
    total = sum((v for v in values.values()), start=ZERO)
    if total <= ZERO:
        return {i: ZERO for i in values}
    return {i: v * HUNDRED / total for i, v in values.items()}


def expand_category_weights(
    category_weights_pct: Mapping[str, Decimal],
    selected_by_category: Mapping[str, Sequence[int]],
    current_values: Mapping[int, Decimal],
    *,
    split: CategorySplit = "value",
) -> dict[int, Decimal]:
    """Expand category-level target weights into per-instrument weights.

    Lets the user think in categories ("10 % International") and have the funds
    inside each category share that slice automatically.

    Parameters
    ----------
    category_weights_pct
        ``{category: weight_pct}`` — the target for each category. Values should
        sum to 100, but this function does not enforce it (the caller validates,
        so the live total can be shown while still being edited); the returned
        per-instrument weights always sum to the same total as the input.
    selected_by_category
        ``{category: [instrument_id, ...]}`` — which funds the user picked to
        actively invest in for each category.
    current_values
        ``{instrument_id: current_value}`` — used to split a category's weight
        proportionally when ``split == "value"``.
    split
        ``"value"`` (default) splits a category's weight across its picked funds
        in proportion to their current value, falling back to an equal split
        when those funds have no value yet. ``"equal"`` always splits evenly.

    Returns
    -------
    dict[int, Decimal]
        ``{instrument_id: weight_pct}``. An instrument that appears under more
        than one category accumulates the weight from each.

    Raises
    ------
    ValueError
        If a category carries a positive weight but no funds were picked for it
        (its slice would otherwise vanish).
    """
    out: dict[int, Decimal] = {}
    for category, weight in category_weights_pct.items():
        if weight <= ZERO:
            continue
        members = list(selected_by_category.get(category, ()))
        if not members:
            raise ValueError(
                f"Category {category!r} has a {weight} % target but no funds selected",
            )
        shares = _category_member_shares(members, current_values, split=split)
        for instrument_id, share in shares.items():
            out[instrument_id] = out.get(instrument_id, ZERO) + weight * share
    return out


def _category_member_shares(
    members: Sequence[int],
    current_values: Mapping[int, Decimal],
    *,
    split: CategorySplit,
) -> dict[int, Decimal]:
    """Fractional share (summing to 1) of a category's weight per member fund."""
    count = len(members)
    if split == "value":
        total = sum((current_values.get(i, ZERO) for i in members), start=ZERO)
        if total > ZERO:
            return {i: current_values.get(i, ZERO) / total for i in members}
    even = Decimal(1) / Decimal(count)
    return {i: even for i in members}


@dataclass(frozen=True)
class RebalanceRow:
    """One row of the rebalance plan."""

    instrument_id: int
    target_pct: Decimal
    current_value: Decimal
    add_value: Decimal
    current_price: Decimal | None
    add_shares: Decimal


@dataclass(frozen=True)
class RebalancePlan:
    """Output of :func:`plan_rebalance`."""

    rows: list[RebalanceRow]
    cash_to_invest: Decimal
    residual_cash: Decimal


def plan_rebalance(
    cash_to_invest: Decimal,
    target_weights_pct: Mapping[int, Decimal],
    current_values: Mapping[int, Decimal],
    current_prices: Mapping[int, Decimal] | None = None,
    *,
    allow_fractional_shares: bool = False,
    fractional_decimals: int = 4,
) -> RebalancePlan:
    """Compute a buy-only rebalance plan.

    Parameters
    ----------
    cash_to_invest
        Amount of new cash to allocate (must be ≥ 0).
    target_weights_pct
        ``{instrument_id: weight_pct}`` summing to 100.
    current_values
        Current market value per instrument (same currency as
        ``cash_to_invest``). Instruments absent here are treated as zero.
    current_prices
        Optional ``{instrument_id: price_per_share}`` for share-count math.
        If omitted, ``add_shares`` is set to 0 for every row.
    allow_fractional_shares
        If False (default), share counts are floored. If True, rounded to
        ``fractional_decimals`` places.

    Raises
    ------
    ValueError
        If ``cash_to_invest < 0`` or the target weights do not sum to ~100.
    """
    if cash_to_invest < 0:
        raise ValueError(f"cash_to_invest must be non-negative, got {cash_to_invest}")
    weight_sum = sum(target_weights_pct.values(), start=ZERO)
    if abs(weight_sum - HUNDRED) > Decimal("0.01"):
        raise ValueError(f"Target weights must sum to 100, got {weight_sum}")

    instrument_ids = list(target_weights_pct.keys())
    current = {i: current_values.get(i, ZERO) for i in instrument_ids}
    current_total = sum(current.values(), start=ZERO)
    total_after = current_total + cash_to_invest

    # Gap to target — never negative (no selling).
    target_value = {i: total_after * target_weights_pct[i] / HUNDRED for i in instrument_ids}
    gap = {i: max(ZERO, target_value[i] - current[i]) for i in instrument_ids}
    gap_total = sum(gap.values(), start=ZERO)

    if gap_total > cash_to_invest and gap_total > 0:
        # Scale gaps down proportionally so they sum to exactly cash_to_invest.
        add = {i: gap[i] * cash_to_invest / gap_total for i in instrument_ids}
    elif gap_total < cash_to_invest:
        # Remaining cash goes to all instruments in proportion to target weight.
        remainder = cash_to_invest - gap_total
        add = {i: gap[i] + remainder * target_weights_pct[i] / HUNDRED for i in instrument_ids}
    else:
        add = dict(gap)

    rows: list[RebalanceRow] = []
    allocated_total = ZERO
    for i in instrument_ids:
        price = current_prices.get(i) if current_prices else None
        if price is None or price <= 0:
            shares = ZERO
        elif allow_fractional_shares:
            quant = Decimal(10) ** -fractional_decimals
            shares = (add[i] / price).quantize(quant)
        else:
            shares = Decimal(math.floor(add[i] / price))
        actual_add = shares * price if price is not None else add[i]
        # For floored shares, "spent" is shares * price; the residual rolls
        # up to the plan-wide unallocated cash.
        rows.append(
            RebalanceRow(
                instrument_id=i,
                target_pct=target_weights_pct[i],
                current_value=current[i],
                add_value=add[i] if price is None or allow_fractional_shares else actual_add,
                current_price=price,
                add_shares=shares,
            )
        )
        allocated_total += rows[-1].add_value

    residual = cash_to_invest - allocated_total
    if residual < 0:
        residual = ZERO
    return RebalancePlan(rows=rows, cash_to_invest=cash_to_invest, residual_cash=residual)
