/**
 * **Pipe B** — the Tiingo intraday-bar backfill for the live 1D/1W graph
 * (docs/v3.0_live_web_companion_proposal.md §10.8, Phase 3).
 *
 * Phase 2 ships a working 1D entirely on Twelve Data's `time_series`
 * (browser-direct, `prices.fetchTimeSeries`). Phase 3 adds a *second* backfill
 * pipe that pulls the session's bars from Tiingo's IEX intraday endpoint via the
 * `web/proxy/` Cloudflare Worker `/price` route (`?intraday=<ticker>`), so the
 * bulk history fetch runs on Tiingo's separate budget and **never delays the
 * live price** sharing Twelve Data's 8-credit/min cap.
 *
 * Tiingo's API is not CORS-readable from a browser and its token must stay
 * secret, so every request goes through the Worker, which injects the
 * `TIINGO_TOKEN` server-side and meters its own hourly reserve. The browser stays
 * Tiingo-keyless. One request covers one ticker (the route takes a single
 * `intraday=`/`daily=` param), so the bars are fetched per symbol.
 *
 * The two pipes share the {@link BarFetcher} contract `intraday.ts` consumes, so
 * {@link makeDualPipeBarFetcher} can prefer Tiingo and **fall back to the Phase-2
 * Twelve Data path** the moment Pipe B is unavailable — un-deployed Worker, no
 * `TIINGO_TOKEN`, an exhausted hourly reserve (HTTP 429), a transport blip, or a
 * reachable-but-empty response that would otherwise paint a blank graph.
 *
 * The network (`fetchImpl`) is injected, so the whole pipe is unit-testable with
 * no live API.
 */

import { Decimal } from "./decimal-config";
import { PriceError, type FetchLike } from "./prices";
import { sessionCloseMs, sessionOpenMs } from "./market-hours";
import type { Bar } from "./timeseries";
import type { BarFetcher } from "./intraday";

