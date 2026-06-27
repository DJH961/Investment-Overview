/**
 * devkit — a library of **built-in example scenarios**.
 *
 * These are the data-pull situations that recur when debugging the companion's
 * no.1 pain point: a fresh cache that should pull nothing, a stale cache that
 * fetches, a near-budget device that defers, a 429 from Twelve Data, and the
 * blob revalidation 304/changed paths. Each is a worked, runnable example of how
 * to phrase a {@link Scenario}; copy one and tweak the cache/provider preset to
 * reproduce a specific bug. The CLI runs them by name (or `all`).
 */

import { Decimal } from "../decimal-config";
import { recordCredits, writeCachedEnvelope, writeCachedQuotes } from "../cache";
import type { Quote } from "../prices";
import type { Envelope } from "../crypto";
import type { PullContext } from "../data-orchestrator";
import type { MemoryStorage, Scenario } from "./harness";

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** A fixed reference clock so every example is deterministic. */
const NOW = Date.parse("2024-01-10T15:00:00Z");

/**
 * A clearly-**closed** US market clock (Saturday) for scenarios that probe the
 * "tap Refresh while the exchange is shut" path: the cache already holds the
 * latest settled close, so nothing is stale.
 */
const NOW_CLOSED = Date.parse("2024-01-13T20:00:00Z");

/** A dummy AES-256-GCM envelope (opaque ciphertext; safe, decrypts to nothing). */
const SAMPLE_ENVELOPE: Envelope = {
  v: 1,
  kdf: "PBKDF2-HMAC-SHA256",
  kdf_params: { salt: "ZGV2a2l0LXNhbHQtMTY=", iterations: 600000 },
  nonce: "ZGV2a2l0LW5vbmNl",
  ciphertext: "ZGV2a2l0LWNpcGhlcnRleHQtcGxhY2Vob2xkZXI=",
  tag: "ZGV2a2l0LXRhZy0xMjM0NTY3OA==",
};

/** Build a cached {@link Quote} for seeding the device quote cache. */
function quote(symbol: string, price: string, currency = "USD"): Quote {
  return {
    symbol,
    price: new Decimal(price),
    previousClose: new Decimal(price).minus(1),
    currency,
    priceTime: NOW,
    valueDate: "2024-01-10",
    marketOpen: true,
  };
}

/** Seed N quotes into the device cache, stamped `ageMs` before `now`. */
function seedQuotes(storage: MemoryStorage, nowMs: number, quotes: Quote[], ageMs: number): void {
  const map = new Map<string, Quote>(quotes.map((q) => [q.symbol, q]));
  writeCachedQuotes(map, nowMs - ageMs, storage);
}

/**
 * 14 symbols — more than the free tier's 8 credits/minute — for the
 * `forced-closed-defer` scenario: a force-pull splits them 8 fetched / 6
 * deferred under the per-minute cap.
 */
const FORCED_CLOSED_SYMBOLS: readonly string[] = Array.from({ length: 14 }, (_, i) => `SYM${i + 1}`);

/** A full pull-decision context with sane defaults, overridable per scenario. */
function context(overrides: Partial<PullContext> = {}): PullContext {
  return {
    kind: "auto",
    nowMs: NOW,
    market: "open",
    minutesSinceOpenMs: 2 * HOUR_MS,
    autoIntervalMs: 5 * MINUTE_MS,
    freshness: {
      dataAgeMs: 30 * 1000,
      deviceDaysMissing: 0,
      blobDaysOld: 0,
      quoteAgeMs: 30 * 1000,
      fxAgeMs: 30 * 1000,
      navHeldForToday: true,
    },
    barGate: { lastBarPullMs: NOW - 5 * MINUTE_MS, sessionOpenMs: NOW - 2 * HOUR_MS },
    ...overrides,
  };
}

