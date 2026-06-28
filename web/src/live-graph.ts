/**
 * Live-graph orchestration — ties the Phase 2–4 curve builders together with the
 * **batched** price backfill (docs/v3.0_live_web_companion_proposal.md §10.8).
 *
 * The 1D ({@link loadOrBuildSessionCurve}) and 1W ({@link loadOrBuildWeekCurve})
 * builders each take an injected `fetchBars`/`fetchDailyBars` (native price bars)
 * and an optional `fetchFx` (EUR→USD bars). Both are assembled from a **single**
 * provider pipe:
 *
 *   - **Prices & FX — one pipe** ({@link makePriceBarFetcher}). With the shared
 *     reservation authority it fills **Twelve Data first** (browser-direct
 *     `time_series`, 1 credit/symbol, the plentiful 8/min pool) and spills the
 *     overflow to **Tiingo** via the unified Worker `/price` route (`?intraday=`
 *     for 1D, `?daily=` for 1W — off Tiingo's scarce hourly budget); without a
 *     reservation it keeps the legacy Tiingo-first dual pipe. The EUR→USD FX track
 *     is simply the `EUR/USD` symbol on that **same** pipe (see
 *     {@link makeFxFetcher}): Tiingo serves it from `?fxHistory=eurusd` while the
 *     rest of the pipe — capacity split, reservation gating, dual-pipe fallback
 *     and per-symbol backoff — applies unchanged, so a back-dated graph re-marks
 *     each point at its **own settled FX rate** (finest available granularity)
 *     instead of a single uniform rescale. There is no separate FX subsystem to
 *     keep in step: any change to the price pipe changes FX automatically.
 *
 * Everything that touches the network (`fetchImpl`, the API key) or persistence
 * (the {@link TimeSeriesStore}) is injected, so the whole orchestration is
 * unit-testable with no DOM, IndexedDB, or live API. When a proxy/key is absent
 * the corresponding leg simply drops out (prices fall back to the other provider;
 * FX falls back to the day's settled `baseFx`), and the graph still draws.
 */

import { fetchTimeSeries, EUR_USD_SYMBOL, PriceError, type FetchLike } from "./prices";
import {
  recordCredits,
  recordTiingoCredits,
  releaseCredits,
  releaseTiingoCredits,
  readSeriesBackoff,
  writeSeriesBackoff,
  clearSeriesBackoff,
  DEFAULT_SERIES_BACKOFF_MS,
  DEFAULT_SERIES_BACKOFF_ATTEMPTS,
  type SeriesBackoffEntry,
  type StorageLike,
} from "./cache";
import {
  lastSessionDate,
  recentTradingSessions,
} from "./market-hours";
import {
  loadOrBuildSessionCurve,
  type BarFetcher,
  type SessionCurve,
  type SessionCurveOptions,
} from "./intraday";
import { makeTiingoBarFetcher, makeDualPipeBarFetcher } from "./intraday-tiingo";
import { type Reservation } from "./reservation";
import type { Bar } from "./timeseries";
import {
  loadOrBuildWeekCurve,
  wrapDailyNavFetcher,
  DEFAULT_WEEK_SESSIONS,
  type WeekCurve,
  type WeekCurveOptions,
} from "./week";

/** An inclusive `YYYY-MM-DD` date window (New-York calendar). */
export interface DateWindow {
  startDate: string;
  endDate: string;
}

/**
 * The window the live 1D curve (and its FX track) covers — the last single
 * session by default. Widen it with `sessionsBack` to reach back over earlier
 * sessions in one request: `sessionFxWindow(now, 2)` spans the prior trading
 * session through the last one (Thursday→Friday over a weekend), the guaranteed
 * path the currency KPI uses to recover the missing prior-session close baseline
 * (`prevFx`) on a wiped, forex-frozen cold start (item 5b).
 */
export function sessionFxWindow(now: Date = new Date(), sessionsBack = 1): DateWindow {
  const day = lastSessionDate(now);
  if (sessionsBack <= 1) return { startDate: day, endDate: day };
  const window = recentTradingSessions(Math.max(1, sessionsBack), now);
  return { startDate: window[0], endDate: window[window.length - 1] };
}

/** The trailing trading-session window the live 1W curve (and FX) covers. */
export function weekFxWindow(
  now: Date = new Date(),
  sessions: number = DEFAULT_WEEK_SESSIONS,
): DateWindow {
  const window = recentTradingSessions(Math.max(1, sessions), now);
  return { startDate: window[0], endDate: window[window.length - 1] };
}

/** A callback that books `n` API credits against a source's budget log. */
export type SpendRecorder = (n: number) => void;

