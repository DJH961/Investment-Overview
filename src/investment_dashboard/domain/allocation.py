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
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal

HUNDRED = Decimal(100)
ZERO = Decimal(0)


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
