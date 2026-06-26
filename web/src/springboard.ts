/**
 * Springboard the live 1D/1W graph off the **exported** session embedded in the
 * snapshot blob (`live_graphs`, schema v2+), instead of always re-fetching
 * intraday bars from the live provider.
 *
 * The desktop ships its already-captured whole-book 1D session and 1W sleeve in
 * the export ({@link ExportLiveGraphs}). When that export still belongs to the
 * session the web would otherwise build live, we paint the curve straight from
 * it — an **instant** first paint that spends **zero** free-tier credits — and
 * only bridge to the live tip (the current headline total) for the gap between
 * the export and *now*. When the export is absent or too stale, these helpers
 * return `null` so the caller falls back to the full live build
 * ({@link ../live-graph}).
 *
 * Staleness is judged on the **trading calendar**, not a wall-clock age, which
 * both keeps the medium cases usable and enforces the trust rule (we never label
 * an old session as today's):
 *
 *   - **1D** — usable while its `session_date` is still {@link lastSessionDate}.
 *     That single rule covers *fresh* (minutes old), *medium* (a couple hours
 *     old — same session), **and** the pre-market "show yesterday's completed
 *     session" case (before today opens, `lastSessionDate` is yesterday). The
 *     moment today's session starts, a yesterday export no longer matches and we
 *     rebuild live, so today is never drawn from yesterday's data.
 *   - **1W** — usable while its `end_date` is the current or the *previous*
 *     trading session (≤ 1 trading day stale). A day-old 1W blob is missing at
 *     most today's daily point, which the live tip supplies, so it springboards;
 *     anything older has slid out of the window and rebuilds live.
 *
 * Freshness is necessary but **not sufficient**: a blob can be perfectly current
 * yet only carry a sliver of the span it claims (e.g. an export that shipped just
 * the last day of the week, or only the final minutes of the session). Trusting
 * such a blob paints a stunted curve, so each decider also runs a **completeness
 * gate** and falls back to a live rebuild when the exported data does not cover
 * nearly all of the window (see {@link MIN_WEEK_DAY_COVERAGE} /
 * {@link MIN_SESSION_COVERAGE}):
 *
 *   - **1W** — the exported points must span almost all of the trading sessions
 *     the window expects up to `end_date` (the live tip may supply the final
 *     remaining day). A blob missing more than a stray session is rejected.
 *   - **1D** — the exported points must begin within the session's opening
 *     sliver, not partway through it, so the curve is the whole session rather
 *     than just its tail.
 *
 * Pure and DOM-/network-free: `now`, the live tip and the exported data are all
 * injected, so the decision is unit-testable in isolation.
 */

import { Decimal } from "./decimal-config";
import { appendLiveTip, capAtClose, type LiveTip } from "./intraday";
import {
  isUsMarketOpen,
  lastSessionDate,
  previousTradingSession,
  recentTradingSessions,
  sessionCloseMs,
  sessionOpenMs,
} from "./market-hours";
import type { CurvePoint } from "./timeseries";
import type { ExportLiveCurvePoint, ExportLiveGraphSeries, ExportLiveGraphs } from "./types";
import { repairWeekNavCollapse } from "./week-repair";
import { DEFAULT_WEEK_SESSIONS } from "./week";

/**
 * Minimum share of the trading sessions a 1W blob *claims* (those in the window
 * up to its `end_date`) that its points must actually cover for it to be trusted
 * as a whole-week curve. Below this the export is too sparse — missing a chunk of
 * the week — and we rebuild live instead. Strict by design: only a near-complete
 * week (the live tip may still supply the final missing session) springboards.
 */
export const MIN_WEEK_DAY_COVERAGE = 0.9;

/**
 * Minimum share of the session a 1D blob's points must already cover before the
 * live tip is allowed to bridge the rest. The earliest exported point must land
 * within the first `1 - MIN_SESSION_COVERAGE` of the elapsed session; a blob that
 * misses more than the session's opening sliver is rebuilt live.
 */
export const MIN_SESSION_COVERAGE = 0.9;

