/**
 * Retroactive self-heal for the **1 Week** graph's "NAV-collapse nosedive"
 * (issue #169 / PR #171), applied to the curve the web **springboards** from the
 * blob.
 *
 * ## The defect this repairs
 * Right after the US market opens, the desktop's `build_week_value_series` could
 * value the day-drifting NAV-fund sleeve at **zero** for the oldest session(s) in
 * the rolling week window — whenever that day's published NAV or its EUR/USD rate
 * had not been cached yet. The whole-book "1 Week" curve then started at roughly
 * the value of the stocks *without* their NAV funds (~60 %), and the autoscale
 * crushed all detail out of the line.
 *
 * PR #171 fixed the *generator* (it now carries the nearest complete day's NAV
 * flat), but that fix only changes a **future** export. The already-published
 * blob is unchanged, so its `live_graphs.week` whole-book points still carry the
 * nosedive — and the web {@link ./springboard.springboardWeekCurve} paints those
 * points verbatim on every render. A hard "Reset cache & re-pull everything"
 * now forces an *unconditional* blob re-download (the cache reset used to be
 * defeated by a `304 Not Modified` on the unchanged remote blob), but that still
 * cannot help while the **remote** blob predates the 4.11.1 generator fix: a
 * faithful re-download of a still-corrupt export re-paints the same false
 * `week.points`. Until a fresh export lands, only a render-time repair can
 * de-nosedive the springboarded curve.
 *
 * ## The repair
 * This is the web analogue of the desktop's `_nearest_complete_date` gap-fill: a
 * **leading run** of session days whose whole-book close sits far below the rest
 * of the (otherwise stable) week is treated as a collapsed-NAV artefact and
 * **lifted** so it carries flat from the nearest healthy day — removing the
 * artificial step while preserving each collapsed day's own intraday shape. It is
 * deliberately conservative: it only touches a *contiguous leading depression*
 * that recovers and stays recovered, and only when the recovery step is large
 * enough to be implausible as a genuine settled overnight move. A normal week —
 * including a steady trend or ordinary volatility — is returned untouched.
 *
 * Pure and dependency-free, so it is unit-testable in isolation and safe to run
 * on every springboard render.
 */

import type { Decimal } from "./decimal-config";
import type { CurvePoint } from "./timeseries";

/**
 * How far below the week's healthy level a leading day's close must sit to be
 * considered a NAV collapse rather than ordinary drift. The real defect drops the
 * start to ~60 % (a ~40 % hole); 15 % comfortably clears normal weekly swings
 * while still catching the genuine collapse.
 */
export const MIN_COLLAPSE_DROP = 0.15;

/**
 * Minimum size of the recovery step (as a fraction of the healthy level) at the
 * boundary between the collapsed run and the first healthy day. A settled
 * close-to-open gap this large is implausible as a genuine overnight move, so it
 * is the signature of the NAV sleeve snapping back in. Guards against lifting a
 * merely soft start.
 */
export const MIN_RECOVERY_STEP = 0.08;

/** The `YYYY-MM-DD` UTC calendar day an epoch-ms instant falls on. */
function utcDayOf(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/** One session day's worth of curve points, with its first/last (settling) values. */
interface DayGroup {
  day: string;
  points: CurvePoint[];
  firstEur: Decimal;
  firstUsd: Decimal;
  lastEur: Decimal;
  lastUsd: Decimal;
}

/** Group ascending points by UTC session day (input assumed sorted by `t`). */
function groupByDay(points: CurvePoint[]): DayGroup[] {
  const groups: DayGroup[] = [];
  let current: CurvePoint[] = [];
  let day = "";
  const flush = (): void => {
    if (current.length === 0) return;
    const first = current[0];
    const last = current[current.length - 1];
    groups.push({
      day,
      points: current,
      firstEur: first.valueEur,
      firstUsd: first.valueUsd,
      lastEur: last.valueEur,
      lastUsd: last.valueUsd,
    });
  };
  for (const p of points) {
    const d = utcDayOf(p.t);
    if (d !== day) {
      flush();
      current = [];
      day = d;
    }
    current.push(p);
  }
  flush();
  return groups;
}

/**
 * Repair a NAV-collapse nosedive at the **start** of a springboarded 1W
 * whole-book curve. Returns the points unchanged (a new array is never forced)
 * when no clean leading collapse is detected, so it is a safe no-op on a healthy
 * week, a v1/v2 export, or any curve too short to judge.
 *
 * @param points Ascending whole-book settled points (one or more per session day).
 */
export function repairWeekNavCollapse(points: CurvePoint[]): CurvePoint[] {
  if (points.length < 2) return points;
  const groups = groupByDay(points);
  if (groups.length < 2) return points;

  // The week's healthy level: the highest session close. A collapsed start sits
  // far below it; ordinary days cluster near it.
  let healthyEur = groups[0].lastEur;
  for (const g of groups) if (g.lastEur.greaterThan(healthyEur)) healthyEur = g.lastEur;
  if (!healthyEur.greaterThan(0)) return points;

  const collapseFloor = healthyEur.times(1 - MIN_COLLAPSE_DROP);

  // The first healthy day ends the leading collapsed run. Bail unless the run is
  // a genuine *leading* depression: day 0 is collapsed and some later day is not.
  let firstHealthy = 0;
  while (firstHealthy < groups.length && groups[firstHealthy].lastEur.lessThan(collapseFloor)) {
    firstHealthy += 1;
  }
  if (firstHealthy === 0 || firstHealthy >= groups.length) return points;

  // The depression must recover *and stay* recovered — every day from the first
  // healthy one onward must itself be healthy. Otherwise this is ordinary
  // volatility (or a genuine trend), not a one-time collapsed-NAV artefact.
  for (let i = firstHealthy; i < groups.length; i += 1) {
    if (groups[i].lastEur.lessThan(collapseFloor)) return points;
  }

  // The constant lift = the step at the collapse→healthy boundary. The NAV hole
  // is the same constant across the whole collapsed run (the sleeve was unvalued
  // on each of those days), so one offset de-steps them all while keeping each
  // day's own intraday shape. Currencies are lifted independently (the NAV value
  // differs by leg).
  const donor = groups[firstHealthy];
  const lastCollapsed = groups[firstHealthy - 1];
  const offsetEur = donor.firstEur.minus(lastCollapsed.lastEur);
  const offsetUsd = donor.firstUsd.minus(lastCollapsed.lastUsd);

  // Require a large positive recovery step; a small/negative one is not the
  // collapse signature, so leave the curve alone.
  if (offsetEur.lessThanOrEqualTo(healthyEur.times(MIN_RECOVERY_STEP))) return points;

  const collapsedDays = new Set<string>();
  for (let i = 0; i < firstHealthy; i += 1) collapsedDays.add(groups[i].day);

  return points.map((p) =>
    collapsedDays.has(utcDayOf(p.t))
      ? { t: p.t, valueEur: p.valueEur.plus(offsetEur), valueUsd: p.valueUsd.plus(offsetUsd) }
      : p,
  );
}
