/**
 * devkit — the **fake network** half of the data-pulling test harness.
 *
 * Data pulling is the no.1 pain point to debug because the *inputs* (what the
 * blob server, Twelve Data and Tiingo return) and the *triggers* (cache age,
 * credit budget, freshness) all live behind real HTTP. {@link FakeProvider} is a
 * single injectable {@link FetchLike} that stands in for every upstream the
 * companion talks to, so a developer (or a coding agent) can preset exactly what
 * each provider answers and then watch how the real fetchers in `prices.ts` /
 * `quotes.ts` / `blob.ts` react — with **zero** real network and zero secrets.
 *
 * It routes by host/path the same way the production code builds its URLs:
 *   - `api.twelvedata.com/quote`        → {@link TwelveDataConfig.quotes}
 *   - `api.twelvedata.com/time_series`  → {@link TwelveDataConfig.series}
 *   - `api.frankfurter.dev/.../latest`  → {@link FrankfurterConfig}
 *   - the configured blob/meta URLs     → {@link BlobConfig} (conditional 304s)
 *   - any URL containing "tiingo"       → {@link TiingoConfig}
 *
 * Every call is appended to {@link FakeProvider.requests} so the harness can show
 * a precise "this is what the system pulled" ledger. This module never reaches
 * the network and holds no credentials — it is pure, deterministic test scaffolding.
 */

import type { FetchLike } from "../prices";
import type { Envelope } from "../crypto";
import type { BlobMeta } from "../blob";

/** What category of upstream a recorded request hit. */
export type RequestKind =
  | "td-quote"
  | "td-time_series"
  | "frankfurter"
  | "blob"
  | "blob-meta"
  | "tiingo"
  | "unknown";

/** One row of the request ledger — the evidence of "what the system pulled". */
export interface RecordedRequest {
  /** Monotonic call index, 1-based, in dispatch order. */
  seq: number;
  kind: RequestKind;
  url: string;
  /** Symbols carried on the request (Twelve Data `symbol=`), if any. */
  symbols: string[];
  /** Conditional-fetch validators the caller sent (blob revalidation). */
  conditional: { ifNoneMatch?: string; ifModifiedSince?: string } | null;
  /** HTTP status the fake answered with. */
  status: number;
  /**
   * Twelve Data credits this call implies (one per symbol on `/quote` and
   * `/time_series`; zero elsewhere). Lets the harness show the credit cost of a
   * round even though the budget bookkeeping lives in `cache.ts`.
   */
  creditsImplied: number;
}

/** A single Twelve Data quote node, as the real `/quote` endpoint returns it. */
export interface TwelveDataQuote {
  /** Latest price (maps to the API `close`). */
  close?: string;
  previous_close?: string;
  currency?: string;
  /** `YYYY-MM-DD` (daily) or `YYYY-MM-DD HH:MM:SS` (intraday). */
  datetime?: string;
  /** Unix *seconds*; the genuine last-trade moment. */
  last_quote_at?: number;
  /** Unix *seconds*; the bar timestamp (only trusted for intraday datetimes). */
  timestamp?: number;
  is_market_open?: boolean;
}

/** A daily `time_series` bar (newest-first), as the real endpoint returns it. */
export interface TwelveDataBar {
  datetime: string;
  close: string;
}

/** Twelve Data behaviour: per-symbol answers, or a whole-call error. */
export interface TwelveDataConfig {
  /** `symbol → quote node` for `/quote`. A missing symbol answers as null. */
  quotes?: Record<string, TwelveDataQuote>;
  /** `symbol → daily bars` for `/time_series` (NAV / history). */
  series?: Record<string, TwelveDataBar[]>;
  /**
   * Force a top-level error body on the next call instead of data — the
   * over-quota / bad-key path. `429` is the breaker trigger; `401`/`403` are
   * fatal (a rejected key). Applies to both `/quote` and `/time_series`.
   */
  error?: { code: number; message?: string };
}

/** Frankfurter (ECB end-of-day) FX behaviour. */
export interface FrankfurterConfig {
  /** `currencyCode → units per 1 EUR`, e.g. `{ USD: "1.08" }`. */
  rates?: Record<string, string>;
  /** Answer with this HTTP status instead of 200 (e.g. 503). */
  status?: number;
}

