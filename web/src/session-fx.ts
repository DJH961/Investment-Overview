/**
 * How EUR/USD FX is wired into the value graphs across the market-hours boundary.
 *
 * The book is **USD-booked** (spot prices arrive in USD) but the owner lives in
 * the euro zone, so the EUR view of the portfolio re-marks at the live EUR/USD
 * spot. FX trades ~24h while the US equity session is only 09:30–16:00 ET, so
 * the EUR value keeps drifting **after the market has closed** even though every
 * security price is frozen at its settled close.
 *
 * That after-hours drift must be handled differently per graph:
 *
 *   - The **1D** and **1W** curves draw a *market-day trajectory*. Once the
 *     session has shut they should sit still — re-marking them at every
 *     after-hours FX tick would shift the whole euro line up and down overnight,
 *     which is not something that happened *during* the trading day. So while the
 *     market is closed these curves are anchored to the **session-close FX**
 *     ({@link graphAnchorFx}), frozen for the night.
 *   - The longer **history** graphs (1M/3M/…/All, the equity curve) and the
 *     headline total always value at the **live** after-hours spot, so the euro
 *     figure the user sees is genuinely current.
 *
 * The gap between those two — the headline EUR total (live FX) minus the
 * session-close EUR total (frozen FX) — is exactly the *overnight* FX P/L, which
 * {@link fxEffectSplit} isolates from the in-session FX move so the user can see
 * what shifted during the trading day versus what changed overnight.
 *
 * ## The "today" cutoff
 *
 * Every "today" signal on the hero — the price move badge, the FX `% today`
 * ({@link fxTodayDeviationPct}) and this market-hours/overnight split — resets at
 * the **prior NYSE session close (16:00 ET)**, the same clock the rest of the
 * dashboard already calls "today". So the market-hours slice spans *prior close →
 * this session's close* and the overnight slice spans *this session's close →
 * live spot*; the moment the next session opens the overnight slice folds back
 * into a single live "today" move. The settled FX baseline we measure that move
 * from is the provider's `previousClose` (its daily settle is the practical proxy
 * for the prior session close — the only always-available dated FX anchor).
 *
 * ## Surviving a market-closed / empty / not-live-at-close start
 *
 * The running session-close rate is captured live (see {@link recordSessionCloseFx}),
 * but the app may simply **not be open at 16:00 ET** — over a weekend, or on a
 * cold start from wiped storage. The two consumers degrade differently so that a
 * missing capture is *protected*, never fabricated:
 *
 *   - The **1D/1W graph freeze** ({@link graphAnchorFx}) must still hold the EUR
 *     curve still overnight, so when no live close was captured it falls back to
 *     the settled `previousClose` — a real, stable, non-drifting rate (on a
 *     weekend it *is* the session's close) — and only then to the live rate. This
 *     is precisely the not-live scenario, where the app was absent during the
 *     session so no capture exists.
 *   - The **attribution split** ({@link fxEffectSplit}) stays honest: it needs a
 *     genuine session close to draw the market-hours/overnight boundary. The app
 *     resolves that close from the session's own FX bars where possible (a real,
 *     dated rate that exists even on a cold start), and only otherwise from the
 *     live capture; with neither it returns `null` (the UI shows nothing) rather
 *     than blaming the whole move on "overnight".
 *
 * All maths is pure {@link Decimal} (no DOM, no storage); the two tiny
 * localStorage helpers at the bottom are the only side-effecting part and are
 * guarded so they never throw in a private-mode / storage-less context.
 */

import { Decimal } from "./decimal-config";
import type { Bar } from "./timeseries";

/**
 * The EUR→USD rate the **live 1D/1W graphs** should anchor their EUR view to.
 *
 * While the regular session is open the live spot *is* the session's rate, so it
 * is used directly. Once the market has closed the curves freeze so the
 * market-day trajectory does not slide with overnight FX:
 *
 *   1. the live-captured `sessionCloseFx` (the rate as the session settled) when
 *      we held the app open through the close;
 *   2. else the settled `settledPrevFx` (the provider's `previousClose`) — a
 *      real, non-drifting rate that, on a weekend / cold start, *is* the session
 *      close, so the freeze still works when the app was **not live** at 16:00 ET
 *      or is rebuilding from empty storage;
 *   3. else, as a last resort, the live rate — the same behaviour as before this
 *      freezing existed.
 *
 * Anchoring to a settled rate (1 or 2) over the live one matters only for the
 * curve's *stability*; the honest market-hours/overnight attribution in
 * {@link fxEffectSplit} deliberately still requires the genuine `sessionCloseFx`.
 */
