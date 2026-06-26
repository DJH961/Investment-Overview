/**
 * Tiingo secondary-provider tap for the browser companion.
 *
 * Twelve Data is the web primary; Tiingo engages only as a smart, budgeted
 * fallback (see `docs/tiingo_fallback_plan.md` and `tiingo-gate.ts`). Tiingo's
 * API is not CORS-readable from a browser and its token must stay secret, so all
 * requests go through the `web/proxy/` Cloudflare Worker `/price` route, which
 * injects the `TIINGO_TOKEN` server-side. The browser stays Tiingo-keyless.
 *
 * Only the **IEX** endpoint is used here: it returns a live intraday mark for
 * stocks/ETFs (`tngoLast` + `prevClose` + an ET `timestamp`) and, gracefully,
 * the most recent NAV for a mutual fund. Tiingo covers **US** tickers only;
 * unknown/non-US symbols simply come back absent (no error), which the caller
 * treats as "no Tiingo fallback available".
 */

import { Decimal } from "./decimal-config";
import { PriceError, parsePositivePrice, type FetchLike, type Quote } from "./prices";
import type { Bar } from "./timeseries";

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

/**
 * The ET (America/New_York) calendar date (`YYYY-MM-DD`) of an epoch — the
 * trading/NAV day a Tiingo mark belongs to, evaluated on the exchange clock so a
 * late-evening UTC timestamp doesn't roll a US session date forward.
 */