/** Which backfill leg produced a spend — for the data-polling log's leg tag. */
export type SpendLeg = "bars" | "quote";

/** A single backfill request the {@link BackfillMeter} accounts for. */
export interface SpendRequest {
  /** The leg tag (`bars`/`quote`) for the log line. */
  leg: SpendLeg;
  /**
   * The symbols requested (deduped). The EUR→USD FX track rides the `bars` leg as
   * the ordinary `EUR/USD` symbol — there is no separate FX leg.
   */
  symbols: string[];
  /** Worst-case credit cost of the request (1 per symbol). */
  n: number;
}

/**
 * Two-phase credit meter for a live-graph backfill leg
 * (`docs/tiingo_polling_storm_cleanup_plan.md` items 1–3). Every dispatch
 * **reserves** its worst-case cost up-front so concurrent/subsequent calls see
 * the budget already committed and pace themselves; the result is then
 * **settled** (the provider billed it — keep the reservation, log what we
 * pulled) or **refunded** (the provider never metered it — a Worker reject,
 * provider error, or transport throw — so the reservation is released and a
 * labelled failure line is logged instead of leaving a phantom charge).
 */
export interface BackfillMeter {
  /** Debit the worst-case cost before dispatch. */
  reserve(req: SpendRequest): void;
  /** Provider billed the call: keep the reservation; `bars` is the count returned. */
  settle(req: SpendRequest & { bars: number }): void;
  /** Provider did not bill (reject/error/throw): refund and log why. */
  refund(req: SpendRequest & { reason: string; status?: number | null }): void;
}

/** The deduped, non-blank symbol set of a request. */
function uniqueSymbols(symbols: string[]): string[] {
  return [...new Set(symbols.map((s) => s.trim()).filter((s) => s.length > 0))];
}

/** Total bars across a fetched symbol→bars map (to spot a billed-but-empty pull). */
function totalBars(bars: Map<string, Bar[]>): number {
  let n = 0;
  for (const list of bars.values()) n += list.length;
  return n;
}

/** The provider HTTP status behind an error, when it is a {@link PriceError}. */
function errorStatus(err: unknown): number | null {
  return err instanceof PriceError ? err.status : null;
}

/** A short, log-safe description of why a pull was not billed. */
function describeError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

/**
 * Wrap a {@link BarFetcher} in the two-phase {@link BackfillMeter}: reserve one
 * credit per requested symbol up-front, then **settle** (keep) the reservation
 * when the provider returns — even an empty `[]`/`404`, which still reached the
 * meter — or **refund** it when the pipe throws (a Worker `400`/`429`/`502`/`503`
 * reject, provider error, or transport abort that the provider never billed). A
 * fallback after a thrown primary therefore records only the fallback's spend.
 */
export function recordingBarFetcher(
  inner: BarFetcher,
  meter: BackfillMeter,
  leg: SpendLeg = "bars",
): BarFetcher {
  return async (symbols) => {
    const uniq = uniqueSymbols(symbols);
    const n = uniq.length;
    if (n === 0) return new Map<string, Bar[]>();
    meter.reserve({ leg, symbols: uniq, n });
    try {
      const bars = await inner(uniq);
      meter.settle({ leg, symbols: uniq, n, bars: totalBars(bars) });
      return bars;
    } catch (err) {
      meter.refund({ leg, symbols: uniq, n, reason: describeError(err), status: errorStatus(err) });
      throw err;
    }
  };
}

/**
 * The simplest {@link BackfillMeter}: book the reservation against `record` and
 * release a not-billed reservation back via `refund`, with no logging. Used as
 * the default wiring when a caller does not supply an instrumented meter.
 */
export function ledgerMeter(record: SpendRecorder, refund: SpendRecorder): BackfillMeter {
  return {
    reserve: (req) => record(req.n),
    settle: () => undefined,
    refund: (req) => refund(req.n),
  };
}

/**
 * Build the Twelve Data **Pipe A** price {@link BarFetcher} (browser-direct
 * `time_series`, 1 credit/symbol). Returns `null` when no API key is held, so the
 * caller can decide whether a Tiingo-only pipe is still usable.
 */
export function makeTwelveDataBarFetcher(
  apiKey: string,
  options: { interval?: string; outputsize?: number; fetchImpl?: FetchLike } = {},
): BarFetcher | null {
  const key = apiKey.trim();
  if (!key) return null;
  return (symbols) => fetchTimeSeries(symbols, key, options);
}

/**
 * Compose the dual-pipe price backfill: prefer Tiingo (Pipe B, via the unified
 * `/price` Worker proxy) and fall back to Twelve Data (Pipe A) the moment Pipe B
 * is unavailable. The `param` selects the Tiingo feed (`intraday` for the 1D
 * curve, `daily` for the 1W curve). When only one pipe is configured that pipe is
 * used alone; when neither is, `null` is returned (the curve then has no price
 * bars and the builder yields an empty curve).
 */
