/**
 * Builder state helpers. Display-only arithmetic on typed weights (presets and
 * the live total); every plan figure comes from `POST /api/allocations/plan`.
 */
import { parseDecimal } from "../../lib/parseDecimal";
import type { TargetOut } from "../../lib/queries/allocations";

export type Mode = "fund" | "category";
export type Split = "value" | "even";
/** Typed weights in percent, keyed by instrument id or category name. */
export type Weights = Record<string, string>;

export interface Weighable {
  key: string;
  /** Current share as an API fraction string (0.01 = 1 %). */
  current_pct?: string | null;
}

const pctText = (n: number, digits: number) => String(Number(n.toFixed(digits)));

/** Live total of the typed weights (display only; the server normalises). */
export function totalWeight(rows: { weight: string }[] | Weights): number {
  const list = Array.isArray(rows) ? rows.map((r) => r.weight) : Object.values(rows);
  return list.reduce((a, w) => a + (parseDecimal(w) ?? 0), 0);
}

/** Typed but unreadable ('12x'): empty counts as 0, anything else must parse. */
export function isInvalidWeight(w: string | undefined): boolean {
  return w !== undefined && w.trim() !== "" && parseDecimal(w) === null;
}

/** The keys of every weight box holding unreadable text. */
export function invalidWeightKeys(weights: Weights): string[] {
  return Object.entries(weights)
    .filter(([, w]) => isInvalidWeight(w))
    .map(([k]) => k);
}

/** "Match current mix": each row's current share, in percent. */
export function presetCurrent(items: Weighable[]): Weights {
  return Object.fromEntries(items.map((i) => [i.key, pctText(Number(i.current_pct ?? 0) * 100, 1)]));
}

/**
 * The cash the portfolio holds (money-market funds + cash positions) in `ccy`.
 * The server sends it in the page currency with the spot rate of the same instant;
 * showing it in the other currency is a single-instant conversion with that rate.
 */
export function cashIn(
  inputs: { ccy: string; investable_cash?: string | null; fx_usd_per_eur?: string | null },
  ccy: string,
): number {
  const held = Number(inputs.investable_cash ?? 0);
  if (!(held > 0)) return 0;
  if (inputs.ccy === ccy) return held;
  const fx = Number(inputs.fx_usd_per_eur ?? 0);
  if (!(fx > 0)) return 0;
  return ccy === "USD" ? held * fx : held / fx;
}

/** "Equal weight": 100 / n each. */
export function presetEqual(items: Weighable[]): Weights {
  const n = items.length;
  return Object.fromEntries(items.map((i) => [i.key, n ? pctText(100 / n, 2) : "0"]));
}

/** "Clear": every weight to zero. */
export function presetClear(items: Weighable[]): Weights {
  return Object.fromEntries(items.map((i) => [i.key, "0"]));
}

/** "Load saved target": a saved target's fund weights (other funds to zero). */
export function presetSaved(items: Weighable[], target: TargetOut): Weights {
  const saved = new Map(target.items.map((t) => [String(t.instrument_id), Number(t.weight_pct) * 100]));
  return Object.fromEntries(items.map((i) => [i.key, pctText(saved.get(i.key) ?? 0, 2)]));
}

export function savedNoBuy(target: TargetOut): Record<string, boolean> {
  return Object.fromEntries(target.items.filter((t) => t.no_buy).map((t) => [String(t.instrument_id), true]));
}

/** True when the typed total is not 100 % (it will be normalised). */
export function isOff(total: number): boolean {
  return Math.abs(total - 100) > 0.005;
}

/** True for an exchange-traded fund (the calculator inputs carry each fund's asset class). */
export const isEtfClass = (assetClass: string | null | undefined): boolean => (assetClass ?? "").toLowerCase() === "etf";

/**
 * The funds of a category that get new money. With "Invest only in ETFs" on,
 * the ticked funds narrow to the ETFs (all of the category's ETFs when none of
 * them is ticked); the other funds stay held and keep counting toward the
 * category (the server credits held, un-ticked funds), but get no new money.
 * A category without any ETF keeps its own ticks (`etfOnly` does not apply).
 */
export function effectiveSelection(
  members: number[],
  picked: number[],
  etfOnly: boolean,
  isEtf: (id: number) => boolean,
): { ids: number[]; etfOnlyApplies: boolean } {
  const etfs = members.filter(isEtf);
  if (!etfOnly || etfs.length === 0) return { ids: picked, etfOnlyApplies: false };
  const ticked = picked.filter(isEtf);
  return { ids: ticked.length ? ticked : etfs, etfOnlyApplies: true };
}

/** A plan row's trade: + buys, - sells, 0 holds. */
export interface Trade {
  add_value?: string | null;
}

const addOf = (r: Trade) => Number(r.add_value ?? 0) || 0;

/** Rows in reading order: the biggest buys first, then the biggest sells, then the rest. */
export function orderTrades<T extends Trade>(rows: T[]): T[] {
  const rank = (r: T) => (addOf(r) > 0 ? 0 : addOf(r) < 0 ? 1 : 2);
  return [...rows].sort((a, b) => rank(a) - rank(b) || Math.abs(addOf(b)) - Math.abs(addOf(a)));
}

/** What a group of rows buys and sells (display only; each figure comes from the server rows). */
export function tradeTotals(rows: Trade[]): { buy: number; sell: number } {
  let buy = 0;
  let sell = 0;
  for (const r of rows) {
    const v = addOf(r);
    if (v > 0) buy += v;
    else sell -= v;
  }
  return { buy, sell };
}

/** The calculator mix saved with a target (see `BuilderStateIO` in the API). */
export interface SavedBuilder {
  mode: Mode;
  etf_only: boolean;
  categories: { name: string; weight: string; split: Split; selected: number[] }[];
}

/** The category part of the editor, as it is saved with a target. */
export interface CategoryEditor {
  weights: Weights;
  split: Record<string, Split>;
  selected: Record<string, number[]>;
}

/** What to save with a target: the mode, ETF-only and every category's weight, split and ticked funds. */
export function toSavedBuilder(mode: Mode, etfOnly: boolean, names: string[], ed: CategoryEditor): SavedBuilder {
  return {
    mode,
    etf_only: etfOnly,
    categories: names.map((name) => ({
      name,
      weight: ed.weights[name] ?? "0",
      split: ed.split[name] ?? "value",
      selected: [...(ed.selected[name] ?? [])],
    })),
  };
}

/**
 * The category editor restored from a saved target. Categories the target does
 * not know keep `fallback`; ticked ids that are no longer in the category drop out.
 */
export function fromSavedBuilder(
  saved: SavedBuilder,
  members: Record<string, number[]>,
  fallback: CategoryEditor,
): CategoryEditor {
  const out: CategoryEditor = {
    weights: { ...fallback.weights },
    split: { ...fallback.split },
    selected: { ...fallback.selected },
  };
  for (const c of saved.categories) {
    if (!(c.name in members)) continue;
    out.weights[c.name] = c.weight;
    out.split[c.name] = c.split;
    out.selected[c.name] = c.selected.filter((id) => members[c.name].includes(id));
  }
  return out;
}