/** Tiingo behaviour (matched by any URL containing "tiingo"). */
export interface TiingoConfig {
  /** Raw JSON body to answer with (shape depends on the endpoint under test). */
  body?: unknown;
  /** HTTP status to answer with (default 200). */
  status?: number;
}

/** The published blob server behaviour, including conditional-fetch handling. */
export interface BlobConfig {
  /** The blob URL the companion is pointed at (Settings → "Blob URL"). */
  url: string;
  /** The optional `portfolio.meta.json` sidecar URL. */
  metaUrl?: string;
  /** The encrypted envelope to serve (omit for a 404 "not published yet"). */
  envelope?: Envelope;
  /** The version sidecar to serve from {@link metaUrl}. */
  meta?: BlobMeta;
  /** The strong validator to advertise (drives `If-None-Match` → 304). */
  etag?: string;
  /** The weak validator to advertise (drives `If-Modified-Since` → 304). */
  lastModified?: string;
  /**
   * Force a non-conditional HTTP status (e.g. 404, 500). When set, conditional
   * revalidation is bypassed and this status is always returned.
   */
  status?: number;
}

/** The full upstream configuration the fake answers from. */
export interface FakeProviderConfig {
  twelveData?: TwelveDataConfig;
  frankfurter?: FrankfurterConfig;
  tiingo?: TiingoConfig;
  blob?: BlobConfig;
}

/** Minimal `Response` stand-in — the shape every fetcher in the app consumes. */
function makeResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const status = init.status ?? 200;
  const headers = init.headers ?? {};
  const normalised: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) normalised[k.toLowerCase()] = v;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string): string | null => normalised[name.toLowerCase()] ?? null },
    json: async (): Promise<unknown> => body,
    text: async (): Promise<string> => JSON.stringify(body),
  } as unknown as Response;
}

/** Build the body Twelve Data's `/quote` returns: a node for one, a map for many. */
function quoteBody(symbols: string[], quotes: Record<string, TwelveDataQuote>): unknown {
  const nodeFor = (s: string): unknown =>
    quotes[s] ? { ...quotes[s] } : { status: "error", message: `**symbol ${s} not found` };
  if (symbols.length === 1) {
    const node = quotes[symbols[0]];
    // Real API nests `symbol` alongside the node fields for a single request.
    return node ? { symbol: symbols[0], ...node } : nodeFor(symbols[0]);
  }
  const out: Record<string, unknown> = {};
  for (const s of symbols) out[s] = nodeFor(s);
  return out;
}

/** Build the body `time_series` returns: `{meta,values}` for one, a map for many. */
function seriesBody(symbols: string[], series: Record<string, TwelveDataBar[]>): unknown {
  const nodeFor = (s: string): unknown => ({
    meta: { symbol: s, currency: "USD", interval: "1day" },
    values: series[s] ?? [],
    status: series[s] ? "ok" : "error",
  });
  if (symbols.length === 1) return nodeFor(symbols[0]);
  const out: Record<string, unknown> = {};
  for (const s of symbols) out[s] = nodeFor(s);
  return out;
}

/**
 * A configurable, fully in-memory {@link FetchLike} that simulates every upstream
 * the companion pulls from and records every call. Pass `provider.fetch` wherever
 * a `fetchImpl` is accepted; read `provider.requests` afterwards to see the pull.
 */
export class FakeProvider {
  /** The ordered ledger of every request the system made through this fake. */
  readonly requests: RecordedRequest[] = [];
  private seq = 0;
  private config: FakeProviderConfig;

  constructor(config: FakeProviderConfig = {}) {
    this.config = config;
  }

  /** Replace the upstream configuration mid-scenario (e.g. flip TD to a 429). */
  configure(patch: FakeProviderConfig): void {
    this.config = { ...this.config, ...patch };
  }

  /** The injectable fetch. Bound so it can be passed as a bare `fetchImpl`. */
  readonly fetch: FetchLike = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const conditional = this.readConditional(init);
    const record = (kind: RequestKind, status: number, symbols: string[], credits: number): void => {
      this.requests.push({ seq: ++this.seq, kind, url: input, symbols, conditional, status, creditsImplied: credits });
    };

