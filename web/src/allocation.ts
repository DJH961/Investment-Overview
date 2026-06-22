/**
 * Target-allocation rebalancing math — a faithful TypeScript port of the
 * desktop's `domain/allocation.py` (spec §6.8).
 *
 * Given a pot of cash, a target weight per instrument, and the current value of
 * each holding, produce a buy plan that drives the portfolio toward the target
 * *without* selling anything (the default), or a full rebalance that may sell
 * over-weight funds when `allowSell` is on.
 *
 * All math runs in `Decimal`. Currency mixing is the caller's responsibility —
 * feed values already converted to a single currency (EUR is this app's pivot).
 * The web keys instruments by their `symbol` (the holdings' stable key on the
 * device) where the desktop keys by `instrument_id`; the algorithms are
 * otherwise identical.
 */

import { Decimal } from "./decimal-config";

const HUNDRED = new Decimal(100);
const ZERO = new Decimal(0);

/**
 * How a category-level weight is divided across the funds the user picked for
 * that category. `"value"` mirrors the current portfolio (split proportional to
 * each fund's current value); `"equal"` gives every picked fund the same share.
 * `"value"` falls back to `"equal"` when the picked funds have no value yet (a
 * brand-new category), so a target is never silently dropped.
 */
export type CategorySplit = "value" | "equal";

/** `{symbol: currentValue}` → `{symbol: weightPct}` summing to 100 (or zeros). */
export function currentWeightsPct(values: Map<string, Decimal>): Map<string, Decimal> {
  let total = ZERO;
  for (const v of values.values()) total = total.plus(v);
  const out = new Map<string, Decimal>();
  if (total.lessThanOrEqualTo(0)) {
    for (const k of values.keys()) out.set(k, ZERO);
    return out;
  }
  for (const [k, v] of values) out.set(k, v.times(HUNDRED).dividedBy(total));
  return out;
}

/** Fractional share (summing to 1) of a category's weight per member fund. */
function categoryMemberShares(
  members: readonly string[],
  currentValues: Map<string, Decimal>,
  split: CategorySplit,
): Map<string, Decimal> {
  const count = members.length;
  if (split === "value") {
    let total = ZERO;
    for (const m of members) total = total.plus(currentValues.get(m) ?? ZERO);
    if (total.greaterThan(0)) {
      const out = new Map<string, Decimal>();
      for (const m of members) out.set(m, (currentValues.get(m) ?? ZERO).dividedBy(total));
      return out;
    }
  }
  const even = new Decimal(1).dividedBy(new Decimal(count));
  const out = new Map<string, Decimal>();
  for (const m of members) out.set(m, even);
  return out;
}

/**
 * Expand category-level target weights into per-instrument weights, letting the
 * user think in categories ("10 % International") and have the funds inside each
 * category share that slice automatically. Throws when a category carries a
 * positive weight but no members were selected (its slice would vanish).
 */
export function expandCategoryWeights(
  categoryWeightsPct: Map<string, Decimal>,
  selectedByCategory: Map<string, readonly string[]>,
  currentValues: Map<string, Decimal>,
  split: CategorySplit = "value",
): Map<string, Decimal> {
  const out = new Map<string, Decimal>();
  for (const [category, weight] of categoryWeightsPct) {
    if (weight.lessThanOrEqualTo(0)) continue;
    const members = selectedByCategory.get(category) ?? [];
    if (members.length === 0) {
      throw new Error(`Category ${category} has a ${weight} % target but no funds selected`);
    }
    const shares = categoryMemberShares(members, currentValues, split);
    for (const [symbol, share] of shares) {
      out.set(symbol, (out.get(symbol) ?? ZERO).plus(weight.times(share)));
    }
  }
  return out;
}

/** One row of the rebalance plan. `addValue`/`addShares` are signed: positive =
 * buy, negative = sell (only possible with `allowSell`). */
export interface RebalanceRow {
  symbol: string;
  targetPct: Decimal;
  currentValue: Decimal;
  addValue: Decimal;
  currentPrice: Decimal | null;
  addShares: Decimal;
  noBuy: boolean;
}

export interface RebalancePlan {
  rows: RebalanceRow[];
  cashToInvest: Decimal;
  residualCash: Decimal;
}

/** Cash shortfall per buyable fund, optionally measured per category.
 *
 * When `categoryOf` is given, the shortfall is measured at the *category* level:
 * a category's whole current value — including funds the user holds but does not
 * actively buy (`noBuy`) — counts toward its target, so an already well-funded
 * category asks for no fresh cash even when an individual buyable fund inside it
 * still looks under-weight. The category's shortfall is then shared across just
 * its buyable funds, in proportion to their target value, so the funds the user
 * *does* buy pick up the whole category slack. Without `categoryOf` each fund is
 * its own bucket (the original per-fund gap).
 */
