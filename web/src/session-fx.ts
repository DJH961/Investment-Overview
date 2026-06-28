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
 *
 * **Completeness gate.** A track last fetched *during* the session (e.g. the app
 * pulled FX at 14:00 ET) ends short of the close, so its "latest bar at or before
 * close" is a stale mid-session rate, not the settle. Handing that real, positive,
 * non-`null` value back would short-circuit the `sessionCloseFx ?? settledPrev ??
 * liveFx` fallback in {@link graphAnchorFx} (and the equivalent anchor in
 * {@link fxEffectSplit}), freezing the EUR view to the 14:00 rate. So unless a
 * positive bar has actually reached the close ({@link sessionFxBarsComplete}, i.e.
 * {@link sessionTrackReachedClose} with zero tolerance — after-hours FX always
 * prints a bar at/after 16:00 ET once the session has settled), the read yields
 * `null` and the caller degrades gracefully to the settled previous close / live
 * spot rather than displaying a wrong, frozen mid-session value.
 */
export function sessionCloseFxFromBars(fxBars: Bar[], sessionCloseMs: number): Decimal | null {
  // Incomplete (mid-session-only) track ⇒ no genuine settle to read: yield null
  // so the caller's settledPrev/liveFx fallback handles it (see doc above).
  if (!sessionTrackReachedClose(fxBars, sessionCloseMs, 0)) return null;
  let best: Bar | null = null;
  for (const bar of fxBars) {
    if (bar.t > sessionCloseMs) continue;
    if (!bar.value.greaterThan(0)) continue;
    if (best === null || bar.t > best.t) best = bar;
  }
  return best ? best.value : null;
}

/**
 * The session's EUR→USD rate **at the open**, read straight from the same 1D FX
 * bars `sessionCloseFxFromBars` reads the close from — the live market-hours
 * anchor the hero's currency-effect split measures from while the session is
 * running (so last night's overnight slice can be carved out as the remainder and
 * survive the market start; see {@link fxEffectSplit}).
 *
 * Picks the **earliest** positive bar at or after `sessionOpenMs` (09:30 ET);
 * earlier pre-market bars are ignored. Returns `null` when no positive bar had
 * printed by/after the open (e.g. a cold start before the session's first FX bar
 * landed), leaving the caller to hide the split rather than fabricate a slice.
 */
