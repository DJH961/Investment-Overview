/**
 * Live-graph orchestration — ties the Phase 2–4 curve builders together with the
 * **batched** price and FX backfills (docs/v3.0_live_web_companion_proposal.md
 * §10.8).
 *
 * The 1D ({@link loadOrBuildSessionCurve}) and 1W ({@link loadOrBuildWeekCurve})
 * builders each take an injected `fetchBars`/`fetchDailyBars` (native price bars)
 * and an optional `fetchFx` (EUR→USD bars). This module assembles those
 * injectables from the app's two providers:
 *
 *   - **Prices** — the dual pipe: Tiingo via the unified Worker `/price` route
 *     (`?intraday=` for the 1D curve, `?daily=` for the 1W curve — one request
 *     per ticker, off Tiingo's own budget) with an automatic fall-back to Twelve
 *     Data's browser-direct `time_series` (1 credit/symbol) when Tiingo is
 *     unavailable. Tiingo is preferred because its bulk history fetch is fast and
 *     free of the per-minute Twelve Data cap, so the graph paints promptly even
 *     in a short (2–3 min) session.
 *   - **FX** — the *same batched style*: one Tiingo `/price?fxHistory=eurusd`
 *     request over the curve's exact date window pulls the per-bar EUR→USD track
 *     ({@link makeTiingoFxBarFetcher}), so a back-dated graph re-marks each point
 *     at its **own settled FX rate** (finest available granularity) instead of a
 *     single uniform rescale. The Tiingo FX integration shipped with the backup
 *     live FX provider, so the history endpoint is already proxied.
 *
 * Everything that touches the network (`fetchImpl`, the API key) or persistence
 * (the {@link TimeSeriesStore}) is injected, so the whole orchestration is
 * unit-testable with no DOM, IndexedDB, or live API. When a proxy/key is absent
 * the corresponding pipe simply drops out (prices fall back to Twelve Data; FX
 * falls back to the day's settled `baseFx`), and the graph still draws.
 */

import { fetchTimeSeries, type FetchLike } from "./prices";
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
import { makeTiingoFxBarFetcher } from "./tiingo";
import type { Bar } from "./timeseries";
import {
  loadOrBuildWeekCurve,
  DEFAULT_WEEK_SESSIONS,
  type WeekCurve,
  type WeekCurveOptions,
} from "./week";

/** An inclusive `YYYY-MM-DD` date window (New-York calendar). */
export interface DateWindow {
  startDate: string;
  endDate: string;
}

/** The single-session window the live 1D curve (and its FX track) covers. */
export function sessionFxWindow(now: Date = new Date()): DateWindow {
  const day = lastSessionDate(now);
  return { startDate: day, endDate: day };
}

/** The trailing trading-session window the live 1W curve (and FX) covers. */
export function weekFxWindow(
  now: Date = new Date(),
  sessions: number = DEFAULT_WEEK_SESSIONS,
): DateWindow {
  const window = recentTradingSessions(Math.max(1, sessions), now);
  return { startDate: window[0], endDate: window[window.length - 1] };
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
}): BarFetcher | null {
  const { apiKey, proxyUrl, param, interval, outputsize, startDate, endDate, fetchImpl } = opts;
  const pipeA = makeTwelveDataBarFetcher(apiKey, { interval, outputsize, fetchImpl });
  const pipeB = proxyUrl
    ? makeTiingoBarFetcher(proxyUrl, { param, startDate, endDate, fetchImpl })
    : null;
  if (pipeB && pipeA) return makeDualPipeBarFetcher(pipeB, pipeA);
  return pipeB ?? pipeA;
}

/**
 * Bind the batched Tiingo FX-history fetcher to a window + cadence, or `null`
 * when there is no `/price` proxy to reach it through (the curve then falls back
 * to the day's settled `baseFx` for every point). One request covers the whole
 * window — the FX analogue of the price backfill.
 */
