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

import { Decimal } from "./decimal-config";
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

/**
 * Heal a NAV-collapse nosedive baked into a **single session's** curve (the dense
 * 1D slice the 1D graph paints and the 1W graph splices on for *today*). This is
 * the per-point analogue of {@link repairWeekNavCollapse}, for the case the
 * whole-week repair structurally cannot reach: the collapse and its recovery sit
 * inside *one* UTC day, so a day-grouped lift sees a single group whose close is
 * already healthy (the live tip) and leaves the depressed body untouched.
 *
 * The defect (issue #169, the trailing/today case): a blob exported right after
 * the US open carries an entire intraday session valued *without* its NAV-fund
 * sleeve (~60 % of the book). {@link ../springboard.springboardSessionCurve}
 * trusts those `day.points` verbatim and merely bridges the gap to the live tip,
 * so the whole day nosedives to ~60 % and only the final live tip — the current
 * headline total, which always carries the NAV sleeve — snaps back. On the 1W
 * graph that lone late spike sits beside an otherwise-healthy settled week, and
 * the autoscale crushes the line; on the 1D graph the whole session is depressed.
 *
 * The repair lifts a **leading run** of collapsed points up onto the session's
 * own healthy level — the first point that recovers, else the live-tip
 * `healthyHint` when *every* charted point collapsed and only the tip is sound —
 * by the single constant NAV hole, preserving each point's intraday shape. It is
 * the same conservative leading-run-that-stays-recovered shape and the same
 * {@link MIN_COLLAPSE_DROP}/{@link MIN_RECOVERY_STEP} thresholds as the week
 * repair, so a healthy session (flat, trending, or merely volatile) is returned
 * untouched, and a genuine whole-book drop — where the live tip is itself low —
 * is never masked.
 *
 * @param points Ascending whole-book points for a single session (the dense 1D
 *   slice, normally ending on the live tip).
 * @param healthyHint The current headline whole-book level (the live tip). Raises
 *   the healthy benchmark and, when the charted body has *no* sound point of its
 *   own, donates the lift. Omitted/null keeps the body-only behaviour.
 */
