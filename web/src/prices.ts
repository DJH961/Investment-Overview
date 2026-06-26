/**
 * Live market data taps for the browser companion.
 *
 * Per the v3.0 proposal §1/§5.3 the web build uses browser-usable, CORS-open
 * sources (Yahoo/Stooq are not):
 *   - prices: Twelve Data `quote` (needs a free API key, held in localStorage),
 *   - FX:     Frankfurter `latest` (keyless, CORS-open).
 *
 * Mutual-fund / money-market holdings (`price_type: "nav"`) have no intraday
 * tick; when a live quote is missing or stale we fall back to the exported
 * `last_known_price_native` and flag the row, so the UI can be honest about it.
 */

import { Decimal } from "./decimal-config";
import type { Bar } from "./timeseries";

const TWELVE_DATA_ROOT = "https://api.twelvedata.com";
const FRANKFURTER_ROOT = "https://api.frankfurter.dev/v1";

export interface Quote {
  symbol: string;
  /** Latest price in the quote's native currency, or null if unavailable. */
  price: Decimal | null;
  /** Prior close, for the "today's move" figure; null if unavailable. */
  previousClose: Decimal | null;
  currency: string | null;
  /**
   * Epoch ms the price was observed — the moment it was fetched, or, for a
   * cache hit, when it was originally stored. Lets the UI say how fresh each
   * holding's price is. Null when unknown (e.g. a freshly parsed API node
   * before {@link loadQuotes} stamps it).
   *
   * NOTE: this is *fetch* time, not the time the price itself applies to. It is
   * what the credit-budget cache uses to decide freshness. For the moment the
   * price actually struck — what the UI should show as "as of" — use
   * {@link priceTime}, which is honest even when the market is closed and the
   * latest available price is hours or days old.
   */
  at?: number | null;
  /**
   * Epoch ms the price *actually applies to* — parsed from Twelve Data's
   * `timestamp` (or `last_quote_at`) field, i.e. when the latest bar/quote was
   * struck. For a NAV-priced fund whose market is shut this is the NAV's strike
   * time (yesterday, last Friday, …), never "now". This is what the UI shows so
   * a stale-but-latest price is never mislabelled as fresh. Null when the API
   * omitted a usable timestamp.
   */
  priceTime?: number | null;
  /**
   * The trading day this price applies to (`YYYY-MM-DD`), parsed from the
   * quote's `datetime`. For a NAV-priced fund this is the date its once-a-day
   * NAV was struck, which lets the refresh layer tell whether the latest
   * published NAV is already in hand. Null when the API omits it.
   */
  valueDate?: string | null;
  /**
   * The provider's own market-state flag for the quote's exchange at fetch time
   * (Twelve Data's `is_market_open`). `true`/`false` when the API reports it,
   * `null`/absent when the endpoint omits it (e.g. the `time_series` NAV
   * fallback). A `false` here is ground truth that the exchange is shut — used
   * to suppress a dishonest "Live" even when our own modelled clock thinks the
   * session is open (an unscheduled close, an early half-day close, …).
   */
  marketOpen?: boolean | null;
}

export interface FxRates {
  base: string;
  /** `rates[X]` = units of X per one unit of `base`. */
  rates: Record<string, Decimal>;
}

export class PriceError extends Error {
  /** HTTP status that produced this error, when it came from a response. */
  readonly status: number | null;
  /**
   * True when the failure is likely transient — a network blip, a rate limit
   * (HTTP 429), or a server-side error (5xx). Callers can then retry or fall
   * back to the exported last-known prices instead of dead-ending the screen.
   */
  readonly retryable: boolean;
  /**
   * True when the failure is a genuine *configuration* problem the user must act
   * on — a rejected/over-quota API key (HTTP 401/403) — so the caller should
   * route to Settings rather than silently degrading. A `fatal` error is never
   * `retryable`. Everything else (a 404, a 5xx, a rate limit, a network blip) is
   * non-fatal: the app should keep its cached/last-known values and carry on,
   * never dead-ending the whole screen.
   */
  readonly fatal: boolean;
  /**
   * Server-advised wait before retrying, in milliseconds, parsed from a
   * `Retry-After` header when present; null otherwise. Callers may prefer this
   * over their own backoff schedule.
   */
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    options: {
      status?: number | null;
      retryable?: boolean;
      retryAfterMs?: number | null;
      fatal?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "PriceError";
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.fatal = options.fatal ?? false;
  }
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds. */
function parseRetryAfter(resp: Response, now: number = Date.now()): number | null {
  const raw = resp.headers?.get?.("Retry-After");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, when - now);
  return null;
}