/** Parse a JSON number/string into a finite Decimal, or null. */
function parseDecimal(value: unknown): Decimal | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  try {
    const d = new Decimal(value);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/** Parse a Tiingo IEX intraday `date` (ISO-8601) into epoch ms, or null. */
function parseBarTime(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Turn a Tiingo IEX intraday `prices` array into ascending price bars. Each row
 * carries an ISO `date` and OHLC fields; the curve marks off the `close`. Rows
 * missing a parseable instant or close are dropped, and the result is sorted
 * ascending so it slots straight into the {@link TimeSeriesStore}.
 */
export function barsFromTiingoIntraday(body: unknown): Bar[] {
  if (!Array.isArray(body)) return [];
  const bars: Bar[] = [];
  for (const row of body) {
    if (!row || typeof row !== "object") continue;
    const node = row as Record<string, unknown>;
    const t = parseBarTime(node.date);
    const close = parseDecimal(node.close);
    if (t !== null && close !== null) bars.push({ t, value: close });
  }
  bars.sort((a, b) => a.t - b.t);
  return bars;
}

/** Extract the `YYYY-MM-DD` New-York session day from a Tiingo `date` field. */
function dayFromBarDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return m ? m[1] : null;
}

/**
 * Turn a Tiingo **daily** `prices` array into ascending bars carrying only the
 * two points per trading day that the feed actually time-stamps — the session
 * **open** and **close**. Each row's `date` is a calendar day; the open bar is
 * stamped at that day's 09:30 ET and the close at 16:00 ET (the genuine session
 * bounds), so every plotted point lands at a real instant on the time axis.
 *
 * The daily feed carries OHLC but no within-day clock for the high/low, so we do
 * **not** synthesise interior swing points: a reconstructed high/low/mid would be
 * pinned to invented midday/quarter slots, mislabelling guessed instants as real.
 * Open and close are the only honestly-timestamped marks, so they are all we plot.
 * Rows missing a usable day are dropped; a row keeps whichever of open/close it has.
 */
export function barsFromTiingoDaily(body: unknown): Bar[] {
  if (!Array.isArray(body)) return [];
  const bars: Bar[] = [];
  for (const row of body) {
    if (!row || typeof row !== "object") continue;
    const node = row as Record<string, unknown>;
    const day = dayFromBarDate(node.date);
    if (day === null) continue;
    const open = parseDecimal(node.open);
    const close = parseDecimal(node.close);
    if (open !== null) bars.push({ t: sessionOpenMs(day), value: open });
    if (close !== null) bars.push({ t: sessionCloseMs(day), value: close });
  }
  bars.sort((a, b) => a.t - b.t);
  return bars;
}

/** Tunables for {@link fetchTiingoIntradayBars} (all optional). */
export interface TiingoIntradayOptions {
  fetchImpl?: FetchLike;
  /**
   * Which Tiingo bar feed the unified `/price` route should serve: `intraday`
   * (IEX `resampleFreq=1hour` bars → the 1D curve) or `daily` (daily closes →
   * the 1W curve). Defaults to `intraday`.
   */
  param?: "intraday" | "daily";
  /** Inclusive session start date (`YYYY-MM-DD`, New-York calendar). */
  startDate?: string;
  /** Inclusive session end date (`YYYY-MM-DD`, New-York calendar). */
  endDate?: string;
}

/**
 * Fetch price bars for `symbols` from Tiingo via the unified `/price` Worker
 * proxy at `proxyUrl`, one request per ticker. The `param` option selects the
 * feed: `?intraday=<ticker>` for IEX intraday bars (the 1D curve) or
 * `?daily=<ticker>` for daily closes (the 1W curve). Both are charset-validated
 * and pinned server-side, so the bulk history fetch runs on Tiingo's own budget
 * and **never delays the live price** sharing Twelve Data's 8-credit/min cap.
 *
 * A ticker Tiingo doesn't know simply comes back with no bars (no throw), so one
 * unknown/non-US symbol never blocks the rest. A {@link PriceError} is thrown
 * only when the **pipe itself** is unusable — the proxy unreachable, its hourly
 * reserve spent (HTTP 429), the Tiingo token missing/rejected server-side (503 /
 * 5xx), or a 200 body that is not the Tiingo array (an un-redeployed Worker
 * serving something else). The caller — {@link makeDualPipeBarFetcher} — then
 * degrades to the Twelve Data path instead of dead-ending the graph.
 */
export async function fetchTiingoIntradayBars(
  symbols: string[],
  proxyUrl: string,
  options: TiingoIntradayOptions = {},
): Promise<Map<string, Bar[]>> {
  const { fetchImpl = fetch, param = "intraday", startDate, endDate } = options;
  const result = new Map<string, Bar[]>();
  const unique = [...new Set(symbols.map((s) => s.trim()).filter((s) => s.length > 0))];
  if (unique.length === 0 || !proxyUrl) return result;

  for (const symbol of unique) {
    const url = new URL(proxyUrl);
    url.searchParams.set(param, symbol);
    if (startDate) url.searchParams.set("startDate", startDate);
    if (endDate) url.searchParams.set("endDate", endDate);

    let resp: Response;
    try {
      resp = await fetchImpl(url.toString());
    } catch (err) {
      throw new PriceError(`could not reach the Tiingo intraday proxy: ${(err as Error).message}`, {
        retryable: true,
      });
    }

    if (!resp.ok) {
      // Pipe-level failures abort the whole batch so the caller can fall back:
      //  - 400: the Worker rejected bad params *before* forwarding to Tiingo (a
      //    dead/renamed route, or a malformed window) — never reached Tiingo's
      //    meter, so it must NOT book a credit (the FX-storm phantom-charge bug);
      //  - 429: the Worker's hourly Tiingo reserve is spent (Retry-After advised);
      //  - 503: no TIINGO_TOKEN configured; 5xx: an upstream/Worker error.
      // A 404 (or other 4xx) is a per-ticker gap — Tiingo doesn't know it, but the
      // request *did* reach Tiingo's meter — so the symbol is left with no bars,
      // the batch carries on, and the call still counts as billed.
      if (resp.status === 400 || resp.status === 429 || resp.status === 503 || resp.status >= 500) {
        const retryAfter = Number(resp.headers?.get?.("Retry-After"));
        throw new PriceError(`Tiingo intraday proxy returned HTTP ${resp.status}`, {
          status: resp.status,
          retryable: resp.status !== 400,
          retryAfterMs: Number.isFinite(retryAfter) ? Math.max(0, retryAfter * 1000) : null,
        });
      }
      result.set(symbol, []);
      continue;
    }

    let body: unknown;
    try {
      body = await resp.json();
    } catch (err) {
      throw new PriceError(`malformed Tiingo intraday payload: ${(err as Error).message}`, {
        retryable: false,
      });
    }
    // A genuine Tiingo intraday response is ALWAYS a JSON array (even `[]` for an
    // unknown ticker). A non-array 200 means the proxy is NOT relaying Tiingo
    // (e.g. an un-redeployed Worker) — surface it so the caller falls back.
    if (!Array.isArray(body)) {
      throw new PriceError(
        "intraday proxy did not return a Tiingo bar array — check the Worker /price route, proxy config, and Tiingo token",
        { retryable: false },
      );
    }
    // The daily feed (1W curve) carries OHLC per day, so we reconstruct up to
    // five points per session (open / +1/4 / midday / +3/4 / close) for a richer
    // line; the intraday feed marks off the close.
    result.set(symbol, param === "daily" ? barsFromTiingoDaily(body) : barsFromTiingoIntraday(body));
  }
  return result;
}

/**
 * Wrap {@link fetchTiingoIntradayBars} as a {@link BarFetcher} bound to a proxy
 * URL and session window — Pipe B, ready to hand to `loadOrBuildSessionCurve`.
 */
export function makeTiingoBarFetcher(
  proxyUrl: string,
  options: TiingoIntradayOptions = {},
): BarFetcher {
  return (symbols) => fetchTiingoIntradayBars(symbols, proxyUrl, options);
}

/** Whether a fetched bar map carries at least one usable bar. */
function hasAnyBars(bars: Map<string, Bar[]>): boolean {
  for (const list of bars.values()) {
    if (list.length > 0) return true;
  }
  return false;
}

/** Tunables for {@link makeDualPipeBarFetcher}. */
export interface DualPipeOptions {
  /**
   * Fall back to the secondary pipe when the primary is reachable but returns no
   * bars for any requested symbol. An all-empty result is indistinguishable from
   * a broken pipe and would paint a blank graph, so by default we try the
   * secondary instead. Set false to trust an empty primary result. Default true.
   */
  fallbackOnEmpty?: boolean;
}

/**
 * Compose two {@link BarFetcher}s into the dual-pipe backfill: try `primary`
 * (Pipe B — Tiingo) and **fall back to `fallback`** (Pipe A — Twelve Data) the
 * moment Pipe B is unavailable. "Unavailable" covers both a thrown
 * {@link PriceError} (proxy down, reserve spent, token missing, bad body) and —
 * when {@link DualPipeOptions.fallbackOnEmpty} is set (the default) — a reachable
 * pipe that returns no bars at all for a non-empty symbol set.
 *
 * The fallback is only consulted when there are symbols to fetch, and any error
 * from it propagates (there is nothing left to try).
 */
export function makeDualPipeBarFetcher(
  primary: BarFetcher,
  fallback: BarFetcher,
  options: DualPipeOptions = {},
): BarFetcher {
  const fallbackOnEmpty = options.fallbackOnEmpty ?? true;
  return async (symbols) => {
    if (symbols.length === 0) return new Map<string, Bar[]>();
    try {
      const bars = await primary(symbols);
      if (fallbackOnEmpty && !hasAnyBars(bars)) {
        return fallback(symbols);
      }
      return bars;
    } catch (err) {
      if (err instanceof PriceError) {
        return fallback(symbols);
      }
      throw err;
    }
  };
}
