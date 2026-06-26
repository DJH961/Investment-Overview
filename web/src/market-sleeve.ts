/**
 * Pillar 3 (WS7) — the **web⇄blob 1W merge** for the schema-v3 market-sleeve
 * backbone (`docs/centralized_data_pull_plan.md` §"Pillar 3 — 1D fills 1W, and
 * web⇄blob merge"; the matching desktop export is `live_graphs.py` schema_v3).
 *
 * The desktop now ships, per the owner's decision, **not** per-symbol bars but
 * its own aggregate representation: the value of the intraday-priced sleeve over
 * the whole week, at true capture instants, with a per-instant FX rate. The web
 * builds its *own* market-sleeve series from the data it already has, and treats
 * the blob's series as a second, usually richer source. Because both sides speak
 * **one homogeneous quantity — the FX-free (USD) market-sleeve value over time —**
 * they merge per nominal time-slot without the base-change steps per-symbol data
 * would have caused:
 *
 * | Slot state | Action |
 * |---|---|
 * | One source present | use it |
 * | Both agree within **τ ≤ 0.25%** | keep the **denser coverage** (richer line) |
 * | Both disagree > τ | keep the **blob** series (token-free, desktop-authoritative) **and emit a reconciliation flag** |
 *
 * Everything here is **pure** and side-effect-free so the survival rules of the
 * merge are unit-testable in isolation (`web/test/market-sleeve.test.ts`). The
 * caller reapplies the current cash + NAV base once at render and logs the
 * returned {@link ReconciliationFlag}s so a divergence between the two apps is a
 * visible early warning, never a silently averaged lie.
 */

import { Decimal } from "./decimal-config";
import type { CurvePoint } from "./timeseries";
import type { ExportLiveGraphs, ExportMarketSeries } from "./types";

/** Reconciliation tolerance: slots agreeing within this fraction thicken the line. */
export const DEFAULT_RECON_TAU = 0.0025; // 0.25%

/** Default bucketing grid (30 min) — the desktop's `"30m"` export default. */
export const DEFAULT_GRID_MS = 30 * 60 * 1000;

/** Which provenance a merged point came from — surfaced for logging/regression. */
export type SleeveSource = "web" | "blob" | "both";

/**
 * One market-sleeve sample: the FX-free (USD) sleeve value at a true instant,
 * plus the EUR→USD rate in force then (`null` ⇒ fall back to today's rate). This
 * is the *homogeneous* quantity both the web and the blob speak.
 */
export interface SleevePoint {
  /** True capture instant, epoch ms. */
  t: number;
  /** FX-free booked (USD) market-sleeve value. */
  valueNativeUsd: Decimal;
  /** EUR→USD rate in force at `t`, or `null` when the blob shipped no rate. */
  fxEurUsd: Decimal | null;
}

/** A merged sleeve sample, tagged with where it came from. */
export interface MergedSleevePoint extends SleevePoint {
  source: SleeveSource;
}

/**
 * A slot where the web and blob sleeve values disagreed by more than τ. Emitted
 * (not blended) so the owner can deep-dive *why* the two apps diverge — the
 * cross-app scenario the merge exists for.
 */
export interface ReconciliationFlag {
  /** The grid bucket's start instant, epoch ms. */
  bucketStartMs: number;
  /** The web's representative sleeve value for the bucket. */
  webValueUsd: Decimal;
  /** The blob's representative sleeve value for the bucket. */
  blobValueUsd: Decimal;
  /** Signed relative gap `(web − blob) / |blob|`, as a fraction. */
  deltaFraction: number;
}

/** The merge verdict: the merged sleeve line plus any reconciliation flags. */
export interface SleeveMerge {
  points: MergedSleevePoint[];
  flags: ReconciliationFlag[];
  /** Count of slots each provenance contributed (for the polling log). */
  counts: { web: number; blob: number; both: number };
}

/** Resolve the bucketing grid (ms) from the export's `grid` tag. */
export function gridMsFor(grid: ExportLiveGraphs["grid"] | undefined): number {
  if (grid === undefined || grid === "30m") return DEFAULT_GRID_MS;
  if (grid === "15m") return 15 * 60 * 1000;
  // An unrecognised tag (e.g. a future/garbled export) silently falling back to
  // 30m would mis-bucket the merge without a trace — surface it instead.
  console.warn(`gridMsFor: unexpected grid tag ${JSON.stringify(grid)}; defaulting to 30m.`);
  return DEFAULT_GRID_MS;
}