/** Translate a non-OK HTTP response into a classified PriceError. */
function httpError(service: string, resp: Response): PriceError {
  const status = resp.status;
  if (status === 429) {
    return new PriceError(
      `the ${service} is rate limited (HTTP 429) — too many requests, try again shortly`,
      { status, retryable: true, retryAfterMs: parseRetryAfter(resp) },
    );
  }
  // A rejected / over-quota API key (401/403) is a configuration problem the
  // user must fix in Settings — surface it as fatal. Every other status (a 404,
  // a 4xx, …) is treated as a transient gap: keep the last-known values rather
  // than dead-ending the whole screen on a refresh.
  const fatal = status === 401 || status === 403;
  return new PriceError(`${service} returned HTTP ${status}`, {
    status,
    retryable: status >= 500,
    retryAfterMs: status >= 500 ? parseRetryAfter(resp) : null,
    fatal,
  });
}

/** Minimal injectable fetch so callers/tests can supply their own transport. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

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
 * Parse a provider price into a *strictly positive* finite Decimal, treating a
 * non-positive (`<= 0`) reading as missing (null). A `0`/negative mark is never
 * a real price — it is the provider's stand-in for "no data" — so rejecting it
 * here, at the parse boundary, stops a phantom `0` from valuing a holding or
 * collapsing a graph ratio downstream. Use this for every figure that is a
 * price (last/close/previous-close/bar-close); plain {@link parseDecimal} stays
 * for non-price numerics that may legitimately be zero or negative.
 */
export function parsePositivePrice(value: unknown): Decimal | null {
  const d = parseDecimal(value);
  return d !== null && d.greaterThan(0) ? d : null;
}

/**
 * Extract the `YYYY-MM-DD` date from a Twelve Data `datetime` field, which is
 * either a bare date (daily bars, e.g. NAV) or a `YYYY-MM-DD HH:MM:SS`
 * timestamp (intraday). Returns null for anything unparseable.
 */
function parseValueDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return match ? match[1] : null;
}

/**
 * Parse a Twelve Data epoch field (`timestamp` / `last_quote_at`) — Unix
 * *seconds* — into epoch milliseconds. Accepts a numeric string too. Returns
 * null for anything missing or non-finite.
 */
function parseEpochSeconds(value: unknown): number | null {
  const seconds = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * 1000);
}

/**
 * Whether a Twelve Data `datetime` carries an intraday time component
 * (`YYYY-MM-DD HH:MM:SS`) rather than a bare daily-bar date (`YYYY-MM-DD`).
 * Only an intraday datetime has a meaningful within-day strike time; a daily
 * (`interval=1day`) bar is stamped at the session *open*, which must NOT be
 * surfaced as the price's "as of" time.
 */
function hasIntradayTime(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(value.trim());
}

function quoteFromNode(symbol: string, node: Record<string, unknown>): Quote {
  if (node.status === "error") {
    return { symbol, price: null, previousClose: null, currency: null, at: null, priceTime: null, valueDate: null };
  }
  // The price's real strike time. `last_quote_at` (when present) is the genuine
  // last-trade moment, so always trust it. Otherwise only trust `timestamp` for
  // an *intraday* bar: for the free-tier default daily `/quote`, `timestamp` is
  // the bar's datetime — the session open (09:30 ET), which a European user sees
  // rendered as "3:30 PM" even though the data was pulled hours later. For such
  // a bare-date daily bar we leave `priceTime` null so the caller dates a market
  // price by when it was actually observed (the fetch time), not the bar open.
  const priceTime =
    parseEpochSeconds(node.last_quote_at) ??
    (hasIntradayTime(node.datetime) ? parseEpochSeconds(node.timestamp) : null);
  return {
    symbol,
    price: parsePositivePrice(node.close ?? node.price),
    previousClose: parsePositivePrice(node.previous_close),
    currency: typeof node.currency === "string" ? node.currency : null,
    at: null,
    priceTime,
    valueDate: parseValueDate(node.datetime),
    marketOpen: typeof node.is_market_open === "boolean" ? node.is_market_open : null,
  };
}