export function makePriceBarFetcher(opts: {
  apiKey: string;
  proxyUrl: string | null;
  param?: "intraday" | "daily";
  interval?: string;
  outputsize?: number;
  startDate?: string;
  endDate?: string;
  fetchImpl?: FetchLike;
  /** Meter the Tiingo (Pipe B) bar spend in two phases. */
  tiingoMeter?: BackfillMeter;
  /** Meter the Twelve Data (Pipe A) bar spend in two phases. */
  twelveDataMeter?: BackfillMeter;
  /**
   * The single reservation authority (`reservation.ts`, audit Rec 4). When
   * supplied (and both pipes exist), the fetch becomes the capacity-aware split:
   * each leg first {@link Reservation.reserve}s its credits atomically — Twelve
   * Data up to its live per-minute/day budget, then Tiingo for the overflow up to
   * *its* scarce hourly/daily budget (closing audit Flags 1, 5, 6) — and fetches
   * only the granted symbols. Omit to keep the legacy Tiingo-first dual pipe.
   */
  reservation?: Reservation;
  /** Clock for the reservation/freeze reads (tests inject a fixed clock). */
  now?: () => number;
  /**
   * Per-symbol time-series backoff (item 4). When supplied, symbols whose
   * `${scope}:${symbol}` key is in an armed cooldown are skipped (no credit, no
   * attempt) and fall back to their flat quote value on the curve.
   */
  backoff?: { memo: SeriesBackoff; scope: string; now?: () => number };
}): BarFetcher | null {
  const {
    apiKey,
    proxyUrl,
    param,
    interval,
    outputsize,
    startDate,
    endDate,
    fetchImpl,
    tiingoMeter,
    twelveDataMeter,
    reservation,
    now,
    backoff,
  } = opts;
  let pipeA = makeTwelveDataBarFetcher(apiKey, { interval, outputsize, fetchImpl });
  let pipeB = proxyUrl
    ? makeTiingoBarFetcher(proxyUrl, { param, startDate, endDate, fetchImpl })
    : null;
  // Meter each pipe against its own source budget, so whichever one actually
  // serves the bars is the one that books the credits (a fallback after a thrown
  // primary records only the fallback's spend).
  if (pipeA && twelveDataMeter) pipeA = recordingBarFetcher(pipeA, twelveDataMeter);
  if (pipeB && tiingoMeter) pipeB = recordingBarFetcher(pipeB, tiingoMeter);
  let combined: BarFetcher | null;
  if (pipeB && pipeA) {
    // With a reservation authority, fill Twelve Data first and spill the overflow
    // to Tiingo (item 8), both gated by the shared budgets; otherwise keep the
    // legacy Tiingo-first failover dual pipe.
    combined = reservation
      ? makeCapacitySplitBarFetcher(pipeA, pipeB, reservation, now)
      : makeDualPipeBarFetcher(pipeB, pipeA);
  } else {
    combined = pipeB ?? pipeA;
  }
  // The per-symbol backoff sits outermost, scoring the post-fallback result, so a
  // symbol is only parked once *both* providers have failed to serve it.
  if (combined && backoff) {
    return withBarBackoff(combined, backoff.memo, (s) => `${backoff.scope}:${s}`, {
      now: backoff.now,
    });
  }
  return combined;
}

/** Merge two symbol→bars maps; non-empty bars from `extra` win over `base` gaps. */
function mergeBarMaps(base: Map<string, Bar[]>, extra: Map<string, Bar[]>): Map<string, Bar[]> {
  const out = new Map(base);
  for (const [symbol, bars] of extra) {
    if (bars.length > 0) out.set(symbol, bars);
  }
  return out;
}

/** Fetch one provider leg, reporting which requested symbols came back empty/failed. */
async function fetchBarLeg(
  fetcher: BarFetcher,
  symbols: string[],
): Promise<{ bars: Map<string, Bar[]>; missing: string[] }> {
  if (symbols.length === 0) return { bars: new Map<string, Bar[]>(), missing: [] };
  try {
    const bars = await fetcher(symbols);
    const missing = symbols.filter((s) => !(bars.get(s)?.length));
    return { bars, missing };
  } catch (err) {
    // A whole-batch reject (a Worker/provider error) spills every assigned symbol.
    if (err instanceof PriceError) return { bars: new Map<string, Bar[]>(), missing: symbols };
    throw err;
  }
}