/** Floor an instant to its grid bucket start. */
export function bucketStart(t: number, gridMs: number = DEFAULT_GRID_MS): number {
  return Math.floor(t / gridMs) * gridMs;
}

/**
 * Parse the columnar {@link ExportMarketSeries} into ascending {@link SleevePoint}s.
 * Index-aligned arrays are zipped defensively; a `null` (or unparseable)
 * `value_native` marks a capture gap and is skipped, and a `null` `fx_eur_usd`
 * is preserved as `null` so the caller can fall back to today's rate.
 */
export function parseMarketSeries(series: ExportMarketSeries | null | undefined): SleevePoint[] {
  if (!series || !Array.isArray(series.times) || series.times.length === 0) return [];
  const { times, value_native, fx_eur_usd } = series;
  const out: SleevePoint[] = [];
  for (let i = 0; i < times.length; i += 1) {
    const t = Date.parse(times[i]);
    const rawValue = value_native?.[i];
    if (Number.isNaN(t) || rawValue === null || rawValue === undefined) continue;
    let valueNativeUsd: Decimal;
    try {
      valueNativeUsd = new Decimal(rawValue);
    } catch {
      continue;
    }
    const rawFx = fx_eur_usd?.[i];
    let fxEurUsd: Decimal | null = null;
    if (rawFx !== null && rawFx !== undefined) {
      try {
        const fx = new Decimal(rawFx);
        fxEurUsd = fx.isFinite() && fx.gt(0) ? fx : null;
      } catch {
        fxEurUsd = null;
      }
    }
    out.push({ t, valueNativeUsd, fxEurUsd });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** Group sleeve points by grid bucket, preserving each bucket's true timestamps. */
function byBucket(points: SleevePoint[], gridMs: number): Map<number, SleevePoint[]> {
  const buckets = new Map<number, SleevePoint[]>();
  for (const p of points) {
    const key = bucketStart(p.t, gridMs);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(p);
    else buckets.set(key, [p]);
  }
  return buckets;
}

/** A bucket's representative value: its latest (settling) sample. */
function representative(bucket: SleevePoint[]): SleevePoint {
  return bucket.reduce((latest, p) => (p.t >= latest.t ? p : latest), bucket[0]);
}

/** Tag a whole bucket's points with one provenance. */
function tag(bucket: SleevePoint[], source: SleeveSource): MergedSleevePoint[] {
  return bucket.map((p) => ({ ...p, source }));
}

/**
 * Merge the web's reconstructed market-sleeve series with the blob's dense series
 * per grid bucket, applying the agreement table at the top of this module. True
 * timestamps are kept (the grid is only a **bucketing rule for comparison**,
 * never a snapping rule), so the merged line lands on real instants.
 *
 * - **One source** present in a bucket → use it verbatim.
 * - **Both** present and agreeing within τ → keep the **union** of both buckets'
 *   points (the denser, richer line — overlapping slots that agree thicken it).
 * - **Both** present and disagreeing > τ → keep the **blob** bucket's points (the
 *   token-free, desktop-authoritative history) and emit a {@link ReconciliationFlag}.
 */
export function mergeSleeveSeries(
  web: SleevePoint[],
  blob: SleevePoint[],
  opts: { gridMs?: number; tau?: number } = {},
): SleeveMerge {
  const gridMs = opts.gridMs ?? DEFAULT_GRID_MS;
  const tau = opts.tau ?? DEFAULT_RECON_TAU;
  const webBuckets = byBucket(web, gridMs);
  const blobBuckets = byBucket(blob, gridMs);
  const keys = [...new Set([...webBuckets.keys(), ...blobBuckets.keys()])].sort((a, b) => a - b);

  const points: MergedSleevePoint[] = [];
  const flags: ReconciliationFlag[] = [];
  const counts = { web: 0, blob: 0, both: 0 };

  for (const key of keys) {
    const w = webBuckets.get(key);
    const b = blobBuckets.get(key);
    if (w && !b) {
      points.push(...tag(w, "web"));
      counts.web += 1;
      continue;
    }
    if (b && !w) {
      points.push(...tag(b, "blob"));
      counts.blob += 1;
      continue;
    }
    if (!w || !b) continue; // unreachable (key came from one of the maps)

    const wv = representative(w).valueNativeUsd;
    const bv = representative(b).valueNativeUsd;
    const denom = bv.abs();
    const deltaFraction = denom.isZero()
      ? wv.isZero()
        ? 0
        : Number.POSITIVE_INFINITY
      : wv.minus(bv).div(denom).toNumber();

    if (Math.abs(deltaFraction) <= tau) {
      // Agree — thicken the line with the union of both sources' true points.
      points.push(...tag(w, "both"), ...tag(b, "both"));
      counts.both += 1;
    } else {
      // Disagree — keep the blob (authoritative) and raise a flag, never a spike.
      points.push(...tag(b, "blob"));
      counts.blob += 1;
      flags.push({ bucketStartMs: key, webValueUsd: wv, blobValueUsd: bv, deltaFraction });
    }
  }

  points.sort((a, b) => a.t - b.t);
  return { points, flags, counts };
}

/**
 * A flat whole-book base to reapply to a sleeve series at render: the constant
 * cash + NAV value the desktop adds on top of the intraday-priced sleeve. EUR and
 * USD are carried independently (USD is FX-free; EUR is *not* a rescale of it).
 */
export interface WholeBookBase {
  /** Cash + NAV value in EUR. */
  baseEur: Decimal;
  /** Cash + NAV value in USD (FX-free). */
  baseUsd: Decimal;
}

/**
 * Reapply the whole-book base to a merged sleeve series, recovering the EUR line
 * at each point's *own* FX rate (or `fallbackFx` when the blob shipped none), so
 * the two currency lines diverge exactly as the desktop's do:
 *
 *   valueUsd = sleeveUsd + baseUsd          (FX-free)
 *   valueEur = sleeveUsd / fx + baseEur      (per-instant rate)
 *
 * Points with no usable FX (no per-instant rate and no fallback) keep a derived
 * EUR of the sleeve at parity — never dropped — so the USD line stays complete.
 */
export function rebaseSleeveToWholeBook(
  points: SleevePoint[],
  base: WholeBookBase,
  fallbackFx: Decimal | null,
): CurvePoint[] {
  return points.map((p) => {
    const fx = p.fxEurUsd ?? fallbackFx;
    const sleeveEur = fx && fx.gt(0) ? p.valueNativeUsd.div(fx) : p.valueNativeUsd;
    return {
      t: p.t,
      valueUsd: p.valueNativeUsd.plus(base.baseUsd),
      valueEur: sleeveEur.plus(base.baseEur),
    };
  });
}

/** Whether an export carries a usable v3 market-sleeve backbone (else: degrade). */
export function hasMarketSleeve(exported: ExportLiveGraphs | undefined): boolean {
  return parseMarketSeries(exported?.market_series).length >= 2;
}

/**
 * One-line, log-ready summary of a merge for the polling trail, e.g.
 * `merged sleeve: 36 web-only, 80 both, 2 blob-only; 1 reconciliation flag`. Every
 * merge writes one of these so a divergence is never undiscoverable.
 */
export function describeMerge(merge: SleeveMerge): string {
  const { web, blob, both } = merge.counts;
  const flagPart =
    merge.flags.length === 0
      ? "no reconciliation flags"
      : `${merge.flags.length} reconciliation flag${merge.flags.length === 1 ? "" : "s"}`;
  return `merged sleeve: ${web} web-only, ${both} agreeing, ${blob} blob-only slots; ${flagPart}`;
}

/** A compact, log-ready description of a single reconciliation flag. */
export function describeFlag(flag: ReconciliationFlag): string {
  const when = new Date(flag.bucketStartMs).toISOString().slice(0, 16).replace("T", " ");
  // A zero blob value makes deltaFraction non-finite (±Infinity); render it as
  // "∞" rather than the bare "Infinity%" the default formatter would emit.
  const pct = Number.isFinite(flag.deltaFraction) ? `${(flag.deltaFraction * 100).toFixed(2)}%` : "∞";
  return `${when}Z web ${flag.webValueUsd.toFixed(2)} vs blob ${flag.blobValueUsd.toFixed(2)} (Δ ${pct})`;
}
