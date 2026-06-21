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

const TWELVE_DATA_ROOT = "https://api.twelvedata.com";
const FRANKFURTER_ROOT = "https://api.frankfurter.dev/v1";

export interface Quote {
  symbol: string;
  /** Latest price in the quote's native currency, or null if unavailable. */
  price: Decimal | null;
  /** Prior close, for the "today's move" figure; null if unavailable. */
  previousClose: Decimal | null;
  currency: string | null;
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
   * Server-advised wait before retrying, in milliseconds, parsed from a
   * `Retry-After` header when present; null otherwise. Callers may prefer this
   * over their own backoff schedule.
   */
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    options: { status?: number | null; retryable?: boolean; retryAfterMs?: number | null } = {},
  ) {
    super(message);
    this.name = "PriceError";
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs ?? null;
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
  return new PriceError(`${service} returned HTTP ${status}`, {
    status,
    retryable: status >= 500,
    retryAfterMs: status >= 500 ? parseRetryAfter(resp) : null,
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

function quoteFromNode(symbol: string, node: Record<string, unknown>): Quote {
  if (node.status === "error") {
    return { symbol, price: null, previousClose: null, currency: null };
  }
  return {
    symbol,
    price: parseDecimal(node.close ?? node.price),
    previousClose: parseDecimal(node.previous_close),
    currency: typeof node.currency === "string" ? node.currency : null,
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
      { status: code, retryable: code === 429 },
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
      result.set(symbol, { symbol, price: null, previousClose: null, currency: null });
    }
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