function buyOnlyGaps(
  symbols: readonly string[],
  targetValue: Map<string, Decimal>,
  current: Map<string, Decimal>,
  noBuy: Set<string>,
  categoryOf?: Map<string, string>,
): Map<string, Decimal> {
  const buyable = symbols.filter((s) => !noBuy.has(s));
  const gap = new Map<string, Decimal>();
  if (!categoryOf) {
    for (const s of buyable) gap.set(s, Decimal.max(ZERO, targetValue.get(s)!.minus(current.get(s)!)));
    return gap;
  }

  // Group every symbol by its category; symbols without a category form a
  // singleton bucket keyed on themselves so they keep per-fund behaviour.
  const membersByCat = new Map<string, string[]>();
  for (const s of symbols) {
    const key = categoryOf.get(s) || `__fund__:${s}`;
    const members = membersByCat.get(key);
    if (members) members.push(s);
    else membersByCat.set(key, [s]);
  }

  for (const s of buyable) gap.set(s, ZERO);
  for (const members of membersByCat.values()) {
    const catBuyable = members.filter((m) => !noBuy.has(m));
    if (catBuyable.length === 0) continue;
    let catTarget = ZERO;
    let catCurrent = ZERO;
    for (const m of members) {
      catTarget = catTarget.plus(targetValue.get(m)!);
      catCurrent = catCurrent.plus(current.get(m)!);
    }
    const catGap = Decimal.max(ZERO, catTarget.minus(catCurrent));
    if (catGap.lessThanOrEqualTo(0)) continue;
    let weightTotal = ZERO;
    for (const m of catBuyable) weightTotal = weightTotal.plus(targetValue.get(m)!);
    for (const m of catBuyable) {
      const share = weightTotal.greaterThan(0)
        ? targetValue.get(m)!.dividedBy(weightTotal)
        : new Decimal(1).dividedBy(new Decimal(catBuyable.length));
      gap.set(m, catGap.times(share));
    }
  }
  return gap;
}

/** Buy-only distribution: never sells, and never buys a `noBuy` fund. */
function planBuyOnly(
  symbols: readonly string[],
  targetValue: Map<string, Decimal>,
  current: Map<string, Decimal>,
  noBuy: Set<string>,
  cashToInvest: Decimal,
  targetWeightsPct: Map<string, Decimal>,
  categoryOf?: Map<string, string>,
): Map<string, Decimal> {
  const buyable = symbols.filter((s) => !noBuy.has(s));
  const gap = buyOnlyGaps(symbols, targetValue, current, noBuy, categoryOf);
  let gapTotal = ZERO;
  for (const g of gap.values()) gapTotal = gapTotal.plus(g);
  const add = new Map<string, Decimal>();
  for (const s of symbols) add.set(s, ZERO);

  if (gapTotal.greaterThan(cashToInvest) && gapTotal.greaterThan(0)) {
    for (const s of buyable) add.set(s, gap.get(s)!.times(cashToInvest).dividedBy(gapTotal));
  } else if (gapTotal.lessThan(cashToInvest)) {
    const remainder = cashToInvest.minus(gapTotal);
    let buyableWeight = ZERO;
    for (const s of buyable) buyableWeight = buyableWeight.plus(targetWeightsPct.get(s)!);
    for (const s of buyable) {
      let share: Decimal;
      if (buyableWeight.greaterThan(0)) {
        share = targetWeightsPct.get(s)!.dividedBy(buyableWeight);
      } else if (buyable.length > 0) {
        share = new Decimal(1).dividedBy(new Decimal(buyable.length));
      } else {
        share = ZERO;
      }
      add.set(s, gap.get(s)!.plus(remainder.times(share)));
    }
  } else {
    for (const s of buyable) add.set(s, gap.get(s)!);
  }
  return add;
}

/** Full rebalance distribution: drive every fund to its target value. */
function planWithSells(
  symbols: readonly string[],
  targetValue: Map<string, Decimal>,
  current: Map<string, Decimal>,
  noBuy: Set<string>,
): Map<string, Decimal> {
  const add = new Map<string, Decimal>();
  for (const s of symbols) {
    const delta = targetValue.get(s)!.minus(current.get(s)!);
    add.set(s, noBuy.has(s) && delta.greaterThan(0) ? ZERO : delta);
  }
  return add;
}

export interface PlanRebalanceOptions {
  currentPrices?: Map<string, Decimal>;
  allowFractionalShares?: boolean;
  fractionalDecimals?: number;
  allowSell?: boolean;
  noBuyIds?: Set<string>;
  /** Optional `{symbol: category}` grouping; enables per-category buy-only
   * gaps so held-but-unbought funds count toward their category's funding.
   * Ignored when `allowSell` is true. */
  categoryOf?: Map<string, string>;
}