export function makeWindowFxFetcher(
  priceProxyUrl: string | null,
  window: DateWindow,
  resampleFreq: string,
  fetchImpl?: FetchLike,
): (() => Promise<Bar[]>) | null {
  if (!priceProxyUrl) return null;
  return makeTiingoFxBarFetcher(priceProxyUrl, {
    resampleFreq,
    startDate: window.startDate,
    endDate: window.endDate,
    fetchImpl,
  });
}

/** Shared network/persistence wiring for the live-graph builders. */
export interface LiveGraphProviders {
  /** Twelve Data API key (Pipe A). Empty ⇒ Tiingo-only prices. */
  apiKey: string;
  /** Unified Worker `/price` route (Tiingo prices + FX history). Null ⇒ Twelve Data only. */
  priceProxyUrl: string | null;
  /** Injected fetch (defaults to the global). */
  fetchImpl?: FetchLike;
}

/** Per-bar cadence the 1D price feed (and matching FX track) requests. */
export interface SessionGraphTuning {
  /** Twelve Data `time_series` interval for Pipe A (default `5min`). */
  interval?: string;
  /** Twelve Data `outputsize` for Pipe A (default 78 ≈ a 5-min session). */
  outputsize?: number;
  /** Tiingo FX-history resample for the day's FX track (default `1hour`). */
  fxResampleFreq?: string;
}

/**
 * Build the live **1 Day** curve with both backfills wired in: the dual-pipe
 * price fetcher and the batched Tiingo FX-history fetcher over the session day.
 * `anchor`, `store`, `now`, `liveTip` and `retainSessions` are passed straight
 * through to {@link loadOrBuildSessionCurve}.
 */
export function buildLiveSessionCurve(
  base: Omit<SessionCurveOptions, "fetchBars" | "fetchFx">,
  providers: LiveGraphProviders,
  tuning: SessionGraphTuning = {},
): Promise<SessionCurve> {
  const now = base.now ?? new Date();
  const window = sessionFxWindow(now);
  const fetchBars =
    makePriceBarFetcher({
      apiKey: providers.apiKey,
      proxyUrl: providers.priceProxyUrl,
      param: "intraday",
      interval: tuning.interval,
      outputsize: tuning.outputsize,
      startDate: window.startDate,
      endDate: window.endDate,
      fetchImpl: providers.fetchImpl,
    }) ?? emptyBarFetcher;
  const fetchFx = makeWindowFxFetcher(
    providers.priceProxyUrl,
    window,
    tuning.fxResampleFreq ?? "1hour",
    providers.fetchImpl,
  );
  return loadOrBuildSessionCurve({ ...base, fetchBars, fetchFx });
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
  // The 1W curve is built from one daily close per session. Tiingo's `/price`
  // route serves those via `?daily=<ticker>` (a single batched window per
  // symbol, off Tiingo's own budget), so it is preferred for a prompt paint; the
  // browser-direct Twelve Data `interval=1day` Pipe A is the fallback. The FX
  // track is pulled in the same batched style from Tiingo's FX-history route at a
  // daily cadence.
  const fetchDailyBars =
    makePriceBarFetcher({
      apiKey: providers.apiKey,
      proxyUrl: providers.priceProxyUrl,
      param: "daily",
      interval: "1day",
      outputsize: Math.max(sessions + 2, 8),
      startDate: window.startDate,
      endDate: window.endDate,
      fetchImpl: providers.fetchImpl,
    }) ?? emptyBarFetcher;
  const fetchFx = makeWindowFxFetcher(providers.priceProxyUrl, window, "1day", providers.fetchImpl);
  return loadOrBuildWeekCurve({ ...base, fetchDailyBars, fetchFx });
}

/** A no-op {@link BarFetcher} used when neither price pipe is configured. */
const emptyBarFetcher: BarFetcher = async () => new Map<string, Bar[]>();