    // Twelve Data — quotes and daily series both spend one credit per symbol.
    if (url.hostname === "api.twelvedata.com") {
      const symbols = (url.searchParams.get("symbol") ?? "").split(",").filter((s) => s.length > 0);
      const td = this.config.twelveData ?? {};
      if (td.error) {
        const body = { code: td.error.code, status: "error", message: td.error.message ?? "error" };
        const httpStatus = td.error.code === 429 ? 429 : 200;
        const kind: RequestKind = url.pathname.includes("time_series") ? "td-time_series" : "td-quote";
        record(kind, httpStatus, symbols, 0);
        return makeResponse(body, { status: httpStatus });
      }
      if (url.pathname.includes("time_series")) {
        record("td-time_series", 200, symbols, symbols.length);
        return makeResponse(seriesBody(symbols, td.series ?? {}));
      }
      record("td-quote", 200, symbols, symbols.length);
      return makeResponse(quoteBody(symbols, td.quotes ?? {}));
    }

    // Frankfurter — the keyless ECB end-of-day FX fallback.
    if (url.hostname.includes("frankfurter")) {
      const fr = this.config.frankfurter ?? {};
      const status = fr.status ?? 200;
      record("frankfurter", status, [], 0);
      return makeResponse({ base: "EUR", rates: fr.rates ?? { USD: "1.08" } }, { status });
    }

    // Tiingo — matched loosely so any proxy/worker URL routes here.
    if (input.includes("tiingo")) {
      const ti = this.config.tiingo ?? {};
      const status = ti.status ?? 200;
      record("tiingo", status, [], 0);
      return makeResponse(ti.body ?? {}, { status });
    }

    // The published blob and its version sidecar.
    const blob = this.config.blob;
    if (blob) {
      if (blob.metaUrl && input === blob.metaUrl) {
        if (!blob.meta) {
          record("blob-meta", 404, [], 0);
          return makeResponse({}, { status: 404 });
        }
        record("blob-meta", 200, [], 0);
        return makeResponse({ ...blob.meta, published_at: blob.meta.publishedAt }, { status: 200 });
      }
      if (input === blob.url) {
        return this.serveBlob(blob, conditional, record);
      }
    }

    record("unknown", 404, [], 0);
    return makeResponse({ message: `no fake route for ${input}` }, { status: 404 });
  };

  /** Serve the blob, honouring conditional validators with a bodyless 304. */
  private serveBlob(
    blob: BlobConfig,
    conditional: RecordedRequest["conditional"],
    record: (kind: RequestKind, status: number, symbols: string[], credits: number) => void,
  ): Response {
    if (blob.status && blob.status !== 200) {
      record("blob", blob.status, [], 0);
      return makeResponse({}, { status: blob.status });
    }
    if (!blob.envelope) {
      record("blob", 404, [], 0);
      return makeResponse({}, { status: 404 });
    }
    const etagMatches = conditional?.ifNoneMatch && blob.etag && conditional.ifNoneMatch === blob.etag;
    const dateMatches =
      conditional?.ifModifiedSince && blob.lastModified && conditional.ifModifiedSince === blob.lastModified;
    if (etagMatches || dateMatches) {
      record("blob", 304, [], 0);
      return makeResponse(null, { status: 304 });
    }
    const headers: Record<string, string> = {};
    if (blob.etag) headers["ETag"] = blob.etag;
    if (blob.lastModified) headers["Last-Modified"] = blob.lastModified;
    record("blob", 200, [], 0);
    return makeResponse(blob.envelope, { status: 200, headers });
  }

  /** Pull the conditional validators a caller sent, if any. */
  private readConditional(init?: RequestInit): RecordedRequest["conditional"] {
    const raw = init?.headers;
    if (!raw) return null;
    const headers = raw as Record<string, string>;
    const ifNoneMatch = headers["If-None-Match"] ?? headers["if-none-match"];
    const ifModifiedSince = headers["If-Modified-Since"] ?? headers["if-modified-since"];
    if (!ifNoneMatch && !ifModifiedSince) return null;
    const out: { ifNoneMatch?: string; ifModifiedSince?: string } = {};
    if (ifNoneMatch) out.ifNoneMatch = ifNoneMatch;
    if (ifModifiedSince) out.ifModifiedSince = ifModifiedSince;
    return out;
  }

  /** Total Twelve Data credits implied by every recorded call so far. */
  totalCreditsImplied(): number {
    return this.requests.reduce((sum, r) => sum + r.creditsImplied, 0);
  }
}