export function graphAnchorFx(opts: {
  marketOpen: boolean;
  liveFx: Decimal | null;
  sessionCloseFx: Decimal | null;
  /** The provider's settled previous close, used as a stable freeze fallback. */
  settledPrevFx?: Decimal | null;
}): Decimal | null {
  if (opts.marketOpen) return opts.liveFx;
  const settledPrev =
    opts.settledPrevFx != null && opts.settledPrevFx.greaterThan(0) ? opts.settledPrevFx : null;
  return opts.sessionCloseFx ?? settledPrev ?? opts.liveFx;
}

/**
 * The session's settled EUR→USD close read **straight from the FX bars the live
 * curve is built from** — the authoritative source for {@link graphAnchorFx}'s
 * `sessionCloseFx`.
 *
 * The live 1D/1W graphs already fetch / reconstruct a per-minute EUR→USD bar
 * series for the session (stored alongside the price bars), so the rate as the
 * session settled is sitting right there in the data — no separate live capture
 * needed. Reading the close from the bars means the **same procedure works for
 * both graphs** and, crucially, still yields a close when the app was never open
 * at 16:00 ET (the bars are backfilled regardless of whether we were live).
 *
 * Picks the latest bar **at or before** `sessionCloseMs` (the session's 16:00 ET
 * settle); bars after that are after-hours FX drift, exactly what the freeze is
 * meant to exclude, so they are ignored. Returns `null` when no positive bar had
 * settled by the close, leaving the caller to fall back.
 */
export function sessionCloseFxFromBars(fxBars: Bar[], sessionCloseMs: number): Decimal | null {
  let best: Bar | null = null;
  for (const bar of fxBars) {
    if (bar.t > sessionCloseMs) continue;
    if (!bar.value.greaterThan(0)) continue;
    if (best === null || bar.t > best.t) best = bar;
  }
  return best ? best.value : null;
}

/**
 * The single completeness primitive both the price and FX session tracks share:
 * does any positive bar land at or after `sessionCloseMs − toleranceMs`?
 *
 * A session track stored on the device is "complete for the day" once it carries
 * a bar that reaches the session close — anything short of that was last fetched
 * mid-session and ends early, so reading "the close" off it silently returns a
 * stale mid-session value (see scenarios C/F in the 1D-graph investigation). The
 * two tracks differ only in how close to 16:00 ET their last genuine bar lands,
 * which is exactly what `toleranceMs` expresses:
 *
 *   - **FX** (`toleranceMs = 0`): EUR/USD trades on past the 16:00 ET equity
 *     close, so a track fetched once the session shut always carries a bar **at
 *     or after** the close — the presence of one is the exact "the close itself
 *     is captured" signal (see {@link sessionFxBarsComplete}).
 *   - **Price** (`toleranceMs ≈ one bar interval`): the equity feed stops at the
 *     close, so a fully-fetched session's *last* bar sits within one bar interval
 *     **before** 16:00 ET (e.g. a 15:55 five-minute bar, or a 15:00–16:00 hourly
 *     bar). Allowing one interval of slack therefore reads a whole session as
 *     complete while still flagging a stale partial-day fetch (the 14:00 tail in
 *     scenario F), whose newest bar is more than an interval shy of the close.
 *
 * Bars need not be sorted. An empty track is incomplete by definition.
 */
export function sessionTrackReachedClose(
  bars: Bar[],
  sessionCloseMs: number,
  toleranceMs = 0,
): boolean {
  const floor = sessionCloseMs - toleranceMs;
  for (const bar of bars) {
    if (bar.t >= floor && bar.value.greaterThan(0)) return true;
  }
  return false;
}

/**
 * Whether the stored 1D EUR→USD bar track has actually reached the session close.
 *
 * The freeze anchor and the hero currency-effect split both read "the close"
 * from these bars via {@link sessionCloseFxFromBars}, which takes the latest bar
 * **at or before** `sessionCloseMs`. If the FX track was last fetched *during* the
 * session (e.g. the app pulled bars at 15:00 ET) it ends short of the 16:00 close,
 * so `sessionCloseFxFromBars` silently returns that earlier mid-session rate
 * instead of the real settle — an "incomplete" 1D FX bar. Because EUR/USD trades
 * after the equity close, a track that *was* fetched once the session shut always
 * carries a bar at or after `sessionCloseMs`; the presence of one is therefore the
 * exact signal that the close itself is captured.
 *
 * Returns `true` only when a positive bar lands at or after `sessionCloseMs`, so
 * the after-hours start prefetch can detect a still-incomplete track and complete
 * it (see `App.prefetchSessionFx`). An empty track is incomplete by definition.
 * A thin wrapper over {@link sessionTrackReachedClose} with **zero** tolerance,
 * since after-hours FX always prints a bar at or past the close.
 */
export function sessionFxBarsComplete(fxBars: Bar[], sessionCloseMs: number): boolean {
  return sessionTrackReachedClose(fxBars, sessionCloseMs, 0);
}

