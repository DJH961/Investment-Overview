/**
 * Anchored intraday/short-range curve reconstruction for the live-web companion.
 *
 * This is the **first** building block of the self-driving 1D/1W graphs
 * (docs/v3.0_live_web_companion_proposal.md §10.6). It is a direct port of the
 * desktop maths in `intraday_snapshots_service._reconstruct_session`, kept as a
 * set of pure functions so it can be unit-tested without any network, DOM, or
 * IndexedDB.
 *
 * The shape of the problem
 * ------------------------
 * The whole-book value at instant `t` is reconstructed as
 *
 *     value(t) = base + Σ valueᵢ · priceᵢ(t) / closeᵢ
 *
 * where `base` is the **constant** sleeve (settled cash + NAV funds that have no
 * intraday print) and the sum runs over the **intraday-priced** holdings (the
 * ETFs). Anchoring to the export's settled `base` and to each holding's exported
 * value/close means the curve **closes on the correct total** — the last bar of
 * the session lands on the same figure the headline shows, by construction.
 *
 * Why two currencies are reconstructed (not one rescaled)
 * -------------------------------------------------------
 * USD is the booked currency (spot prices arrive in USD), so the USD curve is
 * built **FX-free** — price ratios only. The EUR curve re-marks each USD-booked
 * holding at the EUR/USD rate struck **at that very bar** (`fxBars`), rebased
 * from the day's settled rate (`baseFx`). The two lines therefore genuinely
 * diverge minute by minute rather than being a uniform rescale of one another
 * (the "finest available FX granularity" rule). A holding the feed served no bar
 * for is carried flat (ratio = 1), exactly like the desktop.
 */

import { Decimal } from "./decimal-config";

/** A single price (or FX) bar: an epoch-ms instant and a value. */
export interface Bar {
  /** Instant the bar applies to, epoch milliseconds. */
  t: number;
  /** The bar value — a native price, or an EUR→USD rate, in its own units. */
  value: Decimal;
}

/**
 * One intraday-priced holding, expressed in the basis the reconstruction needs.
 *
 * `valueEur`/`valueUsd` are the holding's exported settled values (already at
 * `baseFx`); `closeNative` is its exported settled close in `nativeCurrency`.
 * The ratio `priceᵢ(t)/closeᵢ` re-marks those settled values to instant `t`.
 */
export interface ReconHolding {
  symbol: string;
  /** Settled EUR value of the holding (at the day's settled FX). */
  valueEur: Decimal;
  /** Settled USD value of the holding (FX-free; USD is the booked currency). */
  valueUsd: Decimal;
  /** Settled close in the holding's native currency — the ratio's denominator. */
  closeNative: Decimal;
  /** True when the holding is booked in USD, so its EUR view needs an FX rebase. */
  isUsdNative: boolean;
}

/** A reconstructed whole-book point: one instant, both currencies. */
export interface CurvePoint {
  t: number;
  valueEur: Decimal;
  valueUsd: Decimal;
}

/** Inputs to {@link reconstructSessionCurve}. */
export interface ReconstructInput {
  /** The intraday-priced sleeve (ETFs). NAV funds + cash ride in `base`, not here. */
  holdings: ReconHolding[];
  /** Per-symbol native price bars, ascending or not — sorted internally. */
  barsBySymbol: Map<string, Bar[]>;
  /** EUR→USD (USD per 1 EUR) bars; empty/omitted ⇒ every point falls back to `baseFx`. */
  fxBars?: Bar[];
  /** The day's settled EUR→USD rate the holdings' EUR values are expressed at. */
  baseFx: Decimal | null;
  /** Constant EUR base (settled cash + NAV funds) added at every point. */
  baseEur: Decimal;
  /** Constant USD base (settled cash + NAV funds) added at every point. */
  baseUsd: Decimal;
}

const ZERO = new Decimal(0);

/**
 * Latest bar value at or just before `at`, or **null** when `at` precedes every
 * bar (and when there are no bars). Assumes `bars` is sorted ascending by `t`.
 *
 * Returning null before the first bar — rather than borrowing `bars[0]` from the
 * *future* — keeps the curve honest: a holding/FX track is "unknown" until its
 * first real print, never back-filled with a value that had not happened yet
 * (the look-ahead leak this deliberately closes). Callers decide what an unknown
 * means for them (carry flat, fall back to a settled rate, or render a gap).
 */