/**
 * Compute a rebalance plan (buy-only by default). Throws when `cashToInvest` is
 * negative or the target weights do not sum to ~100. Mirrors `plan_rebalance`.
 */
export function planRebalance(
  cashToInvest: Decimal,
  targetWeightsPct: Map<string, Decimal>,
  currentValues: Map<string, Decimal>,
  options: PlanRebalanceOptions = {},
): RebalancePlan {
  const {
    currentPrices,
    allowFractionalShares = false,
    fractionalDecimals = 4,
    allowSell = false,
    noBuyIds,
    categoryOf,
  } = options;

  if (cashToInvest.lessThan(0)) {
    throw new Error(`cashToInvest must be non-negative, got ${cashToInvest}`);
  }
  let weightSum = ZERO;
  for (const w of targetWeightsPct.values()) weightSum = weightSum.plus(w);
  if (weightSum.minus(HUNDRED).abs().greaterThan(new Decimal("0.01"))) {
    throw new Error(`Target weights must sum to 100, got ${weightSum}`);
  }

  const noBuy = new Set(noBuyIds ?? []);
  const symbols = [...targetWeightsPct.keys()];
  const current = new Map<string, Decimal>();
  let currentTotal = ZERO;
  for (const s of symbols) {
    const v = currentValues.get(s) ?? ZERO;
    current.set(s, v);
    currentTotal = currentTotal.plus(v);
  }
  const totalAfter = currentTotal.plus(cashToInvest);
  const targetValue = new Map<string, Decimal>();
  for (const s of symbols) {
    targetValue.set(s, totalAfter.times(targetWeightsPct.get(s)!).dividedBy(HUNDRED));
  }

  const add = allowSell
    ? planWithSells(symbols, targetValue, current, noBuy)
    : planBuyOnly(symbols, targetValue, current, noBuy, cashToInvest, targetWeightsPct, categoryOf);

  const rows: RebalanceRow[] = [];
  let allocatedTotal = ZERO;
  for (const s of symbols) {
    const price = currentPrices?.get(s) ?? null;
    let shares: Decimal;
    if (price === null || price.lessThanOrEqualTo(0)) {
      shares = ZERO;
    } else if (allowFractionalShares) {
      // Quantize with the global rounding (ROUND_HALF_EVEN), matching the
      // desktop's `(add / price).quantize(...)`.
      shares = add.get(s)!.dividedBy(price).toDecimalPlaces(fractionalDecimals);
    } else {
      // Truncate toward zero so we never over-buy/over-sell a whole-share order.
      shares = add.get(s)!.dividedBy(price).toDecimalPlaces(0, Decimal.ROUND_DOWN);
    }
    const actualAdd = price !== null ? shares.times(price) : add.get(s)!;
    const addValue =
      price === null || allowFractionalShares ? add.get(s)! : actualAdd;
    rows.push({
      symbol: s,
      targetPct: targetWeightsPct.get(s)!,
      currentValue: current.get(s)!,
      addValue,
      currentPrice: price,
      addShares: shares,
      noBuy: noBuy.has(s),
    });
    allocatedTotal = allocatedTotal.plus(addValue);
  }

  let residual = cashToInvest.minus(allocatedTotal);
  if (residual.lessThan(0)) residual = ZERO;
  return { rows, cashToInvest, residualCash: residual };
}

/** Normalise positive weights so they sum to exactly 100. */
export function scaleTo100(weights: Map<string, Decimal>): Map<string, Decimal> {
  let total = ZERO;
  for (const w of weights.values()) if (w.greaterThan(0)) total = total.plus(w);
  const out = new Map<string, Decimal>();
  if (total.lessThanOrEqualTo(0)) return out;
  for (const [k, w] of weights) {
    if (w.greaterThan(0)) out.set(k, w.times(HUNDRED).dividedBy(total));
  }
  return out;
}

/** Round weights to one decimal and absorb the residual into the largest. */
export function roundTo100(weights: Map<string, Decimal>): Map<string, Decimal> {
  const rounded = new Map<string, Decimal>();
  for (const [k, w] of weights) {
    if (w.greaterThan(0)) rounded.set(k, w.toDecimalPlaces(1));
  }
  if (rounded.size === 0) return rounded;
  let sum = ZERO;
  for (const w of rounded.values()) sum = sum.plus(w);
  const residual = HUNDRED.minus(sum);
  if (!residual.isZero()) {
    let biggest: string | null = null;
    for (const [k, w] of rounded) {
      if (biggest === null || w.greaterThan(rounded.get(biggest)!)) biggest = k;
    }
    if (biggest !== null) rounded.set(biggest, rounded.get(biggest)!.plus(residual));
  }
  return rounded;
}
