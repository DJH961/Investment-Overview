/**
 * Builder state helpers. Display-only arithmetic on typed weights (presets and
 * the live total); every plan figure comes from `POST /api/allocations/plan`.
 */
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
  return list.reduce((a, w) => a + (Number(w) || 0), 0);
}

/** "Match current mix": each row's current share, in percent. */
export function presetCurrent(items: Weighable[]): Weights {
  return Object.fromEntries(items.map((i) => [i.key, pctText(Number(i.current_pct ?? 0) * 100, 1)]));
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
