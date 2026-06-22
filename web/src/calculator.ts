/**
 * Calculator data assembly for the web companion.
 *
 * Mirrors the desktop's `_calculator_query.build_calculator_data`: it turns the
 * live per-holding views into the per-instrument and per-category facts the
 * in-page allocation builder needs — current EUR value, current weight,
 * category, and an EUR-denominated price for share math — grouped by category so
 * the user can think in categories ("10 % International") and let the funds
 * inside share that slice automatically.
 *
 * The web keys everything by `symbol` (the holdings' stable on-device key); the
 * desktop keys by `instrument_id`. Multiple holding rows can share a symbol
 * (same fund across accounts/brokers); they are aggregated here into one
 * investable instrument, exactly as the desktop aggregates positions.
 */

import { Decimal } from "./decimal-config";
import type { HoldingView } from "./compute";
import { currentWeightsPct } from "./allocation";
import type { ExportTargetAllocation } from "./types";

const ZERO = new Decimal(0);

export const UNCATEGORIZED = "Uncategorized";

/** One investable instrument with the facts the calculator needs. */
export interface CalcInstrument {
  symbol: string;
  name: string;
  category: string;
  currentValueEur: Decimal;
  currentPct: Decimal;
  /** EUR price per share for share-count math, or null when no price is known. */
  priceEur: Decimal | null;
}

/** A category bucket grouping its member instruments. */
export interface CalcCategory {
  name: string;
  currentValueEur: Decimal;
  currentPct: Decimal;
  members: CalcInstrument[];
}

/** A saved Calculator target, mapped from the export blob. */
export interface SavedTarget {
  name: string;
  active: boolean;
  allowSell: boolean;
  displayCurrency: string | null;
  items: { symbol: string; weightPct: Decimal; noBuy: boolean }[];
}

/** Everything the calculator panel needs to render its allocation builder. */
export interface CalcData {
  instruments: CalcInstrument[];
  categories: CalcCategory[];
  totalValueEur: Decimal;
  savedTargets: SavedTarget[];
}

/** Resolve the grouping label exactly like the desktop: category → asset_class
 * → "Uncategorized". */
function categoryLabel(category: string | null, assetClass: string): string {
  return category || assetClass || UNCATEGORIZED;
}

interface Aggregate {
  symbol: string;
  name: string;
  category: string;
  valueEur: Decimal;
  shares: Decimal;
}

/** Aggregate per-holding rows into one record per symbol (fund). */
function aggregateBySymbol(holdings: readonly HoldingView[]): Map<string, Aggregate> {
  const bySymbol = new Map<string, Aggregate>();
  for (const h of holdings) {
    const value = h.valueEur ?? ZERO;
    const existing = bySymbol.get(h.symbol);
    if (existing) {
      existing.valueEur = existing.valueEur.plus(value);
      existing.shares = existing.shares.plus(h.shares);
      // Keep the first non-null category we see for this symbol.
      if (existing.category === UNCATEGORIZED) {
        existing.category = categoryLabel(h.category, h.assetClass);
      }
    } else {
      bySymbol.set(h.symbol, {
        symbol: h.symbol,
        name: h.name,
        category: categoryLabel(h.category, h.assetClass),
        valueEur: value,
        shares: h.shares,
      });
    }
  }
  return bySymbol;
}

function mapSavedTargets(allocations: readonly ExportTargetAllocation[] = []): SavedTarget[] {
  return allocations.map((a) => ({
    name: a.name,
    active: a.active,
    allowSell: a.allow_sell,
    displayCurrency: a.display_currency,
    items: a.items.map((item) => ({
      symbol: item.symbol,
      weightPct: new Decimal(item.weight_pct),
      noBuy: item.no_buy,
    })),
  }));
}

/**
 * Build the calculator's per-instrument / per-category data set from the live
 * holding views and the saved targets carried in the export blob.
 */
export function buildCalculatorData(
  holdings: readonly HoldingView[],
  savedAllocations: readonly ExportTargetAllocation[] = [],
): CalcData {
  const aggregates = [...aggregateBySymbol(holdings).values()];

  const valueBySymbol = new Map<string, Decimal>();
  for (const a of aggregates) valueBySymbol.set(a.symbol, a.valueEur);
  const pctBySymbol = currentWeightsPct(valueBySymbol);

  const instruments: CalcInstrument[] = aggregates.map((a) => ({
    symbol: a.symbol,
    name: a.name,
    category: a.category,
    currentValueEur: a.valueEur,
    currentPct: pctBySymbol.get(a.symbol) ?? ZERO,
    // Derive an EUR per-share price from the (already FX-converted) EUR value;
    // null when there are no shares or no value to price from.
    priceEur:
      a.shares.greaterThan(0) && a.valueEur.greaterThan(0)
        ? a.valueEur.dividedBy(a.shares)
        : null,
  }));

  // Group into categories, preserving first-seen order, then sort heaviest-first
  // so the builder leads with what matters (mirrors the desktop).
  const order: string[] = [];
  const byCategory = new Map<string, CalcInstrument[]>();
  for (const ci of instruments) {
    let members = byCategory.get(ci.category);
    if (!members) {
      members = [];
      byCategory.set(ci.category, members);
      order.push(ci.category);
    }
    members.push(ci);
  }

  let totalValueEur = ZERO;
  for (const ci of instruments) totalValueEur = totalValueEur.plus(ci.currentValueEur);

  const categories: CalcCategory[] = order.map((name) => {
    const members = byCategory.get(name)!;
    let catValue = ZERO;
    for (const m of members) catValue = catValue.plus(m.currentValueEur);
    const catPct = totalValueEur.greaterThan(0)
      ? catValue.times(100).dividedBy(totalValueEur)
      : ZERO;
    return { name, currentValueEur: catValue, currentPct: catPct, members };
  });
  categories.sort((a, b) => b.currentValueEur.comparedTo(a.currentValueEur));

  return {
    instruments,
    categories,
    totalValueEur,
    savedTargets: mapSavedTargets(savedAllocations),
  };
}