function etDate(epochMs: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(epochMs));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Parse a Tiingo IEX `timestamp` (ISO-8601) into epoch ms, or null. */
function parseTimestamp(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

/** Build a {@link Quote} from one IEX row, or null when unusable. */
function quoteFromIexRow(row: Record<string, unknown>, navSymbols?: ReadonlySet<string>): Quote | null {
  const ticker = typeof row.ticker === "string" ? row.ticker.toUpperCase() : null;
  if (!ticker) return null;
  // Mirror the proven desktop adapter: a price is the live mark (`tngoLast`) or
  // the IEX `last`, never `prevClose` — folding the prior close into the *price*
  // chain values a holding at yesterday's number whenever today's mark is absent
  // (it stays available as `previousClose` for the day-change refline). Any
  // non-positive reading is treated as missing so a `0` never values a holding.
  const price = parsePositivePrice(row.tngoLast) ?? parsePositivePrice(row.last);
  if (price === null) return null;
  const isNav = navSymbols?.has(ticker) ?? false;
  const ts = parseTimestamp(row.timestamp ?? row.lastSaleTimestamp ?? row.quoteTimestamp);
  const valueDate = ts !== null ? etDate(ts) : null;
  return {
    symbol: ticker,
    price,
    previousClose: parsePositivePrice(row.prevClose),
    // Tiingo IEX covers US tickers; their marks are USD.
    currency: "USD",
    at: null,
    // A fund's once-a-day NAV has no intraday strike time, so the UI dates it by
    // its value-date rather than a faux-live clock; an equity keeps its real tick.
    priceTime: isNav ? null : ts,
    valueDate,
    marketOpen: null,
  };
}

/** Tunables for {@link fetchTiingoQuotes} (all optional). */
export interface FetchTiingoOptions {
  fetchImpl?: FetchLike;
  /** Symbols that are NAV-priced funds — marked as settled (no live strike time). */
  navSymbols?: ReadonlySet<string>;
}

/**
 * Fetch quotes for `symbols` from the Tiingo IEX endpoint via the `/price`
 * Worker proxy at `proxyUrl`. One request covers the whole batch (comma-joined).
 * Symbols Tiingo doesn't know are simply absent from the result (no throw), so
 * one bad/non-US ticker never blocks the rest of the portfolio.
 *
 * Throws a {@link PriceError} only for a transport/transport-level failure (the
 * proxy unreachable, a non-OK HTTP status, or a malformed body), classified so
 * the caller can decide whether to retry or simply carry on with what it has.
 */
export async function fetchTiingoQuotes(
  symbols: string[],
  proxyUrl: string,
  options: FetchTiingoOptions = {},
): Promise<Map<string, Quote>> {
  const { fetchImpl = fetch, navSymbols } = options;
  const result = new Map<string, Quote>();
  const unique = [...new Set(symbols.map((s) => s.trim()).filter((s) => s.length > 0))];
  if (unique.length === 0 || !proxyUrl) return result;

  // Tiingo upper-cases every ticker it echoes back, whereas the rest of the app
  // keys quotes by the export's `price_symbol` *exactly as written* (Twelve Data
  // echoes the requested case). Resolve the provider's upper-cased ticker back to
  // the symbol the caller asked for here — the one boundary where the two casings
  // meet — so a lower/mixed-case export symbol still finds its Tiingo fallback
  // (`quotes.get(price_symbol)`) instead of silently missing it.
  const requestedByUpper = new Map<string, string>();
  for (const s of unique) requestedByUpper.set(s.toUpperCase(), s);

  const url = new URL(proxyUrl);
  url.searchParams.set("tickers", unique.join(","));

  let resp: Response;
  try {
    resp = await fetchImpl(url.toString());
  } catch (err) {
    throw new PriceError(`could not reach the Tiingo fallback: ${(err as Error).message}`, {
      retryable: true,
    });
  }
  if (!resp.ok) {
    throw new PriceError(`Tiingo fallback returned HTTP ${resp.status}`, {
      status: resp.status,
      retryable: resp.status === 429 || resp.status >= 500,
    });
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch (err) {
    throw new PriceError(`malformed Tiingo fallback payload: ${(err as Error).message}`, {
      retryable: false,
    });
  }
  // A genuine Tiingo IEX response is ALWAYS a JSON array (even `[]` for unknown
  // symbols). A non-array 200 therefore means the price proxy is NOT actually
  // relaying Tiingo: e.g. an un-redeployed Worker serving the encrypted blob for
  // `/price`, or a relayed Tiingo error object on a bad upstream/token. Both mean
  // "no usable backup". Surface it as a (non-retryable) error so the app can show
  // a "backup unreachable" signal instead of failing silently. The caller's catch
  // records this on `fallback.error` while keeping the cached/last-known quotes it
  // already holds, so last-known values are still shown.
  if (!Array.isArray(body)) {
    throw new PriceError(
      "price proxy did not return a Tiingo quote array — check the Worker /price route, proxy config, and Tiingo token",
      { retryable: false },
    );
  }

  for (const row of body) {
    if (!row || typeof row !== "object") continue;
    const quote = quoteFromIexRow(row as Record<string, unknown>, navSymbols);
    if (!quote) continue;
    // Key by the caller's requested symbol (matching Twelve Data's echo-back);
    // fall back to the canonical upper-cased ticker for an unsolicited row.
    const requested = requestedByUpper.get(quote.symbol) ?? quote.symbol;
    result.set(requested, quote);
  }
  return result;
}

/** A live EUR→USD reading from Tiingo's FX top-of-book (USD per 1 EUR). */
export interface TiingoFxReading {
  /** Units of USD per 1 EUR (Tiingo's `eurusd` `midPrice`, used directly). */
  now: Decimal;
  /** Epoch ms the quote was struck (`quoteTimestamp`), or null. */
  at: number | null;
}

/** Parse the mid rate from one FX top-of-book row, or null when unusable. */
function midFromFxRow(row: Record<string, unknown>): Decimal | null {
  const mid = parseDecimal(row.midPrice);
  if (mid !== null && mid.greaterThan(0)) return mid;
  // Fall back to (bid+ask)/2, then the bid alone, mirroring the desktop adapter.
  const bid = parseDecimal(row.bidPrice);
  const ask = parseDecimal(row.askPrice);
  if (bid !== null && ask !== null && bid.greaterThan(0) && ask.greaterThan(0)) {
    return bid.plus(ask).dividedBy(2);
  }
  return bid !== null && bid.greaterThan(0) ? bid : null;
}

/**
 * Fetch the live EUR→USD mid rate from Tiingo's FX top-of-book endpoint via the
 * `/price` Worker proxy at `proxyUrl` (`?fx=eurusd`). Tiingo only quotes the
 * `eurusd` direction, and its `midPrice` is already units of USD per 1 EUR — the
 * exact convention the app's EUR/USD spot uses — so it is returned directly (no
 * inversion). Returns null when the pair is unknown/empty (`[]`), so a quiet
 * weekend row never throws; the caller then keeps its prior/cached/EOD rate.
 *
 * Throws a {@link PriceError} only for a transport-level failure (proxy
 * unreachable, a non-OK HTTP status, or a body that isn't the expected JSON
 * array) so the caller can record a "backup FX unreachable" signal yet keep its
 * last-known rate.
 */
export async function fetchTiingoEurUsd(
  proxyUrl: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<TiingoFxReading | null> {
  const { fetchImpl = fetch } = options;
  if (!proxyUrl) return null;

  const url = new URL(proxyUrl);
  url.searchParams.set("fx", "eurusd");

  let resp: Response;
  try {
    resp = await fetchImpl(url.toString());
  } catch (err) {
    throw new PriceError(`could not reach the Tiingo FX fallback: ${(err as Error).message}`, {
      retryable: true,
    });
  }
  if (!resp.ok) {
    throw new PriceError(`Tiingo FX fallback returned HTTP ${resp.status}`, {
      status: resp.status,
      retryable: resp.status === 429 || resp.status >= 500,
    });
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch (err) {
    throw new PriceError(`malformed Tiingo FX fallback payload: ${(err as Error).message}`, {
      retryable: false,
    });
  }
  // A genuine Tiingo FX response is ALWAYS a JSON array (even `[]` for the
  // inverse/unknown pair). A non-array 200 means the proxy is NOT relaying Tiingo
  // FX (an un-redeployed Worker, or a relayed error object) — surface it so the
  // caller can show "backup FX unreachable" rather than degrading silently.
  if (!Array.isArray(body)) {
    throw new PriceError(
      "price proxy did not return a Tiingo FX array — check the Worker /price route, proxy config, and Tiingo token",
      { retryable: false },
    );
  }

  const row = body.find((r) => r && typeof r === "object");
  if (!row) return null; // `[]` — no quote for the pair (e.g. weekend gap).
  const mid = midFromFxRow(row as Record<string, unknown>);
  if (mid === null) return null;
  const at = parseTimestamp((row as Record<string, unknown>).quoteTimestamp);
  return { now: mid, at };
}

/** Parse a Tiingo FX-history `date` (ISO-8601) into epoch ms, or null. */
function parseFxBarTime(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Turn a Tiingo FX-history `prices` array into ascending EUR→USD bars (USD per
 * 1 EUR), one per row's `close`. Rows missing a parseable instant or a positive
 * close are dropped, and the result is sorted ascending so it slots straight
 * into the {@link TimeSeriesStore} as the curve's per-point FX track.
 */
export function fxBarsFromTiingoHistory(body: unknown): Bar[] {
  if (!Array.isArray(body)) return [];
  const bars: Bar[] = [];
  for (const row of body) {
    if (!row || typeof row !== "object") continue;
    const node = row as Record<string, unknown>;
    const t = parseFxBarTime(node.date);
    const close = parseDecimal(node.close);
    // Tiingo's `eurusd` close is already USD per 1 EUR — the exact convention the
    // curve's `baseFx`/`fxBars` use — so it is taken directly (no inversion).
    if (t !== null && close !== null && close.greaterThan(0)) bars.push({ t, value: close });
  }
  bars.sort((a, b) => a.t - b.t);
  return bars;
}

/** Tunables for {@link fetchTiingoFxBars} (all optional). */
export interface TiingoFxHistoryOptions {
  fetchImpl?: FetchLike;
  /** Quoted FX pair (six lowercase letters). Defaults to `eurusd`. */
  pair?: string;
  /** Bar cadence: `1hour` for the 1D graph, `1day` (default) for the 1W graph. */
  resampleFreq?: string;
  /** Inclusive window start (`YYYY-MM-DD`, New-York calendar). */
  startDate?: string;
  /** Inclusive window end (`YYYY-MM-DD`, New-York calendar). */
  endDate?: string;
}

/**
 * Fetch EUR→USD history bars from Tiingo's FX-history endpoint via the `/price`
 * Worker proxy at `proxyUrl` (`?fxHistory=eurusd&resampleFreq=…`), in **one
 * batched request** over the requested window — the FX analogue of the equity
 * {@link fetchTiingoIntradayBars} backfill, so a back-dated graph re-marks each
 * point at its own settled FX rate (finest available granularity) rather than a
 * single uniform rescale.
 *
 * Returns an empty array when Tiingo has no bars for the window (a quiet
 * weekend/holiday gap comes back `[]`, never a throw). Throws a
 * {@link PriceError} only when the **pipe itself** is unusable — proxy
 * unreachable, hourly reserve spent (HTTP 429), token missing/rejected
 * (503 / 5xx), or a 200 body that is not the Tiingo array — so the caller (the
 * curve builder's `fetchFx`) can silently fall back to the day's `baseFx`.
 */
export async function fetchTiingoFxBars(
  proxyUrl: string,
  options: TiingoFxHistoryOptions = {},
): Promise<Bar[]> {
  const { fetchImpl = fetch, pair = "eurusd", resampleFreq, startDate, endDate } = options;
  if (!proxyUrl) return [];

  const url = new URL(proxyUrl);
  url.searchParams.set("fxHistory", pair);
  if (resampleFreq) url.searchParams.set("resampleFreq", resampleFreq);
  if (startDate) url.searchParams.set("startDate", startDate);
  if (endDate) url.searchParams.set("endDate", endDate);

  let resp: Response;
  try {
    resp = await fetchImpl(url.toString());
  } catch (err) {
    throw new PriceError(`could not reach the Tiingo FX history proxy: ${(err as Error).message}`, {
      retryable: true,
    });
  }
  if (!resp.ok) {
    // Pipe-level failures (400 Worker reject before forwarding, 429 reserve
    // spent, 503 no token, 5xx upstream) abort so the caller falls back to the
    // settled `baseFx`. Crucially a 400 never reached Tiingo's meter — a dead
    // `fxHistory` route returning 400 was the polling-storm phantom-charge — so
    // it throws (the recorder refunds its reservation) rather than booking a
    // credit on an empty result. A 4xx *other* than 400/429 is a window with no
    // data that *did* reach Tiingo — treat as an empty (billed) result.
    if (resp.status === 400 || resp.status === 429 || resp.status === 503 || resp.status >= 500) {
      const retryAfter = Number(resp.headers?.get?.("Retry-After"));
      throw new PriceError(`Tiingo FX history proxy returned HTTP ${resp.status}`, {
        status: resp.status,
        retryable: resp.status !== 400,
        retryAfterMs: Number.isFinite(retryAfter) ? Math.max(0, retryAfter * 1000) : null,
      });
    }
    return [];
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch (err) {
    throw new PriceError(`malformed Tiingo FX history payload: ${(err as Error).message}`, {
      retryable: false,
    });
  }
  // A genuine Tiingo FX-history response is ALWAYS a JSON array (even `[]`). A
  // non-array 200 means the proxy is NOT relaying Tiingo (e.g. an un-redeployed
  // Worker) — surface it so the caller falls back to `baseFx`.
  if (!Array.isArray(body)) {
    throw new PriceError(
      "price proxy did not return a Tiingo FX history array — check the Worker /price route, proxy config, and Tiingo token",
      { retryable: false },
    );
  }
  return fxBarsFromTiingoHistory(body);
}

/**
 * Wrap {@link fetchTiingoFxBars} as the no-arg `fetchFx` the curve builders
 * (`loadOrBuildSessionCurve`, `loadOrBuildWeekCurve`) consume — bound to a proxy
 * URL and window, ready to hand alongside the price {@link makeTiingoBarFetcher}
 * so the FX track is backfilled in the **same batched style** as the prices.
 */
export function makeTiingoFxBarFetcher(
  proxyUrl: string,
  options: TiingoFxHistoryOptions = {},
): () => Promise<Bar[]> {
  return () => fetchTiingoFxBars(proxyUrl, options);
}