/**
 * Capacity-aware provider split for graph bars (price **and** NAV series), item
 * 8 — the reverse of the old Tiingo-first dual pipe. Fill **Twelve Data (Pipe A)**
 * up to the live remaining per-minute/day budget, route the overflow to **Tiingo
 * (Pipe B)** up to *its* scarce hourly/daily budget, and run both legs
 * concurrently so the paint stays instant. A symbol that *fails or comes back
 * empty* on Twelve Data still spills to Tiingo underneath the split, within
 * Tiingo's remaining budget. Rationale: Twelve Data's 8/min replenishes every
 * minute (the plentiful pool) while Tiingo's 40/hour is scarce — so fill the
 * plentiful one first and spend the scarce one only on the overflow.
 *
 * Every leg is gated by the single {@link Reservation} authority (audit Rec 4):
 * each `reserve(provider, n)` **atomically** reads the live shared ledger (after
 * the 429 freeze) *and* debits the grant before the fetch fires, so the overflow
 * can never exceed Tiingo's budget (audit Flags 1, 5) and concurrent legs/builds
 * cannot collectively overshoot (audit Flag 6). A grant of `0` (budget spent or
 * the provider frozen) defers those symbols to a later round rather than firing —
 * the curve tolerates the missing bars and falls back to the flat quote value.
 */
export function makeCapacitySplitBarFetcher(
  twelveData: BarFetcher,
  tiingo: BarFetcher,
  reservation: Reservation,
  now: () => number = () => Date.now(),
): BarFetcher {
  return async (symbols) => {
    const uniq = uniqueSymbols(symbols);
    if (uniq.length === 0) return new Map<string, Bar[]>();
    // Atomic read-and-debit: Twelve Data first, up to its live minute/day budget.
    const tdGrant = reservation.reserve("twelvedata", uniq.length, now());
    const toTwelveData = uniq.slice(0, tdGrant);
    // The overflow goes to Tiingo, but only up to *its* scarce hourly/daily
    // budget — the proactive cap the split never had (audit Flags 1, 5). What
    // neither provider can pay for this round is deferred (not dumped on Tiingo).
    const overflow = uniq.slice(tdGrant);
    const tiGrant = reservation.reserve("tiingo", overflow.length, now());
    const toTiingo = overflow.slice(0, tiGrant);
    const [a, b] = await Promise.all([
      fetchBarLeg(twelveData, toTwelveData),
      fetchBarLeg(tiingo, toTiingo),
    ]);
    let result = mergeBarMaps(a.bars, b.bars);
    // Spill any Twelve Data misses (failed/empty) to Tiingo — within Tiingo's
    // remaining budget — unless the overflow leg already covered them.
    const spillCandidates = a.missing.filter((s) => !(result.get(s)?.length));
    const spillGrant = reservation.reserve("tiingo", spillCandidates.length, now());
    const spill = spillCandidates.slice(0, spillGrant);
    if (spill.length > 0) {
      const spilled = await fetchBarLeg(tiingo, spill);
      result = mergeBarMaps(result, spilled.bars);
    }
    return result;
  };
}

/**
 * Adapt the unified price-bar pipe ({@link makePriceBarFetcher}) into the curve's
 * no-arg `fetchFx`: request the EUR/USD symbol through `fetchBars` so the FX track
 * rides the **exact same** subsystem as every equity symbol — the Twelve-Data-first
 * capacity split, reservation gating, per-symbol backoff and dual-pipe fallback all
 * apply automatically, with no parallel FX pipe to keep in step. Returns just the
 * EUR/USD bars (empty when the pipe yielded none → the curve falls back to the
 * day's settled `baseFx`). `null` when no pipe is configured.
 */
export function makeFxFetcher(
  fetchBars: BarFetcher | null,
): (() => Promise<Bar[]>) | null {
  if (!fetchBars) return null;
  return async () => (await fetchBars([EUR_USD_SYMBOL])).get(EUR_USD_SYMBOL) ?? [];
}

/**
 * A persisted, timestamp-based **time-series backoff** shared by the price-bar
 * and FX-history fetchers (`docs/tiingo_polling_storm_cleanup_plan.md` item 4).
 * It tracks, per `key` (a price symbol or an FX leg), how many consecutive
 * attempts have failed and — once that count crosses the threshold — when the
 * cooldown armed, so a *genuinely dead* series stops being re-pulled on every
 * graph switch while a transient miss is still retried. Quotes are never gated
 * by this; only time-series pulls are.
 */
export interface SeriesBackoff {
  /** True when `key` is in an armed cooldown at `now` (skip the network). */
  suppressed(key: string, now: number): boolean;
  /** Record a failed/empty attempt; arms the cooldown at the Nth strike. */
  fail(key: string, now: number): void;
  /** Forget `key` after a successful, non-empty pull. */
  succeed(key: string): void;
}

