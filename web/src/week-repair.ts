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
 * ## The whole-week collapse (the case that defeated PR #171)
 * A leading-run repair can only act when *some* settled day in the blob is still
 * healthy to anchor the lift. But a blob exported right after a "Reset cache &
 * re-pull" (every cached FX rate gone, so `compute_positions` cannot value the
 * NAV sleeve on **any** session) — or any export whose entire settled week lost
 * its funds — collapses *all* the settled points at once. There is then no
 * healthy settled day to donate the lift, so the bare leading-run repair gives up
 * and the nosedive survives. Yet the web *does* hold a trustworthy healthy level:
 * today's live whole-book value (the headline total / the dense 1D slice the 1W
 * curve is about to splice on), which always carries the real NAV sleeve. Passing
 * that as {@link RepairHealthyHint} lets the repair recognise an all-settled
 * collapse (every settled day sits far below today's level) and lift the whole
 * settled run onto it — the same constant-NAV-hole offset, donated by today
 * instead of by a healthy settled neighbour.
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

/**
 * Today's trustworthy healthy whole-book level, supplied from the **live** side
 * (the dense 1D slice's opening value, else the headline live tip). Used as the
 * recovery anchor when the blob's *entire* settled week collapsed, so there is no
 * healthy settled day of its own to donate the lift. Both currencies travel
 * together because the NAV hole differs by leg.
 */
export interface RepairHealthyHint {
  eur: Decimal;
  usd: Decimal;
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
 * @param healthyHint Today's live whole-book level (the dense 1D slice's open, or
 *   the headline live tip). When supplied it both raises the week's healthy
 *   benchmark and, crucially, donates the lift when **every** settled day has
 *   collapsed — the all-week case a settled-only donor cannot reach. Omitted/null
 *   keeps the original leading-run-only behaviour.
 */
export function repairWeekNavCollapse(
  points: CurvePoint[],
  healthyHint?: RepairHealthyHint | null,
): CurvePoint[] {
  if (points.length < 2) return points;
  const groups = groupByDay(points);
  if (groups.length < 1) return points;

  // The settled week's *own* healthy level: the highest session close. Detection
  // of which days collapsed is judged against this peer level only — never against
  // today's live value — so a week that genuinely *grew* (every settled day below
  // today) is not mistaken for a collapse.
  let healthyEur = groups[0].lastEur;
  for (const g of groups) if (g.lastEur.greaterThan(healthyEur)) healthyEur = g.lastEur;
  if (!healthyEur.greaterThan(0)) return points;

  const collapseFloor = healthyEur.times(1 - MIN_COLLAPSE_DROP);
  const hint = healthyHint ?? null;

  // The first day that clears the settled floor ends a leading collapsed run.
  let firstHealthy = 0;
  while (firstHealthy < groups.length && groups[firstHealthy].lastEur.lessThan(collapseFloor)) {
    firstHealthy += 1;
  }

  // No settled day stands out as collapsed relative to its peers. The week may
  // still be *uniformly* collapsed — every settled day lost its NAV sleeve, so
  // none stands out, yet all sit far below today's live whole-book level. Only the
  // live hint can reveal and anchor that whole-week case (PR #171's blind spot).
  if (firstHealthy === 0) {
    if (!hint) return points;
    const hintFloor = hint.eur.times(1 - MIN_COLLAPSE_DROP);
    // Require the *entire* settled week (its strongest day included) to sit below
    // the live level by more than the collapse threshold — a uniform depression,
    // not ordinary single-week drift.
    if (!healthyEur.lessThan(hintFloor)) return points;
    return liftLeading(points, groups, groups.length, hint.eur, hint.usd, healthyEur);
  }

  // A partial leading collapse: the depression must recover *and stay* recovered —
  // every day from the first healthy one onward must itself be healthy. Otherwise
  // this is ordinary volatility (or a genuine trend), not a collapsed-NAV artefact.
  for (let i = firstHealthy; i < groups.length; i += 1) {
    if (groups[i].lastEur.lessThan(collapseFloor)) return points;
  }
  const donor = groups[firstHealthy];
  return liftLeading(points, groups, firstHealthy, donor.firstEur, donor.firstUsd, healthyEur);
}

/**
 * Lift the leading `runLength` collapsed session days by the single constant NAV
 * hole — the step from the last collapsed day's close to the `donor*` recovery
 * level — keeping each day's own intraday shape. Returns `points` untouched when
 * the recovery step is too small to be the collapse signature.
 */
function liftLeading(
  points: CurvePoint[],
  groups: DayGroup[],
  runLength: number,
  donorEur: Decimal,
  donorUsd: Decimal,
  healthyEur: Decimal,
): CurvePoint[] {
  const lastCollapsed = groups[runLength - 1];
  const offsetEur = donorEur.minus(lastCollapsed.lastEur);
  const offsetUsd = donorUsd.minus(lastCollapsed.lastUsd);

  // Require a large positive recovery step; a small/negative one is not the
  // collapse signature, so leave the curve alone.
  if (offsetEur.lessThanOrEqualTo(healthyEur.times(MIN_RECOVERY_STEP))) return points;

  const collapsedDays = new Set<string>();
  for (let i = 0; i < runLength; i += 1) collapsedDays.add(groups[i].day);

  return points.map((p) =>
    collapsedDays.has(utcDayOf(p.t))
      ? { t: p.t, valueEur: p.valueEur.plus(offsetEur), valueUsd: p.valueUsd.plus(offsetUsd) }
      : p,
  );
}