export function repairSessionNavCollapse(
  points: CurvePoint[],
  healthyHint?: RepairHealthyHint | null,
): CurvePoint[] {
  if (points.length < 2) return points;

  // The session's own healthy level: the highest charted value, raised by the
  // live tip when it is higher (the body may be uniformly collapsed with only a
  // tiny healthy tip — or no healthy charted point at all).
  let healthyEur = points[0].valueEur;
  for (const p of points) if (p.valueEur.greaterThan(healthyEur)) healthyEur = p.valueEur;
  const hint = healthyHint ?? null;
  if (hint && hint.eur.greaterThan(healthyEur)) healthyEur = hint.eur;
  if (!healthyEur.greaterThan(0)) return points;

  const collapseFloor = healthyEur.times(1 - MIN_COLLAPSE_DROP);

  // The first point that clears the floor ends a leading collapsed run.
  let firstHealthy = 0;
  while (firstHealthy < points.length && points[firstHealthy].valueEur.lessThan(collapseFloor)) {
    firstHealthy += 1;
  }
  // No leading depression: the body opens healthy, so this is not the collapse
  // signature (a genuine late-day drop is left alone — never invented away).
  if (firstHealthy === 0) return points;

  // The depression must recover *and stay* recovered: every charted point from
  // the first healthy one onward must itself be healthy. Otherwise it is ordinary
  // intraday volatility, not a flat NAV hole.
  for (let i = firstHealthy; i < points.length; i += 1) {
    if (points[i].valueEur.lessThan(collapseFloor)) return points;
  }

  // Donor recovery level: the first healthy charted point, else the live tip when
  // the *entire* charted body collapsed (only the tip is sound).
  let donorEur: Decimal;
  let donorUsd: Decimal;
  if (firstHealthy < points.length) {
    donorEur = points[firstHealthy].valueEur;
    donorUsd = points[firstHealthy].valueUsd;
  } else if (hint) {
    donorEur = hint.eur;
    donorUsd = hint.usd;
  } else {
    return points;
  }

  const lastCollapsed = points[firstHealthy - 1];
  const offsetEur = donorEur.minus(lastCollapsed.valueEur);
  const offsetUsd = donorUsd.minus(lastCollapsed.valueUsd);

  // Require a large positive recovery step; a small/negative one is not the
  // collapse signature, so leave the curve alone.
  if (offsetEur.lessThanOrEqualTo(healthyEur.times(MIN_RECOVERY_STEP))) return points;

  return points.map((p, i) =>
    i < firstHealthy
      ? { t: p.t, valueEur: p.valueEur.plus(offsetEur), valueUsd: p.valueUsd.plus(offsetUsd) }
      : p,
  );
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

/**
 * How far a single point's whole-book USD/EUR ratio may stray from the curve's
 * prevailing ratio before it is treated as an FX-inconsistency artefact rather
 * than a genuine exchange-rate move. EUR/USD does not swing anywhere near this
 * much across a 1D/1W window (a few percent at most, and the *blended* whole-book
 * ratio moves even less), whereas the NAV-collapse defect knocks one leg out by
 * ~40 %. 12 % cleanly separates the two while preserving all genuine divergence.
 */
export const MAX_FX_RATIO_DRIFT = 0.12;

/** Median of a non-empty list of Decimals (sorted copy; mean of the middle two when even). */
function medianDecimal(values: Decimal[]): Decimal {
  const sorted = [...values].sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : sorted[mid - 1].plus(sorted[mid]).dividedBy(2);
}

/**
 * Heal a **single-currency** whole-book collapse that the EUR-only NAV-collapse
 * repairs above structurally cannot see (issue #169, attempts 1–3).
 *
 * ## Why the earlier repairs miss it
 * {@link repairWeekNavCollapse} / {@link repairSessionNavCollapse} detect a
 * collapse purely from `valueEur` and only when it forms a *leading* run. But the
 * real-world defect is **USD-only**: the desktop recovers each whole-book point's
 * USD value by re-applying FX to the EUR pivot (`usd = eur × fx`), and when the
 * NAV sleeve's EUR value and the FX rate it is paired with disagree, the USD leg
 * nosedives ~40 % while the EUR leg stays flat. Because EUR never moves, the
 * EUR-based repairs never fire — and because the bad point is usually *today*
 * (the trailing live slice), a leading-run repair could not reach it anyway. A
 * stale published blob keeps the bad point, so even "regenerate" re-paints it.
 *
 * ## The repair (currency-symmetric, position-agnostic)
 * Every whole-book point must satisfy the same physical invariant: its USD/EUR
 * ratio is the prevailing EUR→USD exchange rate, which varies only smoothly and
 * within a narrow band. These curves always end at the **live tip** — the
 * headline whole-book total in both currencies, the single most trustworthy point
 * (it carries the real, fully-loaded NAV sleeve at the live spot) — so we anchor
 * the prevailing rate on it and take the median of only the ratios that agree
 * with it. That stays robust even when a *majority* of points are collapsed (an
 * entire today-slice that lost its NAV in USD, with only the snap-back tip sound).
 * Any point whose ratio strays beyond {@link MAX_FX_RATIO_DRIFT} is then
 * FX-inconsistent — one of its two legs is corrupt. We rebuild the corrupt leg
 * from the healthy one at the prevailing rate, choosing the corrupt leg as the
 * one that jumps relative to its nearest consistent neighbours (and, when that is
 * ambiguous — e.g. a leading/whole run with no consistent neighbour — defaulting
 * to the USD leg, since USD is the FX-recovered, fragile side). A point with one
 * leg ≤ 0, or a curve whose ratio never strays, is returned untouched (the same
 * array, so callers can cheaply detect a no-op).
 *
 * Pure and dependency-free; safe to run on every render as the final safety net
 * after the springboard/live/merge paths, regardless of which currency the user
 * is viewing.
 */
export function repairCurrencyDivergence(
  points: CurvePoint[],
  maxDrift: number = MAX_FX_RATIO_DRIFT,
): CurvePoint[] {
  if (points.length < 3) return points;

  // Per-point whole-book USD/EUR ratio, defined only where both legs are positive.
  const ratios: Array<Decimal | null> = points.map((p) =>
    p.valueEur.greaterThan(0) && p.valueUsd.greaterThan(0) ? p.valueUsd.dividedBy(p.valueEur) : null,
  );
  const valid = ratios.filter((r): r is Decimal => r !== null);
  // Need a few healthy points to establish the prevailing rate; too few and we
  // cannot tell signal from corruption, so leave the curve alone.
  if (valid.length < 3) return points;

  // The prevailing EUR→USD ratio. These curves always end at the live tip — the
  // headline whole-book total, in both currencies, which is the single most
  // trustworthy point (it carries the real, fully-loaded NAV sleeve at the live
  // spot). So we anchor on the last valid point and take the median of only the
  // ratios that agree with it. This stays robust even when a *majority* of points
  // are collapsed (e.g. an entire today-slice lost its NAV in USD while only the
  // snap-back tip is sound) — the case a plain global median cannot survive.
  let anchor: Decimal | null = null;
  for (let i = points.length - 1; i >= 0; i -= 1) {
    if (ratios[i] !== null) {
      anchor = ratios[i];
      break;
    }
  }
  if (anchor === null || !anchor.greaterThan(0)) return points;
  const anchorLo = anchor.times(1 - maxDrift);
  const anchorHi = anchor.times(1 + maxDrift);
  const agreeing = valid.filter((r) => !r.lessThan(anchorLo) && !r.greaterThan(anchorHi));
  const med = agreeing.length > 0 ? medianDecimal(agreeing) : anchor;
  if (!med.greaterThan(0)) return points;
  const lo = med.times(1 - maxDrift);
  const hi = med.times(1 + maxDrift);

  // Points whose ratio sits within the band are the trustworthy ("consistent")
  // anchors; the rest are FX-inconsistent and need one leg rebuilt.
  const consistent = ratios.map((r) => r !== null && !r.lessThan(lo) && !r.greaterThan(hi));
  if (consistent.every((ok, i) => ok || ratios[i] === null)) return points;

  // Nearest consistent neighbour value (per leg) on a given side, for deciding
  // which leg jumped. Returns null when there is no consistent point that way.
  const neighbourValue = (
    i: number,
    step: 1 | -1,
    leg: (p: CurvePoint) => Decimal,
  ): Decimal | null => {
    for (let j = i + step; j >= 0 && j < points.length; j += step) {
      if (consistent[j]) return leg(points[j]);
    }
    return null;
  };

  return points.map((p, i) => {
    if (consistent[i] || ratios[i] === null) return p;

    // Relative jump of each leg away from its nearest consistent neighbours: the
    // corrupt leg is the one that moved, while the sound leg tracks its
    // neighbours. Averaging both sides (when available) tolerates a real trend.
    const legJump = (leg: (q: CurvePoint) => Decimal): number => {
      const here = leg(p);
      const refs = [neighbourValue(i, -1, leg), neighbourValue(i, 1, leg)].filter(
        (v): v is Decimal => v !== null && v.greaterThan(0),
      );
      if (refs.length === 0) return Number.NaN; // no anchor this leg — undecidable
      const ref =
        refs.length === 1 ? refs[0] : refs[0].plus(refs[1]).dividedBy(2);
      return here.minus(ref).abs().dividedBy(ref).toNumber();
    };

    const eurJump = legJump((q) => q.valueEur);
    const usdJump = legJump((q) => q.valueUsd);

    // Decide the corrupt leg. When both jumps are known, the larger one is
    // corrupt; otherwise (a leading/whole-run collapse with no consistent
    // neighbour) default to rebuilding USD — the FX-recovered, fragile leg.
    const fixEur =
      Number.isFinite(eurJump) && Number.isFinite(usdJump) ? eurJump > usdJump : false;

    return fixEur
      ? { t: p.t, valueEur: p.valueUsd.dividedBy(med), valueUsd: p.valueUsd }
      : { t: p.t, valueEur: p.valueEur, valueUsd: p.valueEur.times(med) };
  });
}