/**
 * The shared {@link SeriesBackoff}: an attempt is allowed until it has failed
 * `attempts` times in a row, after which the series is suppressed for
 * `cooldownMs` (wall-clock, persisted). Once that window elapses the strike
 * count resets, so the next rebuild gets a fresh set of attempts.
 */
export function cacheSeriesBackoff(
  options: {
    attempts?: number;
    cooldownMs?: number;
    storage?: StorageLike | null;
  } = {},
): SeriesBackoff {
  const attempts = options.attempts ?? DEFAULT_SERIES_BACKOFF_ATTEMPTS;
  const cooldownMs = options.cooldownMs ?? DEFAULT_SERIES_BACKOFF_MS;
  const storage = options.storage;
  const read = (key: string): SeriesBackoffEntry | null =>
    storage === undefined ? readSeriesBackoff(key) : readSeriesBackoff(key, storage);
  const write = (key: string, entry: SeriesBackoffEntry): void =>
    storage === undefined ? writeSeriesBackoff(key, entry) : writeSeriesBackoff(key, entry, storage);
  const clear = (key: string): void =>
    storage === undefined ? clearSeriesBackoff(key) : clearSeriesBackoff(key, storage);
  return {
    suppressed: (key, now) => {
      const e = read(key);
      return (
        e !== null && e.armedAt !== null && e.fails >= attempts && now - e.armedAt < cooldownMs
      );
    },
    fail: (key, now) => {
      let e = read(key) ?? { fails: 0, armedAt: null };
      // A fully-elapsed cooldown is a fresh window: reset the strike count so the
      // series earns another `attempts` tries before re-arming.
      if (e.armedAt !== null && now - e.armedAt >= cooldownMs) e = { fails: 0, armedAt: null };
      const fails = e.fails + 1;
      const armedAt = fails >= attempts ? now : e.armedAt;
      write(key, { fails, armedAt });
    },
    succeed: (key) => clear(key),
  };
}

/**
 * Wrap a multi-symbol {@link BarFetcher} with a **per-symbol** time-series
 * backoff. Symbols whose `keyFor(symbol)` is in an armed cooldown are dropped
 * before the network call (no credit, no attempt) and are simply absent from the
 * result — so the curve reconstruction holds them flat at their latest **quote**
 * value (`ratioAt` → 1 for a symbol with no bars), the quote fallback. Every
 * fetched symbol is scored: non-empty bars clear its memo, an empty/missing
 * symbol takes a strike, and a whole-batch reject strikes every attempted symbol.
 * Quotes are untouched — only the graph's time-series pulls back off.
 */
export function withBarBackoff(
  inner: BarFetcher,
  backoff: SeriesBackoff,
  keyFor: (symbol: string) => string,
  options: { now?: () => number } = {},
): BarFetcher {
  const now = options.now ?? ((): number => Date.now());
  return async (symbols) => {
    const t = now();
    const uniq = uniqueSymbols(symbols);
    const allowed = uniq.filter((s) => !backoff.suppressed(keyFor(s), t));
    if (allowed.length === 0) return new Map<string, Bar[]>();
    try {
      const bars = await inner(allowed);
      for (const s of allowed) {
        if (bars.get(s)?.length) backoff.succeed(keyFor(s));
        else backoff.fail(keyFor(s), t);
      }
      return bars;
    } catch (err) {
      for (const s of allowed) backoff.fail(keyFor(s), t);
      throw err;
    }
  };
}

/** Shared network/persistence wiring for the live-graph builders. */
export interface LiveGraphProviders {
  /** Twelve Data API key (Pipe A). Empty ⇒ Tiingo-only prices. */
  apiKey: string;
  /** Unified Worker `/price` route (Tiingo prices + FX history). Null ⇒ Twelve Data only. */
  priceProxyUrl: string | null;
  /** Injected fetch (defaults to the global). */
  fetchImpl?: FetchLike;
  /**
   * Meter the Tiingo spend (price bars via Pipe B, plus the FX-history pull).
   * Defaults to the persisted Tiingo credit log (reserve + refund, no logging).
   */
  tiingoMeter?: BackfillMeter;
  /**
   * Meter the Twelve Data spend (price bars via Pipe A). Defaults to the
   * persisted Twelve Data credit log (reserve + refund, no logging).
   */
  twelveDataMeter?: BackfillMeter;
  /**
   * The single reservation authority (`reservation.ts`, audit Rec 4). When
   * supplied, the bar fetch becomes the capacity-aware split (item 8) and the FX
   * legs are gated too: every metered request is reserved against the live shared
   * budgets (Twelve Data per-minute/day + 429 freeze, Tiingo hourly/daily +
   * freeze) before it fires. Omit to keep the legacy Tiingo-first pipe.
   */
  reservation?: Reservation;
  /** Clock for the reservation/freeze reads (tests inject a fixed clock). */
  now?: () => number;
  /**
   * Shared per-symbol time-series backoff (item 4). Defaults to the persisted
   * {@link cacheSeriesBackoff}. Symbols that keep failing are parked off the
   * network and fall back to their flat quote value; quotes are never gated.
   */
  backoff?: SeriesBackoff;
}