export function forwardFilled(bars: Bar[], at: number): Decimal | null {
  if (bars.length === 0) return null;
  let chosen: Bar | null = null;
  for (const bar of bars) {
    if (bar.t <= at) chosen = bar;
    else break;
  }
  return chosen ? chosen.value : null;
}

/**
 * EUR pivot of the intraday-priced sleeve at instant `at` —
 * `Σ valueEurᵢ · priceᵢ(at)/closeᵢ`, each USD-booked holding rebased from the
 * day's settled rate (`baseFx`) to this bar's rate (`fxT`). Port of
 * `_market_component_pivot_eur`.
 */
export function marketComponentEur(
  holdings: ReconHolding[],
  barsBySymbol: Map<string, Bar[]>,
  at: number,
  fxT: Decimal | null,
  baseFx: Decimal | null,
): Decimal {
  let market = ZERO;
  for (const h of holdings) {
    const ratio = ratioAt(h, barsBySymbol, at);
    let contrib = h.valueEur.times(ratio);
    if (fxT && baseFx && h.isUsdNative && !fxT.isZero()) {
      // Re-mark the derived EUR pivot from the settled rate to this bar's rate;
      // the native USD value stays FX-free.
      contrib = contrib.times(baseFx).div(fxT);
    }
    market = market.plus(contrib);
  }
  return market;
}

/**
 * USD pivot of the intraday-priced sleeve at instant `at` —
 * `Σ valueUsdᵢ · priceᵢ(at)/closeᵢ`. USD is the booked currency, so a USD-booked
 * holding needs **no** FX. (A non-USD-booked holding's USD view would scale with
 * FX, but the book is USD-native in practice; we keep it FX-free and flat here,
 * mirroring the desktop's "USD without FX" stance.)
 */
export function marketComponentUsd(
  holdings: ReconHolding[],
  barsBySymbol: Map<string, Bar[]>,
  at: number,
): Decimal {
  let market = ZERO;
  for (const h of holdings) {
    const ratio = ratioAt(h, barsBySymbol, at);
    market = market.plus(h.valueUsd.times(ratio));
  }
  return market;
}

/** `priceᵢ(at)/closeᵢ`, or a flat 1 when the feed served no bar for the symbol. */
function ratioAt(h: ReconHolding, barsBySymbol: Map<string, Bar[]>, at: number): Decimal {
  if (h.closeNative.isZero()) return new Decimal(1);
  const priceT = forwardFilled(barsBySymbol.get(h.symbol) ?? [], at);
  if (priceT === null) return new Decimal(1);
  return priceT.div(h.closeNative);
}

/**
 * Reconstruct the whole-book curve over the union of all bar instants.
 *
 * Returns one {@link CurvePoint} per distinct bar time (ascending), each closing
 * on `base + market(t)` in both currencies. The set of instants is the union of
 * every symbol's bars (FX bars do not introduce points of their own — they only
 * re-mark the EUR pivot at instants that already exist), matching the desktop,
 * which iterates `bar_times` from the price feed.
 */
export function reconstructSessionCurve(input: ReconstructInput): CurvePoint[] {
  const { holdings, fxBars = [], baseFx, baseEur, baseUsd } = input;

  // Sort each symbol's bars once so forward-fill is a single forward scan.
  const sortedBars = new Map<string, Bar[]>();
  for (const [symbol, bars] of input.barsBySymbol) {
    sortedBars.set(symbol, [...bars].sort((a, b) => a.t - b.t));
  }
  const sortedFx = [...fxBars].sort((a, b) => a.t - b.t);

  // The union of every priced symbol's bar instants, ascending and de-duped.
  const instants = new Set<number>();
  for (const h of holdings) {
    for (const bar of sortedBars.get(h.symbol) ?? []) instants.add(bar.t);
  }
  const times = [...instants].sort((a, b) => a - b);

  const points: CurvePoint[] = [];
  for (const t of times) {
    const fxT = sortedFx.length > 0 ? forwardFilled(sortedFx, t) : null;
    const marketEur = marketComponentEur(holdings, sortedBars, t, fxT, baseFx);
    const marketUsd = marketComponentUsd(holdings, sortedBars, t);
    points.push({
      t,
      valueEur: baseEur.plus(marketEur),
      valueUsd: baseUsd.plus(marketUsd),
    });
  }
  return points;
}