/**
 * Whether the stored 1D **price** bars for a symbol have reached the session
 * close — the equity-feed sibling of {@link sessionFxBarsComplete}.
 *
 * Unlike FX, the price feed stops printing at 16:00 ET, so a complete session's
 * newest bar lands within one bar interval *before* the close; `barIntervalMs`
 * (the cadence the curve was fetched at) is the allowed slack. A symbol last
 * fetched mid-session (its newest bar more than an interval shy of 16:00) reads
 * **incomplete**, so the after-close backfill knows to re-pull it and complete
 * the missing tail rather than leaving the 1D curve ending early (scenario F).
 */
export function sessionBarsComplete(
  bars: Bar[],
  sessionCloseMs: number,
  barIntervalMs: number,
): boolean {
  return sessionTrackReachedClose(bars, sessionCloseMs, barIntervalMs);
}

/** Today's FX revaluation split into its in-session and after-hours slices. */
export interface FxEffectSplit {
  /** The whole EUR P/L from today's EUR/USD move (prior close → now). */
  totalEur: Decimal | null;
  /** The slice that moved while the market was open (prior close → session close). */
  marketHoursEur: Decimal | null;
  /** The slice that moved after the close (session close → now). Zero while open. */
  overnightEur: Decimal | null;
}

/**
 * Split today's FX revaluation into the part that moved **during the trading
 * day** and the part that moved **overnight** (after the session closed).
 *
 * The after-hours slice is the EUR impact of the rate drifting from the
 * session-close rate to the live rate on the current USD book:
 * `valueUsd · (1/liveFx − 1/closeFx)` — i.e. the EUR total at the live spot minus
 * the EUR total at the frozen close spot. The in-session slice is then simply the
 * remainder of `todayFxMoveEur` (which spans the prior close to now). While the
 * market is open there is no overnight slice yet, so the whole move is in-session.
 *
 * Every field degrades to `null` when its inputs are missing (no USD exposure, no
 * rate pair, or no FX move) so the UI shows "—" rather than a misleading zero.
 */
export function fxEffectSplit(opts: {
  marketOpen: boolean;
  totalValueUsd: Decimal | null;
  liveFx: Decimal | null;
  sessionCloseFx: Decimal | null;
  todayFxMoveEur: Decimal | null;
}): FxEffectSplit {
  const { marketOpen, totalValueUsd, liveFx, sessionCloseFx, todayFxMoveEur } = opts;
  const totalEur = todayFxMoveEur;

  let overnightEur: Decimal | null = marketOpen ? new Decimal(0) : null;
  if (
    !marketOpen &&
    totalValueUsd !== null &&
    liveFx !== null &&
    sessionCloseFx !== null &&
    liveFx.greaterThan(0) &&
    sessionCloseFx.greaterThan(0)
  ) {
    const eurAtLive = totalValueUsd.dividedBy(liveFx);
    const eurAtClose = totalValueUsd.dividedBy(sessionCloseFx);
    overnightEur = eurAtLive.minus(eurAtClose);
  }

  let marketHoursEur: Decimal | null = null;
  if (totalEur !== null) {
    marketHoursEur = overnightEur === null ? totalEur : totalEur.minus(overnightEur);
  }

  return { totalEur, marketHoursEur, overnightEur };
}

/** localStorage key holding the most recent session's close EUR/USD rate. */
const SESSION_CLOSE_FX_KEY = "iv.web.sessionCloseFx";

/**
 * Remember the live EUR/USD spot as the running close for `day` while the market
 * is open. Called on every open-market refresh, the last value written before
 * 16:00 ET is the session-close rate the closed-market graphs then freeze to.
 * A no-op (swallowed) when storage is unavailable — freezing simply degrades to
 * the live rate in that case.
 */
export function recordSessionCloseFx(day: string, rate: Decimal | null): void {
  if (rate === null || !rate.greaterThan(0)) return;
  try {
    localStorage.setItem(SESSION_CLOSE_FX_KEY, JSON.stringify({ day, rate: rate.toString() }));
  } catch {
    // Storage-less (private mode, disabled): freezing falls back to the live rate.
  }
}

/**
 * Read back the stored session-close EUR/USD rate, but only when it was captured
 * for the session `day` we are displaying — a rate from an earlier session is not
 * the close of *this* one, so it is ignored (the caller then uses the live rate).
 * Returns null when nothing usable is stored.
 */
export function readSessionCloseFx(day: string): Decimal | null {
  try {
    const raw = localStorage.getItem(SESSION_CLOSE_FX_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { day?: unknown; rate?: unknown };
    if (parsed.day !== day || typeof parsed.rate !== "string") return null;
    const rate = new Decimal(parsed.rate);
    return rate.greaterThan(0) ? rate : null;
  } catch {
    return null;
  }
}