/**
 * Resolve the Tiingo/Twelve Data meters. When a {@link Reservation} authority is
 * present it is the sole booker (it debited the grant up-front), so the default
 * meters become **observation-only**: they no longer book on reserve, and a
 * not-billed result releases the reservation instead of the raw ledger. Without
 * a reservation (the legacy dual-pipe path) they book/refund the ledger directly.
 */
function spendMeters(providers: LiveGraphProviders): {
  tiingoMeter: BackfillMeter;
  twelveDataMeter: BackfillMeter;
} {
  const res = providers.reservation;
  const noop = (): void => undefined;
  return {
    tiingoMeter:
      providers.tiingoMeter ??
      ledgerMeter(
        res ? noop : (n) => recordTiingoCredits(n, Date.now()),
        res ? (n) => res.release("tiingo", n, Date.now()) : (n) => releaseTiingoCredits(n, Date.now()),
      ),
    twelveDataMeter:
      providers.twelveDataMeter ??
      ledgerMeter(
        res ? noop : (n) => recordCredits(n, Date.now()),
        res ? (n) => res.release("twelvedata", n, Date.now()) : (n) => releaseCredits(n, Date.now()),
      ),
  };
}

/** Options for {@link instrumentedGraphRecorders}. */
export interface GraphRecorderOptions {
  /** Range label for the log line, e.g. `"1D"` or `"1W"`. */
  range: string;
  /** Reserve a Twelve Data (Pipe A) spend against its budget log. */
  bookTwelveData: SpendRecorder;
  /** Refund a not-billed Twelve Data reservation. */
  refundTwelveData: SpendRecorder;
  /** Reserve a Tiingo (Pipe B / FX) spend against its budget log. */
  bookTiingo: SpendRecorder;
  /** Refund a not-billed Tiingo reservation. */
  refundTiingo: SpendRecorder;
  /** Sink for a plain-language log line (e.g. the Settings polling log). */
  log: (message: string) => void;
  /** Shared counter: total credits this build actually pulled (0 ⇒ all reused). */
  spent: { credits: number };
  /**
   * Two-tier-brake hooks (market_open_token_burn_fix_plan.md WS4/WS5). The meter
   * is the chokepoint that observes each provider's billed/not-billed outcome, so
   * it is where the per-provider 429 circuit breaker is tripped and cleared:
   *  - `onTwelveData429` — a Twelve Data over-quota reject (freeze TD).
   *  - `onTwelveDataSuccess` — a billed Twelve Data call (clear the 429 streak).
   *  - `onTiingo429` — a Tiingo over-quota reject (freeze Tiingo to the next `:00`).
   * All optional; omit to leave the breaker untouched (the default wiring).
   */
  onTwelveData429?: () => void;
  onTwelveDataSuccess?: () => void;
  onTiingo429?: () => void;
}

/** Render a request's subject for the log: the deduped symbol list. */
function spendSubject(req: SpendRequest): string {
  return req.symbols.join(", ");
}

/**
 * Wrap the two graph spend ledgers as instrumented {@link BackfillMeter}s so
 * every live 1D/1W backfill pull is, in one step: (1) reserved against its
 * provider's budget log up-front, (2) on a billed result, tallied into a shared
 * `spent` counter (so the caller can tell a real pull from a fully-reused render)
 * and reported in plain language to `log` — naming the **leg** (`bars`/`quote`)
 * and the **symbols** (the EUR/USD FX track rides the `bars` leg as the ordinary
 * `EUR/USD` symbol) so the data-polling log shows exactly what
 * each graph pulled — and (3) on a not-billed result, refunded *and* logged as a
 * labelled failure, so a Worker reject/empty never leaves a phantom charge or a
 * silent gap. A bar fetch bills one credit per symbol; the EUR/USD FX pull bills
 * one credit like any other symbol.
 */
