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
} from "./market-hours";
import type { CurvePoint } from "./timeseries";
import type { ExportLiveCurvePoint, ExportLiveGraphSeries, ExportLiveGraphs } from "./types";
import { DEFAULT_WEEK_SESSIONS } from "./week";

/** Epoch-ms of a `YYYY-MM-DD` New-York session at UTC midnight (window floor). */
function dayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
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
 * rolled out when the window advanced), then the curve is bridged to the live
 * tip — at `now` while open, or the last settled session's close once shut — so
 * a day-old export still ends on today's (or the latest) value.
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
  let points = allPoints.filter((p) => p.t >= windowStartMs);
  if (points.length < 1) return null;

  const marketOpen = isUsMarketOpen(now);
  const tipT = marketOpen ? now.getTime() : sessionCloseMs(last);
  if (input.liveTip) points = appendLiveTip(points, tipT, input.liveTip);

  return points.length >= 2 ? points : null;
}

/** Re-exported so callers don't reach past this module for the series shape. */
export type { ExportLiveGraphSeries };
