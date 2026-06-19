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

export class PriceError extends Error {}

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
    throw new PriceError(`could not reach the price service: ${(err as Error).message}`);
  }
  if (!resp.ok) {
    throw new PriceError(`price service returned HTTP ${resp.status}`);
  }
  const body = (await resp.json()) as Record<string, unknown>;

  // A top-level {"code":..,"status":"error"} means the whole call failed
  // (usually a bad/over-quota API key).
  if (body.status === "error" && !("symbol" in body)) {
    throw new PriceError(typeof body.message === "string" ? body.message : "price request rejected");
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
    throw new PriceError(`could not reach the FX service: ${(err as Error).message}`);
  }
  if (!resp.ok) {
    throw new PriceError(`FX service returned HTTP ${resp.status}`);
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