export function instrumentedGraphRecorders(
  opts: GraphRecorderOptions,
): { twelveDataMeter: BackfillMeter; tiingoMeter: BackfillMeter } {
  const { range, bookTwelveData, refundTwelveData, bookTiingo, refundTiingo, log, spent } = opts;
  const plural = (n: number): string => (n === 1 ? "" : "s");
  const meter = (
    provider: string,
    creditNoun: string,
    book: SpendRecorder,
    refund: SpendRecorder,
    /** Trip the per-provider 429 breaker on an over-quota reject (WS4/WS5). */
    on429?: () => void,
    /** Clear the per-provider 429 streak on a billed result (WS4/WS5). */
    onSuccess?: () => void,
  ): BackfillMeter => ({
    reserve: (req) => book(req.n),
    settle: (req) => {
      spent.credits += req.n;
      onSuccess?.();
      const empty = req.bars === 0 ? " (empty — reached the provider, no bars)" : "";
      log(
        `${range} graph: fetched ${req.leg} ${spendSubject(req)} via ${provider} — ` +
          `${req.n} ${creditNoun}${plural(req.n)}${empty}.`,
      );
    },
    refund: (req) => {
      refund(req.n);
      // A 429 is the authoritative cross-device "out of credits" signal: trip the
      // breaker so this provider is frozen and no further attempt is wasted.
      const breaker = req.status === 429 ? " — circuit breaker armed" : "";
      if (req.status === 429) on429?.();
      log(
        `${range} graph: ${req.leg} ${spendSubject(req)} via ${provider} not billed ` +
          `(${req.n} ${creditNoun}${plural(req.n)} refunded) — ${req.reason}${breaker}.`,
      );
    },
  });
  return {
    twelveDataMeter: meter(
      "Twelve Data (Pipe A)",
      "credit",
      bookTwelveData,
      refundTwelveData,
      opts.onTwelveData429,
      opts.onTwelveDataSuccess,
    ),
    tiingoMeter: meter("Tiingo (Pipe B)", "Tiingo credit", bookTiingo, refundTiingo, opts.onTiingo429),
  };
}

/** Per-bar cadence the 1D price feed (and the EUR/USD FX symbol on it) requests. */
export interface SessionGraphTuning {
  /** Twelve Data `time_series` interval for Pipe A (default `5min`). */
  interval?: string;
  /** Twelve Data `outputsize` for Pipe A (default 78 ≈ a 5-min session). */
  outputsize?: number;
}

/**
 * Build the live **1 Day** curve with both backfills wired in: the unified
 * price-bar pipe (`fetchBars`) and the EUR/USD FX track riding that same pipe
 * (`fetchFx`, via {@link makeFxFetcher}) over the session day. `anchor`, `store`,
 * `now`, `liveTip` and `retainSessions` are passed straight through to
 * {@link loadOrBuildSessionCurve}.
 */
export function buildLiveSessionCurve(
  base: Omit<SessionCurveOptions, "fetchBars" | "fetchFx">,
  providers: LiveGraphProviders,
  tuning: SessionGraphTuning = {},
): Promise<SessionCurve> {
  const now = base.now ?? new Date();
  const window = sessionFxWindow(now);
  const { tiingoMeter, twelveDataMeter } = spendMeters(providers);
  const backoff = providers.backoff ?? cacheSeriesBackoff();
  const priceFetcher = makePriceBarFetcher({
    apiKey: providers.apiKey,
    proxyUrl: providers.priceProxyUrl,
    param: "intraday",
    interval: tuning.interval,
    outputsize: tuning.outputsize,
    startDate: window.startDate,
    endDate: window.endDate,
    fetchImpl: providers.fetchImpl,
    tiingoMeter,
    twelveDataMeter,
    reservation: providers.reservation,
    now: providers.now,
    backoff: { memo: backoff, scope: "1D" },
  });
  const fetchBars = priceFetcher ?? emptyBarFetcher;
  // FX is just the EUR/USD symbol on the very same pipe (see {@link makeFxFetcher}),
  // so it inherits the price split, reservation, fallback and backoff with no
  // parallel FX subsystem to maintain.
  const fetchFx = makeFxFetcher(priceFetcher);
  // The after-close escalation legs (plan C3 / FX parity): a genuinely *second*
  // provider used only for the symbols the primary could not advance to the
  // close. Built only when both providers are configured (the primary capacity
  // split prefers Twelve Data), so the secondary is the *other* source — Tiingo —
  // and two independent sources agreeing is what settles a quiet symbol / the FX
  // track. Null when only one provider exists (the resolution then settles on
  // reached-close alone).
  const hasBothProviders = Boolean(providers.apiKey.trim()) && Boolean(providers.priceProxyUrl);
  const secondaryPriceFetcher = hasBothProviders
    ? makePriceBarFetcher({
        apiKey: "", // Tiingo-only: the independent second source (prices + FX)
        proxyUrl: providers.priceProxyUrl,
        param: "intraday",
        interval: tuning.interval,
        outputsize: tuning.outputsize,
        startDate: window.startDate,
        endDate: window.endDate,
        fetchImpl: providers.fetchImpl,
        tiingoMeter,
        reservation: providers.reservation,
        now: providers.now,
      })
    : null;
  const fetchSecondaryBars = secondaryPriceFetcher;
  const fetchSecondaryFx = makeFxFetcher(secondaryPriceFetcher);
  return loadOrBuildSessionCurve({
    ...base,
    fetchBars,
    fetchFx,
    fetchSecondaryBars,
    fetchSecondaryFx,
    closeBackoff: base.closeBackoff ?? backoff,
  });
}