/**
 * Fetch quotes for `symbols` in a single batched Twelve Data call.
 * Unknown/unsupported symbols come back with `price: null` rather than throwing,
 * so one bad ticker never blocks the rest of the portfolio.
 */
export async function fetchQuotes(
  symbols: string[],
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<Map<string, Quote>> {
  const result = new Map<string, Quote>();
  const unique = [...new Set(symbols.filter((s) => s.length > 0))];
  if (unique.length === 0) return result;

  const url = new URL(`${TWELVE_DATA_ROOT}/quote`);
  url.searchParams.set("symbol", unique.join(","));
  url.searchParams.set("apikey", apiKey);

  let resp: Response;
  try {
    resp = await fetchImpl(url.toString());
  } catch (err) {
    throw new PriceError(`could not reach the price service: ${(err as Error).message}`, {
      retryable: true,
    });
  }
  if (!resp.ok) {
    throw httpError("price service", resp);
  }
  const body = (await resp.json()) as Record<string, unknown>;

  // A top-level {"code":..,"status":"error"} means the whole call failed
  // (usually a bad/over-quota API key).
  if (body.status === "error" && !("symbol" in body)) {
    const code = typeof body.code === "number" ? body.code : null;
    throw new PriceError(
      typeof body.message === "string" ? body.message : "price request rejected",
      { status: code, retryable: code === 429, fatal: code === 401 || code === 403 },
    );
  }

  if (unique.length === 1) {
    result.set(unique[0], quoteFromNode(unique[0], body));
    return result;
  }
  for (const symbol of unique) {
    const node = body[symbol];
    if (node && typeof node === "object") {
      result.set(symbol, quoteFromNode(symbol, node as Record<string, unknown>));
    } else {
      result.set(symbol, { symbol, price: null, previousClose: null, currency: null, at: null, priceTime: null });
    }
  }
  return result;
}

/** The Twelve Data forex symbol for the EUR→USD pair (USD per 1 EUR). */
export const EUR_USD_SYMBOL = "EUR/USD";

/** A live EUR→USD reading: the current spot and the prior session's close. */
export interface EurUsdQuote {
  /** Units of USD per 1 EUR, right now. Null when unavailable. */
  now: Decimal | null;
  /** Units of USD per 1 EUR at the prior session close. Null when unavailable. */
  previousClose: Decimal | null;
  /** Epoch ms the spot was observed (fetch time, or cache-store time). */
  at?: number | null;
}

/**
 * Fetch the live EUR→USD pair from Twelve Data's `quote` endpoint. Forex pairs
 * are quoted like any other symbol there, so this reuses {@link fetchQuotes}'s
 * parser and returns both the current price and the prior close — exactly the
 * two rates an FX-aware "today's move" needs (revalue the current mark at
 * `now`, the prior mark at `previousClose`). A missing/again-null reading does
 * not throw; the caller falls back to the ECB daily rate.
 */
export async function fetchEurUsd(
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<EurUsdQuote> {
  const quotes = await fetchQuotes([EUR_USD_SYMBOL], apiKey, fetchImpl);
  const quote = quotes.get(EUR_USD_SYMBOL);
  return {
    now: quote?.price ?? null,
    previousClose: quote?.previousClose ?? null,
    at: quote?.priceTime ?? quote?.at ?? null,
  };
}

/**
 * Fetch the latest **NAV** for mutual-fund / money-market symbols from Twelve
 * Data's `time_series` (daily) endpoint instead of `quote`.
 *
 * Why a different endpoint: `quote` carries a fund's last NAV forward and stamps
 * it with *today's* date even on days the fund did not publish (a weekend or a
 * mid-week market holiday), which made a stale NAV masquerade as "today's" and
 * dragged the value chart off a cliff. The daily `time_series` only ever returns
 * a bar for a real trading day, so the latest bar's `datetime` is the authentic
 * date the NAV was struck — no weekend/holiday calendar of our own required. We
 * ask for two bars (`outputsize=2`, newest first) so a previous close is
 * available too.
 */
export async function fetchNavQuotes(
  symbols: string[],
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<Map<string, Quote>> {
  const result = new Map<string, Quote>();
  const unique = [...new Set(symbols.filter((s) => s.length > 0))];
  if (unique.length === 0) return result;

  const url = new URL(`${TWELVE_DATA_ROOT}/time_series`);
  url.searchParams.set("symbol", unique.join(","));
  url.searchParams.set("interval", "1day");
  url.searchParams.set("outputsize", "2");
  url.searchParams.set("order", "desc");
  url.searchParams.set("apikey", apiKey);

  let resp: Response;
  try {
    resp = await fetchImpl(url.toString());
  } catch (err) {
    throw new PriceError(`could not reach the price service: ${(err as Error).message}`, {
      retryable: true,
    });
  }
  if (!resp.ok) {
    throw httpError("price service", resp);
  }
  const body = (await resp.json()) as Record<string, unknown>;

  // A top-level error with no `meta`/`values` means the whole call failed
  // (usually a bad/over-quota API key) — same handling as the quote endpoint.
  if (body.status === "error" && !("values" in body) && !("meta" in body)) {
    const code = typeof body.code === "number" ? body.code : null;
    throw new PriceError(
      typeof body.message === "string" ? body.message : "price request rejected",
      { status: code, retryable: code === 429, fatal: code === 401 || code === 403 },
    );
  }

  if (unique.length === 1) {
    result.set(unique[0], navQuoteFromNode(unique[0], body));
    return result;
  }
  for (const symbol of unique) {
    const node = body[symbol];
    result.set(
      symbol,
      node && typeof node === "object"
        ? navQuoteFromNode(symbol, node as Record<string, unknown>)
        : { symbol, price: null, previousClose: null, currency: null, at: null, priceTime: null, valueDate: null },
    );
  }
  return result;
}

/** Build a NAV {@link Quote} from a `time_series` node (`{meta, values}`). */
function navQuoteFromNode(symbol: string, node: Record<string, unknown>): Quote {
  const meta = (node.meta ?? {}) as Record<string, unknown>;
  const values = Array.isArray(node.values) ? (node.values as Array<Record<string, unknown>>) : [];
  const latest = values[0];
  if (node.status === "error" || !latest) {
    return { symbol, price: null, previousClose: null, currency: null, at: null, priceTime: null, valueDate: null };
  }
  return {
    symbol,
    price: parsePositivePrice(latest.close),
    previousClose: values[1] ? parsePositivePrice(values[1].close) : null,
    currency: typeof meta.currency === "string" ? meta.currency : null,
    at: null,
    // A daily NAV bar carries only a date (no intraday strike time), so the UI
    // shows it as a date — exactly right for a once-a-day fund mark.
    priceTime: null,
    valueDate: parseValueDate(latest.datetime),
  };
}

/**
 * Parse a Twelve Data `datetime` (`YYYY-MM-DD HH:MM:SS` intraday, or a bare
 * `YYYY-MM-DD` daily bar) into epoch milliseconds, treating the wall-clock as
 * UTC. The absolute zone offset is unimportant here: price bars and EUR/USD bars
 * come from the same provider with the same convention, so the curve's
 * forward-fill alignment is internally consistent. Returns null if unparseable.
 */
function parseBarTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const s = value.trim().replace(" ", "T");
  const iso = s.length <= 10 ? `${s}T00:00:00Z` : `${s}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Turn a `time_series` `values` array (newest-first) into ascending price bars. */
function barsFromValues(node: Record<string, unknown>): TimeSeriesBar[] {
  const values = Array.isArray(node.values) ? (node.values as Array<Record<string, unknown>>) : [];
  const bars: TimeSeriesBar[] = [];
  for (const v of values) {
    const t = parseBarTime(v.datetime);
    const close = parsePositivePrice(v.close);
    if (t !== null && close !== null) bars.push({ t, value: close });
  }
  bars.sort((a, b) => a.t - b.t);
  return bars;
}

/** One price bar: an epoch-ms instant and the close in the symbol's currency. */
export type TimeSeriesBar = Bar;

/**
 * Fetch an intraday (or short-range daily) price **series** per symbol from
 * Twelve Data's `time_series` endpoint — the data layer for the live 1D/1W
 * graphs (docs/v3.0 §10.2).
 *
 * The crucial economics: `time_series` bills **1 credit per symbol per request,
 * regardless of how many bars come back** (the bar count is set by
 * `interval`/`outputsize` and is free). So a whole session's curve for one
 * symbol costs a single credit, and the endpoint is CORS-open (`*`) → callable
 * **browser-direct**, no proxy. Symbols are batched into one call (still 1
 * credit each); unknown/over-quota symbols come back empty rather than throwing,
 * so one bad ticker never blocks the rest.
 */
export async function fetchTimeSeries(
  symbols: string[],
  apiKey: string,
  options: { interval?: string; outputsize?: number; fetchImpl?: FetchLike } = {},
): Promise<Map<string, TimeSeriesBar[]>> {
  const { interval = "5min", outputsize = 78, fetchImpl = fetch } = options;
  const result = new Map<string, TimeSeriesBar[]>();
  const unique = [...new Set(symbols.filter((s) => s.length > 0))];
  if (unique.length === 0) return result;

  const url = new URL(`${TWELVE_DATA_ROOT}/time_series`);
  url.searchParams.set("symbol", unique.join(","));
  url.searchParams.set("interval", interval);
  url.searchParams.set("outputsize", String(outputsize));
  url.searchParams.set("order", "desc");
  url.searchParams.set("apikey", apiKey);

  let resp: Response;
  try {
    resp = await fetchImpl(url.toString());
  } catch (err) {
    throw new PriceError(`could not reach the price service: ${(err as Error).message}`, {
      retryable: true,
    });
  }
  if (!resp.ok) {
    throw httpError("price service", resp);
  }
  const body = (await resp.json()) as Record<string, unknown>;

  // A top-level error with no `meta`/`values` means the whole call failed
  // (usually a bad/over-quota key) — classify it like the other endpoints.
  if (body.status === "error" && !("values" in body) && !("meta" in body)) {
    const code = typeof body.code === "number" ? body.code : null;
    throw new PriceError(
      typeof body.message === "string" ? body.message : "price request rejected",
      { status: code, retryable: code === 429, fatal: code === 401 || code === 403 },
    );
  }

  if (unique.length === 1) {
    result.set(unique[0], barsFromValues(body));
    return result;
  }
  for (const symbol of unique) {
    const node = body[symbol];
    result.set(symbol, node && typeof node === "object" ? barsFromValues(node as Record<string, unknown>) : []);
  }
  return result;
}

/** Fetch FX rates from Frankfurter with `base` as the reference currency. */
export async function fetchFxRates(
  base = "EUR",
  fetchImpl: FetchLike = fetch,
): Promise<FxRates> {
  const url = new URL(`${FRANKFURTER_ROOT}/latest`);
  url.searchParams.set("base", base);

  let resp: Response;
  try {
    resp = await fetchImpl(url.toString());
  } catch (err) {
    throw new PriceError(`could not reach the FX service: ${(err as Error).message}`, {
      retryable: true,
    });
  }
  if (!resp.ok) {
    throw httpError("FX service", resp);
  }
  const body = (await resp.json()) as { base?: string; rates?: Record<string, unknown> };
  const rates: Record<string, Decimal> = {};
  for (const [code, value] of Object.entries(body.rates ?? {})) {
    const dec = parseDecimal(value);
    if (dec) rates[code] = dec;
  }
  return { base: body.base ?? base, rates };
}

/**
 * Convert `amount` from `from` currency into `to` using EUR-based rates where
 * `rates[X]` is units of X per one EUR. Returns null if a leg is missing.
 */
export function convert(
  amount: Decimal,
  from: string,
  to: string,
  fx: FxRates,
): Decimal | null {
  if (from === to) return amount;
  const perBase = (code: string): Decimal | null => {
    if (code === fx.base) return new Decimal(1);
    return fx.rates[code] ?? null;
  };
  const fromRate = perBase(from);
  const toRate = perBase(to);
  if (!fromRate || !toRate || fromRate.isZero()) return null;
  // amount[from] → base: amount / fromRate ; base → to: × toRate.
  return amount.dividedBy(fromRate).times(toRate);
}
