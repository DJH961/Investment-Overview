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
 *     genuine captured session close to draw the market-hours/overnight boundary,
 *     so without one it returns `null` (the UI shows nothing) rather than blaming
 *     the whole move on "overnight".
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