/** Epoch-ms of a `YYYY-MM-DD` New-York session at UTC midnight (window floor). */
function dayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

/**
 * The number of distinct trading days the points fall on. US regular-session
 * instants (and daily closes at 16:00 ET = 20:00Z) share the UTC calendar date of
 * their New-York session, so a UTC-date bucket counts sessions without needing the
 * exchange-offset maths.
 */
function distinctSessionDays(points: CurvePoint[]): number {
  const days = new Set<string>();
  for (const p of points) days.add(new Date(p.t).toISOString().slice(0, 10));
  return days.size;
}

/**
 * Parse exported whole-book points into {@link CurvePoint}s, dropping any whose
 * instant or values can't be read (so a partial/old export never throws). Points
 * are returned ascending by instant.
 */
export function parseExportedPoints(points: ExportLiveCurvePoint[] | undefined): CurvePoint[] {
  if (!points || points.length === 0) return [];
  const out: CurvePoint[] = [];
  for (const p of points) {
    const t = Date.parse(p.t);
    if (Number.isNaN(t) || p.value_eur === null || p.value_usd === null) continue;
    if (p.value_eur === undefined || p.value_usd === undefined) continue;
    let valueEur: Decimal;
    let valueUsd: Decimal;
    try {
      valueEur = new Decimal(p.value_eur);
      valueUsd = new Decimal(p.value_usd);
    } catch {
      continue;
    }
    out.push({ t, valueEur, valueUsd });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** Inputs shared by the 1D and 1W springboard deciders. */
export interface SpringboardInput {
  /** The blob's `live_graphs` section (absent on older/data-less exports). */
  exported: ExportLiveGraphs | undefined;
  /** Reference instant (defaults to now). */
  now?: Date;
  /** The current headline totals to bridge the export to "now" (null ⇒ none). */
  liveTip?: LiveTip | null;
  /**
   * The dense **current-day** 1D session curve (the same data the 1D graph
   * shows), used **only** by {@link springboardWeekCurve}. When supplied, today's
   * slice of the sprung week is drawn from this dense curve instead of the coarse
   * `week.points` tail — so "1D fills 1W" holds even on the springboard fast path.
   * When absent, today is bridged with the single live tip (the legacy behaviour).
   */
  todayCurve?: CurvePoint[] | null;
}

/**
 * The springboarded **1D** curve, or `null` when the export can't stand in for a
 * live build (absent, too few points, or no longer the current session).
 *
 * When usable, the exported session's points are bridged to the live tip: while
 * the market is open the tip lands at `now`; once closed it lands at the 16:00 ET
 * close (so a mid-session export still ends at the real close value rather than
 * trailing flat), and the curve is capped there.
 */
export function springboardSessionCurve(input: SpringboardInput): CurvePoint[] | null {
  const day = input.exported?.day;
  if (!day) return null;
  const now = input.now ?? new Date();
  const sessionDate = day.session_date;
  // Only spring off the export while it is still the session a live build would
  // cover — this is the freshness *and* trust gate in one (see module docs).
  if (!sessionDate || sessionDate !== lastSessionDate(now)) return null;

  let points = parseExportedPoints(day.points);
  if (points.length < 1) return null;

  const marketOpen = isUsMarketOpen(now);
  const closeMs = sessionCloseMs(sessionDate);
  // Completeness gate: the export must cover the session from its open, not just
  // a late sliver — otherwise the curve would jump straight to the tip and hide
  // most of the day. The tip still bridges the open end, so we only require the
  // *earliest* point to land within the session's opening sliver (1 - 90%).
  const openMs = sessionOpenMs(sessionDate);
  const elapsedEnd = marketOpen ? now.getTime() : closeMs;
  if (
    elapsedEnd > openMs &&
    points[0].t > openMs + (elapsedEnd - openMs) * (1 - MIN_SESSION_COVERAGE)
  ) {
    return null;
  }

  const tipT = marketOpen ? now.getTime() : closeMs;
  if (input.liveTip) points = appendLiveTip(points, tipT, input.liveTip);
  if (!marketOpen) points = capAtClose(points, closeMs);

  return points.length >= 2 ? points : null;
}

/**
 * The springboarded **1W** curve, or `null` when the export is absent, too thin,
 * or more than one trading day stale (slid out of the current window).
 *
 * Exported points before the current window's first session are dropped (they
 * rolled out when the window advanced). The blob is then trusted only **through
 * the last settled session**: today's portion of `week.points` (the coarse tail)
 * is discarded so the current day is supplied by the dense live 1D session
 * instead — the caller passes it as {@link SpringboardInput.todayCurve}, and that
 * slice is spliced on (making "1D fills 1W" hold even on this fast path). When no
 * `todayCurve` is supplied the curve falls back to bridging today with the single
 * live tip — at `now` while open, or the last settled session's close once shut —
 * so a caller that has no dense session still ends on today's (or the latest) value.
 */
export function springboardWeekCurve(input: SpringboardInput): CurvePoint[] | null {
  const week = input.exported?.week;
  if (!week) return null;
  const now = input.now ?? new Date();
  const endDate = week.end_date;
  if (!endDate) return null;
  const last = lastSessionDate(now);
  // Fresh (ends today) or ≤ 1 trading day stale (ends the previous session).
  if (endDate !== last && endDate !== previousTradingSession(last)) return null;

  const allPoints = parseExportedPoints(week.points);
  if (allPoints.length < 1) return null;

  // Keep only points inside the current trading-session window; the day that
  // rolled out when the window advanced is dropped.
  const window = recentTradingSessions(DEFAULT_WEEK_SESSIONS, now);
  const windowStartMs = dayStartMs(window[0] ?? last);
  const windowPoints = allPoints.filter((p) => p.t >= windowStartMs);
  if (windowPoints.length < 1) return null;

  // The current day is never owned by the coarse week tail: trust the export only
  // through the last *settled* session and drop today's `week.points`, leaving the
  // dense live 1D session (spliced below) to supply today.
  const todayStartMs = dayStartMs(last);
  // Retroactively self-heal a NAV-collapse nosedive baked into a *stale* blob's
  // `week.points` (issue #169 / PR #171): the desktop generator is fixed, but an
  // unchanged published blob still carries the pre-fix curve, and a cache reset
  // cannot remove it (the blob re-paints on every render). The repair lifts a
  // collapsed leading run back onto the week's healthy level, the web analogue of
  // the desktop's nearest-complete-day NAV gap-fill. A no-op on a healthy week.
  let points = repairWeekNavCollapse(windowPoints.filter((p) => p.t < todayStartMs));

  // Completeness gate over the *settled* sessions only (today is supplied live): a
  // fresh `end_date` is not enough — the blob must span nearly the whole settled
  // week, not just the last session or two. Compare the distinct settled trading
  // days the points cover against the window's pre-today sessions up to `end_date`,
  // and rebuild live when the export is too sparse to be a trustworthy week curve.
  const settledSessions = window.filter((d) => d < last && d <= endDate).length;
  const requiredDays = Math.max(2, Math.ceil(settledSessions * MIN_WEEK_DAY_COVERAGE));
  if (distinctSessionDays(points) < requiredDays) return null;

  // Splice today's dense 1D session (the same curve the 1D graph paints) onto the
  // settled-days springboard, keeping only its current-day portion so it can never
  // overwrite a settled point. Real today bars replace any week-tail value at the
  // same instant. Falls back to the single live-tip bridge when none is supplied.
  const today = (input.todayCurve ?? []).filter((p) => p.t >= todayStartMs);
  if (today.length > 0) {
    points = [...points, ...today].sort((a, b) => a.t - b.t);
  } else {
    const marketOpen = isUsMarketOpen(now);
    const tipT = marketOpen ? now.getTime() : sessionCloseMs(last);
    if (input.liveTip) points = appendLiveTip(points, tipT, input.liveTip);
  }

  return points.length >= 2 ? points : null;
}

/** Re-exported so callers don't reach past this module for the series shape. */
export type { ExportLiveGraphSeries };