export function sessionOpenFxFromBars(fxBars: Bar[], sessionOpenMs: number): Decimal | null {
  let best: Bar | null = null;
  for (const bar of fxBars) {
    if (bar.t < sessionOpenMs) continue;
    if (!bar.value.greaterThan(0)) continue;
    if (best === null || bar.t < best.t) best = bar;
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
 * Whether the stored 1D EUR→USD bar track is **missing the anchor the hero
 * currency KPI needs for the current market phase** — the single freshness signal
 * the data orchestrator's `fxBars` leg keys on so the KPI is fed its session
 * open/close rate in every phase (no longer via an ad-hoc after-hours side pipe).
 *
 * The two faces of the currency KPI ("Currency effect" in EUR, "Investing power"
 * in USD) and their market-hours/overnight split read the session's open and close
 * EUR→USD straight from this bar track ({@link sessionOpenFxFromBars} /
 * {@link sessionCloseFxFromBars}). The bar is the authoritative anchor the live
 * 1D/1W graphs also freeze to, so completing it keeps the KPI and the graphs in
 * lock-step. The anchor a phase needs differs:
 *
 *   - **closed** — the day's **close** must be captured: the track has not reached
 *     16:00 ET ⇒ missing. (Mirrors the old `fxIncomplete` after-hours signal.)
 *   - **open** — the session **open** anchors the live market-hours slice. Missing
 *     once enough of the session has elapsed for an open bar to exist
 *     (`warmingUp === false`) and no positive bar has printed since 09:30 ET. While
 *     the session is still warming up the captured live spot stands in, so no pull
 *     is forced (it would chase a bar the provider has not printed yet).
 *
 * Pure and clock-injected, so the leg decision is unit-testable in isolation.
 */
export function sessionFxAnchorMissing(opts: {
  fxBars: Bar[];
  marketClosed: boolean;
  warmingUp: boolean;
  sessionOpenMs: number;
  sessionCloseMs: number;
}): boolean {
  // Back-compat thin wrapper over the unified {@link fxAnchorCompleteness}
  // predicate: reports only the session open/close anchors, treating the
  // prior-session baseline as already on hand so this legacy signal is unchanged.
  // New callers should use {@link fxAnchorCompleteness} so the prevFx anchor and
  // the consolidated backfill window are accounted for too.
  return fxAnchorCompleteness({ ...opts, prevAnchorAvailable: true }).anyMissing;
}

/** Which of the hero currency KPI's FX anchors the device is missing this phase. */
export interface FxAnchorNeeds {
  /** The session **open** EUR→USD (live market-hours anchor) — open phase only. */
  open: boolean;
  /** The session **close** EUR→USD (frozen anchor) — closed phase only. */
  close: boolean;
  /**
   * The **prior-session close** EUR→USD (the "since yesterday" baseline, prevFx) —
   * closed phase only. Missing on a wiped, forex-frozen cold start where the live
   * `previousClose` is `null` and nothing on the device carries Thursday's close.
   */
  prev: boolean;
}

/**
 * The result of {@link fxAnchorCompleteness}: which anchors are missing, whether
 * any backfill is due at all, and how far back the single consolidated FX pull
 * must reach to recover them.
 */
export interface FxAnchorCompleteness {
  /** Per-anchor missing flags for the current market phase. */
  needs: FxAnchorNeeds;
  /** Any anchor missing — the single signal the orchestrator's `fxBars` leg gates on. */
  anyMissing: boolean;
  /**
   * Trading sessions the consolidated FX backfill must span to cover the missing
   * anchors: `1` = the current session only (open/close anchors), `2` = reach back
   * to also fetch the prior session's close (when prevFx is the gap).
   */
  sessionsBack: number;
}

/**
 * The **single phase-aware predicate** for the hero currency KPI's FX-bar
 * anchors — the one choke point that decides, for the current market phase, which
 * of the four EUR→USD anchors (live spot, prior-session close, session open,
 * session close) the device is still missing and drives one consolidated backfill
 * (see `docs/fx_kpi_cold_start_regeneration_plan.md` §5 and
 * `docs/tiingo_fx_settled_spot_plan.md` §6).
 *
 * It replaces the scattered per-leg gates (the old open/close-only
 * {@link sessionFxAnchorMissing} plus the separately-handled prevFx baseline) with
 * one decision, so the leg gates can never drift apart on what "fresh" means in a
 * given phase. The anchor a phase needs differs:
 *
 *   - **closed** — the day's **close** must be captured (the track has not reached
 *     16:00 ET ⇒ missing) *and* the **prior-session close** baseline must be on the
 *     device. The live feed is frozen, so a wiped device with no persisted close
 *     and no covering 1W FX bar (`prevAnchorAvailable === false`) cannot derive the
 *     "since yesterday" anchor without reaching back one session.
 *   - **open** — the session **open** anchors the live market-hours slice; missing
 *     once enough of the session has elapsed (`warmingUp === false`) and no positive
 *     bar has printed since 09:30 ET. The live forex feed supplies `previousClose`
 *     while open, so prevFx is never the cold-start gap then.
 *
 * Pure and clock-injected (the caller resolves `prevAnchorAvailable` from the
 * persisted close / 1W FX track), so the whole decision is unit-testable.
 */
export function fxAnchorCompleteness(opts: {
  fxBars: Bar[];
  marketClosed: boolean;
  warmingUp: boolean;
  sessionOpenMs: number;
  sessionCloseMs: number;
  /**
   * Whether a prior-session close baseline is already on the device — a persisted
   * `prevSessionCloseFx`, or a covering bar in the 1W FX track. When `true` the
   * `prev` anchor never forces a (wider, +1-credit) pull.
   */
  prevAnchorAvailable: boolean;
}): FxAnchorCompleteness {
  const close = opts.marketClosed && !sessionFxBarsComplete(opts.fxBars, opts.sessionCloseMs);
  const open =
    !opts.marketClosed &&
    !opts.warmingUp &&
    sessionOpenFxFromBars(opts.fxBars, opts.sessionOpenMs) === null;
  const prev = opts.marketClosed && !opts.prevAnchorAvailable;
  const needs: FxAnchorNeeds = { open, close, prev };
  const anyMissing = open || close || prev;
  // Recovering the prior-session close needs a two-session window (Thursday→Friday);
  // every other anchor lives in the current session, so one session suffices.
  const sessionsBack = prev ? 2 : 1;
  return { needs, anyMissing, sessionsBack };
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
  /**
   * The slice that moved while the market was open. Live while open (session
   * open → now); the frozen last-session move (prior close → session close) once
   * shut.
   */
  marketHoursEur: Decimal | null;
  /**
   * The slice that moved after-hours. Live once shut (session close → now); the
   * frozen last overnight (prior close → session open) while open.
   */
  overnightEur: Decimal | null;
}

/**
 * Split today's FX revaluation into its **market-hours** and **overnight** parts,
 * always carving out the *currently-live* slice directly from the relevant
 * session anchor and leaving the other as the remainder so the two sum to the
 * whole move (`todayFxMoveEur`, prior close → now):
 *
 *   - **Market open** — the live leg is the **market-hours** drift since the
 *     session opened: `valueUsd · (1/liveFx − 1/sessionOpenFx)`. The remainder is
 *     *last* night's frozen overnight slice, so it **survives the market start**
 *     instead of folding to zero. Needs `sessionOpenFx`.
 *   - **Market closed** — the live leg is the **overnight** drift since the close:
 *     `valueUsd · (1/liveFx − 1/sessionCloseFx)`. The remainder is the *last*
 *     session's frozen market-hours move. Needs `sessionCloseFx`.
 *
 * Every field degrades to `null` when its inputs are missing (no USD exposure, no
 * rate pair, or no FX move) so the UI shows "—" rather than a misleading zero.
 * When the live anchor is missing the whole move falls back into the live leg and
 * the frozen leg is `null`, so the UI hides the split rather than inventing a zero
 * counterpart.
 */
export function fxEffectSplit(opts: {
  marketOpen: boolean;
  totalValueUsd: Decimal | null;
  liveFx: Decimal | null;
  sessionCloseFx: Decimal | null;
  todayFxMoveEur: Decimal | null;
  /** EUR→USD around the current session's open — the live market-hours anchor. */
  sessionOpenFx?: Decimal | null;
}): FxEffectSplit {
  const { marketOpen, totalValueUsd, liveFx, sessionCloseFx, todayFxMoveEur, sessionOpenFx } = opts;
  const totalEur = todayFxMoveEur;

  // EUR impact of the rate drifting from `anchorFx` to the live spot on the book.
  const legFromAnchor = (anchorFx: Decimal | null | undefined): Decimal | null => {
    if (
      totalValueUsd === null ||
      liveFx === null ||
      !liveFx.greaterThan(0) ||
      anchorFx === null ||
      anchorFx === undefined ||
      !anchorFx.greaterThan(0)
    ) {
      return null;
    }
    return totalValueUsd.dividedBy(liveFx).minus(totalValueUsd.dividedBy(anchorFx));
  };

  let marketHoursEur: Decimal | null;
  let overnightEur: Decimal | null;

  if (marketOpen) {
    // Live leg = market hours (session open → now); frozen leg = last overnight.
    const liveLeg = legFromAnchor(sessionOpenFx);
    if (liveLeg === null) {
      marketHoursEur = totalEur;
      overnightEur = null;
    } else {
      marketHoursEur = liveLeg;
      overnightEur = totalEur === null ? null : totalEur.minus(liveLeg);
    }
  } else {
    // Live leg = overnight (session close → now); frozen leg = last market hours.
    const liveLeg = legFromAnchor(sessionCloseFx);
    if (liveLeg === null) {
      // Whole move falls into the live (overnight) leg; the frozen market-hours
      // leg is null — mirroring fxBuyingPowerSplit and the docstring contract.
      overnightEur = totalEur;
      marketHoursEur = null;
    } else {
      overnightEur = liveLeg;
      marketHoursEur = totalEur === null ? null : totalEur.minus(liveLeg);
    }
  }

  return { totalEur, marketHoursEur, overnightEur };
}

/**
 * The investing-power equivalent of {@link FxEffectSplit}, expressed in **USD**:
 * how many more (+) or fewer (−) dollars the owner's regular EUR investment
 * amount buys now versus yesterday's close, split into the same market-hours and
 * overnight legs.
 */
export interface FxBuyingPowerSplit {
  /** Whole USD buying-power change on the notional (prior close → now). */
  totalUsd: Decimal | null;
  /** The slice earned/lost while the market was open (live while open). */
  marketHoursUsd: Decimal | null;
  /** The slice earned/lost after-hours (live once shut). */
  overnightUsd: Decimal | null;
}

/**
 * Split the **buying-power** change on a fixed EUR notional into its
 * market-hours and overnight legs, mirroring {@link fxEffectSplit} but for the
 * owner's regular investment amount rather than the whole book.
 *
 * Because the notional is a fixed number of euros, the dollars it buys are
 * simply `amountEur · fx`, so each leg is the *difference* in dollars bought
 * across the relevant rate move:
 *
 *   - whole move (prior close → now): `amountEur · (liveFx − prevFx)`;
 *   - **market open** — the live leg is market hours since the session open:
 *     `amountEur · (liveFx − openFx)`; the remainder is last night's frozen
 *     overnight leg, so it survives the market start;
 *   - **market closed** — the live leg is the overnight drift since the close:
 *     `amountEur · (liveFx − closeFx)`; the remainder is the last session's
 *     frozen market-hours leg.
 *
 * A positive figure means the euro strengthened, so the same euros buy *more*
 * dollars to invest. Every field degrades to `null` when its inputs are missing
 * so the UI hides the split rather than inventing a misleading zero.
 */
export function fxBuyingPowerSplit(opts: {
  marketOpen: boolean;
  amountEur: Decimal | null;
  liveFx: Decimal | null;
  prevFx: Decimal | null;
  sessionCloseFx: Decimal | null;
  sessionOpenFx?: Decimal | null;
}): FxBuyingPowerSplit {
  const { marketOpen, amountEur, liveFx, prevFx, sessionCloseFx, sessionOpenFx } = opts;

  const usableAmount =
    amountEur !== null && amountEur.isFinite() && amountEur.greaterThan(0) ? amountEur : null;
  const liveOk = liveFx !== null && liveFx.greaterThan(0);

  const totalUsd =
    usableAmount === null || !liveOk || prevFx === null || !prevFx.greaterThan(0)
      ? null
      : usableAmount.times(liveFx.minus(prevFx));

  // USD bought now minus USD bought at `anchorFx`, on the fixed EUR notional.
  const legFromAnchor = (anchorFx: Decimal | null | undefined): Decimal | null => {
    if (
      usableAmount === null ||
      !liveOk ||
      anchorFx === null ||
      anchorFx === undefined ||
      !anchorFx.greaterThan(0)
    ) {
      return null;
    }
    return usableAmount.times(liveFx!.minus(anchorFx));
  };

  let marketHoursUsd: Decimal | null;
  let overnightUsd: Decimal | null;

  if (marketOpen) {
    const liveLeg = legFromAnchor(sessionOpenFx);
    if (liveLeg === null) {
      marketHoursUsd = totalUsd;
      overnightUsd = null;
    } else {
      marketHoursUsd = liveLeg;
      overnightUsd = totalUsd === null ? null : totalUsd.minus(liveLeg);
    }
  } else {
    const liveLeg = legFromAnchor(sessionCloseFx);
    if (liveLeg === null) {
      overnightUsd = totalUsd;
      marketHoursUsd = null;
    } else {
      overnightUsd = liveLeg;
      marketHoursUsd = totalUsd === null ? null : totalUsd.minus(liveLeg);
    }
  }

  return { totalUsd, marketHoursUsd, overnightUsd };
}


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

/** localStorage key holding the *first* live EUR/USD spot seen this session. */
const SESSION_OPEN_FX_KEY = "iv.web.sessionOpenFx";

/**
 * Remember the **first** live EUR/USD spot we observe for `day` while the market
 * is open, as a stand-in session-open rate for the gap before the session's own
 * FX bars have been fetched (the first FX bar can lag the 09:30 ET open by minutes
 * on the free tier, and a cold start mid-session has none yet). Only the earliest
 * value for the day is kept — later refreshes never overwrite it — so it stays a
 * fixed open anchor rather than tracking the live spot. The authoritative
 * bar-read open ({@link sessionOpenFxFromBars}) takes precedence once available,
 * so this is a self-correcting fallback. A no-op (swallowed) when storage is
 * unavailable.
 */
export function recordSessionOpenFx(day: string, rate: Decimal | null): void {
  if (rate === null || !rate.greaterThan(0)) return;
  try {
    // Keep only the earliest capture for the day — it is the open proxy, not the
    // running spot — so an already-stored same-day rate is left untouched.
    if (readSessionOpenFx(day) !== null) return;
    localStorage.setItem(SESSION_OPEN_FX_KEY, JSON.stringify({ day, rate: rate.toString() }));
  } catch {
    // Storage-less (private mode, disabled): the split simply waits for FX bars.
  }
}

/**
 * Read back the stored first-seen session-open EUR/USD rate, but only when it was
 * captured for the session `day` we are displaying — a rate from an earlier
 * session is not the open of *this* one, so it is ignored. Returns null when
 * nothing usable is stored.
 */
export function readSessionOpenFx(day: string): Decimal | null {
  try {
    const raw = localStorage.getItem(SESSION_OPEN_FX_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { day?: unknown; rate?: unknown };
    if (parsed.day !== day || typeof parsed.rate !== "string") return null;
    const rate = new Decimal(parsed.rate);
    return rate.greaterThan(0) ? rate : null;
  } catch {
    return null;
  }
}

/** localStorage key holding the last known *prior-session* EUR/USD close. */
const PREV_SESSION_CLOSE_FX_KEY = "iv.web.prevSessionCloseFx";

/**
 * Remember the settled **prior-session** EUR/USD close (the "yesterday" baseline
 * the hero currency KPI measures its "since yesterday" move from), keyed by the
 * trading session `day` it closes. Called whenever the live FX provider returns a
 * genuine previous close, so the value is the authoritative settled rate.
 *
 * This is the persistence half of the KPI's weekend / cold-start safety net: over
 * a forex-closed weekend (and on a cold start before the provider can re-confirm
 * it) the live `previousClose` comes back `null`, which would otherwise collapse
 * the KPI's "since yesterday" anchor to zero and force the panel onto its
 * session-close fallback. Persisting the last good close lets {@link readPrevSessionCloseFx}
 * restore the real baseline so the EUR and USD faces both keep a true "yesterday".
 * A no-op (swallowed) when storage is unavailable.
 */
export function recordPrevSessionCloseFx(day: string, rate: Decimal | null): void {
  if (rate === null || !rate.greaterThan(0)) return;
  try {
    localStorage.setItem(PREV_SESSION_CLOSE_FX_KEY, JSON.stringify({ day, rate: rate.toString() }));
  } catch {
    // Storage-less (private mode, disabled): the KPI simply falls back as before.
  }
}

/**
 * Read back the persisted prior-session EUR/USD close, but only when it was
 * captured for the session `day` the caller is now treating as "yesterday" — a
 * close from an older session is not the baseline for *this* one, so it is ignored
 * (the caller then degrades exactly as it did before). Returns null when nothing
 * usable is stored.
 */
export function readPrevSessionCloseFx(day: string): Decimal | null {
  try {
    const raw = localStorage.getItem(PREV_SESSION_CLOSE_FX_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { day?: unknown; rate?: unknown };
    if (parsed.day !== day || typeof parsed.rate !== "string") return null;
    const rate = new Decimal(parsed.rate);
    return rate.greaterThan(0) ? rate : null;
  } catch {
    return null;
  }
}