/**
 * Build the live **1 Week** curve with both backfills wired in: a dual-pipe
 * daily-close price fetcher (Tiingo `?daily=` first, Twelve Data `interval=1day`
 * fallback) and the batched Tiingo FX-history fetcher (daily cadence) over the
 * trailing-session window. `anchor`, `store`, `now`, `liveTip`, `sessions` and
 * `storeKey` pass straight through to {@link loadOrBuildWeekCurve}.
 */
export function buildLiveWeekCurve(
  base: Omit<WeekCurveOptions, "fetchDailyBars" | "fetchFx">,
  providers: LiveGraphProviders,
): Promise<WeekCurve> {
  const now = base.now ?? new Date();
  const sessions = base.sessions ?? DEFAULT_WEEK_SESSIONS;
  const window = weekFxWindow(now, sessions);
  const { tiingoMeter, twelveDataMeter } = spendMeters(providers);
  const backoff = providers.backoff ?? cacheSeriesBackoff();
  // The 1W curve is built from one daily close per session. With a reservation,
  // Twelve Data's `interval=1day` Pipe A fills first up to its budget and the
  // overflow spills to Tiingo's `?daily=<ticker>` route (off Tiingo's own
  // budget); without one it keeps the legacy Tiingo-first dual pipe. The FX track
  // is simply the EUR/USD symbol on that same pipe (see {@link makeFxFetcher}), so
  // it follows whatever the price pipe does — there is no separate FX subsystem.
  const priceFetcher = makePriceBarFetcher({
    apiKey: providers.apiKey,
    proxyUrl: providers.priceProxyUrl,
    param: "daily",
    interval: "1day",
    outputsize: Math.max(sessions + 2, 8),
    startDate: window.startDate,
    endDate: window.endDate,
    fetchImpl: providers.fetchImpl,
    tiingoMeter,
    twelveDataMeter,
    reservation: providers.reservation,
    now: providers.now,
    backoff: { memo: backoff, scope: "1W" },
  });
  const fetchDailyBars = priceFetcher ?? emptyBarFetcher;
  const fetchFx = makeFxFetcher(priceFetcher);
  // The after-close escalation legs (plan C5 / FX parity): a second, independent
  // provider used only for the daily closes / FX the primary could not advance to
  // the settled close. Built only when both providers exist (see the 1D builder).
  const hasBothProviders = Boolean(providers.apiKey.trim()) && Boolean(providers.priceProxyUrl);
  const secondaryPriceFetcher = hasBothProviders
    ? makePriceBarFetcher({
        apiKey: "", // Tiingo-only: the independent second source (daily closes + FX)
        proxyUrl: providers.priceProxyUrl,
        param: "daily",
        interval: "1day",
        outputsize: Math.max(sessions + 2, 8),
        startDate: window.startDate,
        endDate: window.endDate,
        fetchImpl: providers.fetchImpl,
        tiingoMeter,
        reservation: providers.reservation,
        now: providers.now,
      })
    : null;
  const fetchSecondaryDailyBars = secondaryPriceFetcher;
  const fetchSecondaryFx = makeFxFetcher(secondaryPriceFetcher);
  // Item 7b: gap-fill moving-fund NAV history through the *same* capacity-split
  // daily fetcher (Twelve Data up to budget, Tiingo overflow), re-stamped onto
  // the NAV day-start cadence so it aligns with the free-accumulated NAV bars.
  const fetchNavBars = wrapDailyNavFetcher(fetchDailyBars);
  return loadOrBuildWeekCurve({
    ...base,
    fetchDailyBars,
    fetchFx,
    fetchNavBars,
    fetchSecondaryDailyBars,
    fetchSecondaryFx,
    closeBackoff: base.closeBackoff ?? backoff,
  });
}

/** A no-op {@link BarFetcher} used when neither price pipe is configured. */
const emptyBarFetcher: BarFetcher = async () => new Map<string, Bar[]>();