/** The built-in scenario library, keyed by `name`. */
export const SCENARIOS: Scenario[] = [
  {
    name: "fresh-noop",
    description: "Everything on the device is fresh — the orchestrator should pull nothing.",
    nowMs: NOW,
    plan: context(),
  },
  {
    name: "stale-quotes",
    description: "Empty cache, market open: a quotes run fetches every symbol from Twelve Data.",
    nowMs: NOW,
    provider: {
      twelveData: {
        quotes: {
          AAPL: { close: "190", previous_close: "188", currency: "USD", datetime: "2024-01-10" },
          MSFT: { close: "410", previous_close: "405", currency: "USD", datetime: "2024-01-10" },
        },
      },
    },
    plan: context({
      kind: "manual",
      freshness: {
        dataAgeMs: 5 * HOUR_MS,
        deviceDaysMissing: 1,
        blobDaysOld: 0,
        quoteAgeMs: 5 * HOUR_MS,
        navHeldForToday: false,
      },
    }),
    run: { kind: "quotes", symbols: ["AAPL", "MSFT"] },
  },
  {
    name: "near-budget",
    description:
      "Only 1 daily credit left: a 3-symbol quotes run fetches what it can and defers the rest to stay in budget.",
    nowMs: NOW,
    seedCache: (storage, nowMs) => {
      // Burn 799 of the 800 daily free-tier credits earlier today.
      recordCredits(799, nowMs - 2 * HOUR_MS, storage);
    },
    provider: {
      twelveData: {
        quotes: {
          AAPL: { close: "190", previous_close: "188", currency: "USD", datetime: "2024-01-10" },
          MSFT: { close: "410", previous_close: "405", currency: "USD", datetime: "2024-01-10" },
          GOOG: { close: "140", previous_close: "139", currency: "USD", datetime: "2024-01-10" },
        },
      },
    },
    run: { kind: "quotes", symbols: ["AAPL", "MSFT", "GOOG"], options: { forceMarketFetch: true } },
  },
  {
    name: "td-429",
    description: "Twelve Data answers 429 (rate-limited): the run reports a transient error and falls back to cache.",
    nowMs: NOW,
    seedCache: (storage, nowMs) => {
      // A day-old cached quote is available to fall back on.
      seedQuotes(storage, nowMs, [quote("AAPL", "189")], 26 * HOUR_MS);
    },
    provider: { twelveData: { error: { code: 429, message: "API credits exhausted" } } },
    run: { kind: "quotes", symbols: ["AAPL"], options: { forceMarketFetch: true, maxRetries: 0 } },
  },
  {
    name: "forced-closed-defer",
    description:
      "Market shut, 14 fresh-cached symbols, user distrusts the cache and force-pulls every price: 8 fetch now, 6 defer to the next minute — none skipped for being fresh.",
    nowMs: NOW_CLOSED,
    seedCache: (storage, nowMs) => {
      // Every symbol already holds a fresh, settled close (1 minute old, well
      // inside the rolling TTL). Without forcing, all 14 would be served from
      // cache and nothing fetched — so this proves the force is what fetches.
      seedQuotes(storage, nowMs, FORCED_CLOSED_SYMBOLS.map((s) => quote(s, "100")), MINUTE_MS);
    },
    provider: {
      twelveData: {
        quotes: Object.fromEntries(
          FORCED_CLOSED_SYMBOLS.map((s) => [
            s,
            { close: "101", previous_close: "100", currency: "USD", datetime: "2024-01-12" },
          ]),
        ),
      },
    },
    // `forceFetch: () => true` mirrors the app's "Force-fetch every price now"
    // (distrust-the-cache) escape hatch: every symbol is opted in regardless of
    // how fresh its cache is. The free-tier per-minute cap (8) then fetches the
    // first 8 and defers the rest — exactly the clean deferral pathway.
    run: { kind: "quotes", symbols: [...FORCED_CLOSED_SYMBOLS], options: { forceFetch: () => true } },
  },
  {
    name: "blob-304",
    description: "Cached blob validator matches the server ETag — a conditional fetch returns 304, no re-download.",
    nowMs: NOW,
    seedCache: (storage, nowMs) => {
      writeCachedEnvelope(SAMPLE_ENVELOPE, nowMs - HOUR_MS, { etag: '"v1"' }, storage);
    },
    provider: {
      blob: { url: "https://blob.example/portfolio.enc", envelope: SAMPLE_ENVELOPE, etag: '"v1"' },
    },
    run: { kind: "blob" },
  },
  {
    name: "blob-changed",
    description: "A newer blob is published (ETag differs): the conditional fetch downloads the fresh envelope.",
    nowMs: NOW,
    seedCache: (storage, nowMs) => {
      writeCachedEnvelope(SAMPLE_ENVELOPE, nowMs - HOUR_MS, { etag: '"v1"' }, storage);
    },
    provider: {
      blob: { url: "https://blob.example/portfolio.enc", envelope: SAMPLE_ENVELOPE, etag: '"v2"' },
    },
    run: { kind: "blob" },
  },
  {
    name: "fx-ecb",
    description: "FX with an empty cache falls through to the Frankfurter (ECB) end-of-day rate.",
    nowMs: NOW,
    provider: { frankfurter: { rates: { USD: "1.0850", GBP: "0.8600" } } },
    run: { kind: "fx" },
  },
  {
    name: "first-login",
    description: "A reset (heaviest escape hatch) plans a full re-pull of every leg.",
    nowMs: NOW,
    plan: context({
      kind: "reset",
      freshness: {
        dataAgeMs: 10 * 24 * HOUR_MS,
        deviceDaysMissing: 10,
        blobDaysOld: 10,
        quoteAgeMs: 10 * 24 * HOUR_MS,
        navHeldForToday: false,
      },
    }),
  },
];

/** Look up a built-in scenario by name. */
export function findScenario(name: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.name === name);
}
