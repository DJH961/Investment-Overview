/**
 * devkit — the **harness** half of the data-pulling test framework.
 *
 * Pairs a {@link FakeProvider} (the fake network) with an in-memory
 * {@link MemoryStorage} (the cache) so a whole pull can be exercised end to end
 * without a browser, a real key, or a real server. A {@link Scenario} declares
 * three things a developer wants to preset when chasing a data-pull bug:
 *
 *   1. **cache condition** — what is already on the device ({@link Scenario.seedCache}),
 *   2. **blob / provider condition** — what each upstream answers ({@link Scenario.provider}),
 *   3. **the trigger** — either the pure pull *decision* ({@link Scenario.plan},
 *      run through the real `data-orchestrator`) and/or a real *execution*
 *      ({@link Scenario.run}, run through the real `quotes.ts` / `blob.ts` fetchers).
 *
 * {@link runScenario} returns a structured {@link ScenarioResult}; {@link formatResult}
 * renders it as a readable console block — the "what would it pull, and how did it
 * react" answer. Everything is deterministic (clock + storage + network injected),
 * so it is equally usable from a Vitest test or the {@link file://./cli.ts CLI}.
 */

import { readCachedEnvelope, readCachedQuotes, readCreditLog, type StorageLike } from "../cache";
import { fetchEnvelopeConditional, type ConditionalEnvelope } from "../blob";
import {
  loadEurUsd,
  loadFxRates,
  loadQuotes,
  type LoadEurUsdOptions,
  type LoadEurUsdResult,
  type LoadFxOptions,
  type LoadQuotesOptions,
  type QuoteLoadReport,
} from "../quotes";
import { type PriceError } from "../prices";
import { describePlan, planPull, type PullContext, type PullPlan } from "../data-orchestrator";
import { FakeProvider, type FakeProviderConfig, type RecordedRequest } from "./fake-provider";

/** A placeholder Twelve Data key. The fake ignores it; it is not a real secret. */
export const DEVKIT_FAKE_KEY = "DEVKIT-FAKE-KEY";

/**
 * A `localStorage`-shaped store backed by a plain `Map`, with inspection. Lets a
 * scenario seed cache state with the very same `cache.ts` writers the app uses,
 * then read the resulting blob back out for the report.
 */
export class MemoryStorage implements StorageLike {
  private readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  /** A shallow copy of every stored key → raw value, for diffing/printing. */
  dump(): Record<string, string> {
    return Object.fromEntries(this.map.entries());
  }
}

/** What real fetcher a scenario exercises, and with what inputs. */
export type ScenarioRun =
  | { kind: "quotes"; symbols: string[]; apiKey?: string; options?: LoadQuotesOptions }
  | { kind: "fx"; options?: LoadFxOptions }
  | { kind: "eurusd"; apiKey?: string; options?: LoadEurUsdOptions }
  | { kind: "blob" };

/** A complete, self-contained data-pull situation to exercise. */
export interface Scenario {
  /** A short identifier used on the CLI (`npm run data-pull -- <name>`). */
  name: string;
  /** One-line human summary of what this scenario probes. */
  description?: string;
  /** The injected wall clock for the whole run (epoch ms). */
  nowMs: number;
  /**
   * Seed the device cache before the run, using the real `cache.ts` writers
   * (`writeCachedQuotes`, `recordCredits`, `writeCachedEnvelope`, …) against the
   * provided storage and clock. This is the "cache condition" preset.
   */
  seedCache?: (storage: MemoryStorage, nowMs: number) => void;
  /** The "blob / provider condition" preset — what each upstream answers. */
  provider?: FakeProviderConfig;
  /**
   * The pull *decision* to evaluate through the real orchestrator: "given this
   * freshness, what would the system pull?". `nowMs`/`autoIntervalMs` come from
   * the context. Optional — omit to only exercise a real fetch.
   */
  plan?: PullContext;
  /** The real fetch to execute and observe. Optional — omit for a plan-only probe. */
  run?: ScenarioRun;
}

/** A compact, printable view of one resolved quote. */
export interface QuoteView {
  symbol: string;
  price: string | null;
  currency: string | null;
  source: "fetched" | "cache" | "deferred" | "failed" | "absent";
}

/** Everything {@link runScenario} observed. */
export interface ScenarioResult {
  scenario: Scenario;
  /** The orchestrator's verdict, when {@link Scenario.plan} was supplied. */
  plan: PullPlan | null;
  /** Every request the system made through the fake, in order. */
  requests: RecordedRequest[];
  /** Twelve Data credits the recorded calls imply. */
  creditsImplied: number;
  /** The quote-load report, when a `quotes` run executed. */
  quoteReport: QuoteLoadReport | null;
  /** A compact per-symbol view, when a `quotes` run executed. */
  quotes: QuoteView[] | null;
  /** The FX outcome, when an `fx` run executed. */
  fx: { base: string; rates: Record<string, string>; cached: boolean; error: PriceError | null } | null;
  /** The EUR/USD outcome, when an `eurusd` run executed. */
  eurusd: LoadEurUsdResult | null;
  /** The blob outcome, when a `blob` run executed. */
  blob: { status: ConditionalEnvelope["status"]; usedConditional: boolean } | null;
  /** Credits already spent in the trailing-day window after the run. */
  creditsSpentInDay: number;
}

/** Run one scenario end to end and collect everything that happened. */
export async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const storage = new MemoryStorage();
  const now = (): number => scenario.nowMs;
  if (scenario.seedCache) scenario.seedCache(storage, scenario.nowMs);

  const provider = new FakeProvider(scenario.provider ?? {});
  const plan = scenario.plan ? planPull(scenario.plan) : null;

  let quoteReport: QuoteLoadReport | null = null;
  let quotes: QuoteView[] | null = null;
  let fx: ScenarioResult["fx"] = null;
  let eurusd: LoadEurUsdResult | null = null;
  let blob: ScenarioResult["blob"] = null;

  if (scenario.run) {
    switch (scenario.run.kind) {
      case "quotes": {
        const out = await loadQuotes(scenario.run.symbols, scenario.run.apiKey ?? DEVKIT_FAKE_KEY, {
          fetchImpl: provider.fetch,
          storage,
          now,
          ...scenario.run.options,
        });
        quoteReport = out.report;
        quotes = summariseQuotes(scenario.run.symbols, out.quotes, out.report);
        break;
      }
      case "fx": {
        const out = await loadFxRates({ fetchImpl: provider.fetch, storage, now, ...scenario.run.options });
        fx = {
          base: out.fx.base,
          rates: Object.fromEntries(Object.entries(out.fx.rates).map(([k, v]) => [k, v.toString()])),
          cached: out.cached,
          error: out.error,
        };
        break;
      }
      case "eurusd": {
        eurusd = await loadEurUsd(scenario.run.apiKey ?? DEVKIT_FAKE_KEY, {
          fetchImpl: provider.fetch,
          storage,
          now,
          ...scenario.run.options,
        });
        break;
      }
      case "blob": {
        const cached = readCachedEnvelope(storage);
        const validators = cached ? { etag: cached.etag, lastModified: cached.lastModified } : null;
        const url = scenario.provider?.blob?.url ?? "";
        // `fetchEnvelopeConditional` is typed against the DOM `fetch`; the fake
        // is the string-input `FetchLike` the rest of the app uses (and only
        // ever receives a string URL here), so this widening is safe.
        const blobFetch = provider.fetch as unknown as typeof fetch;
        const out = await fetchEnvelopeConditional(url, validators, blobFetch);
        blob = { status: out.status, usedConditional: validators !== null };
        break;
      }
    }
  }

  return {
    scenario,
    plan,
    requests: provider.requests,
    creditsImplied: provider.totalCreditsImplied(),
    quoteReport,
    quotes,
    fx,
    eurusd,
    blob,
    creditsSpentInDay: readCreditLog(scenario.nowMs, 24 * 60 * 60 * 1000, storage).reduce((s, e) => s + e.n, 0),
  };
}

/** Fold the resolved quotes + report into a compact per-symbol view. */
function summariseQuotes(
  symbols: string[],
  resolved: Map<string, { price: { toString(): string } | null; currency: string | null }>,
  report: QuoteLoadReport,
): QuoteView[] {
  const sourceOf = (s: string): QuoteView["source"] => {
    if (report.fetched.includes(s)) return "fetched";
    if (report.servedFresh.includes(s)) return "cache";
    if (report.failed.includes(s)) return "failed";
    if (report.deferred.includes(s)) return "deferred";
    return "absent";
  };
  return symbols.map((s) => {
    const q = resolved.get(s);
    return {
      symbol: s,
      price: q?.price ? q.price.toString() : null,
      currency: q?.currency ?? null,
      source: sourceOf(s),
    };
  });
}

/** Render a {@link ScenarioResult} as a readable, copy-pasteable console block. */
export function formatResult(result: ScenarioResult): string {
  const lines: string[] = [];
  const sc = result.scenario;
  lines.push(`━━ ${sc.name} ━━`);
  if (sc.description) lines.push(sc.description);
  lines.push(`now: ${new Date(sc.nowMs).toISOString()}`);

  if (result.plan) {
    lines.push("");
    lines.push(`PLAN (what the orchestrator would pull):`);
    lines.push(`  ${describePlan(result.plan)}`);
  }

  lines.push("");
  if (result.requests.length === 0) {
    lines.push(`REQUESTS: none — the system pulled nothing.`);
  } else {
    lines.push(`REQUESTS (what the system actually pulled):`);
    for (const r of result.requests) {
      const sym = r.symbols.length > 0 ? ` [${r.symbols.join(",")}]` : "";
      const cond = r.conditional
        ? ` (conditional: ${r.conditional.ifNoneMatch ? `If-None-Match=${r.conditional.ifNoneMatch}` : ""}${
            r.conditional.ifModifiedSince ? `If-Modified-Since=${r.conditional.ifModifiedSince}` : ""
          })`
        : "";
      const credits = r.creditsImplied > 0 ? ` — ${r.creditsImplied} credit(s)` : "";
      lines.push(`  #${r.seq} ${r.kind} → HTTP ${r.status}${sym}${cond}${credits}`);
    }
    lines.push(`  total Twelve Data credits implied: ${result.creditsImplied}`);
  }

  if (result.quotes) {
    lines.push("");
    lines.push(`QUOTES (how each symbol resolved):`);
    for (const q of result.quotes) {
      lines.push(`  ${q.symbol}: ${q.price ?? "—"}${q.currency ? ` ${q.currency}` : ""} (${q.source})`);
    }
    if (result.quoteReport) {
      const r = result.quoteReport;
      lines.push(
        `  report: fetched=${r.fetched.length} cache=${r.servedFresh.length} ` +
          `deferred=${r.deferred.length} failed=${r.failed.length}` +
          (r.error ? ` error="${r.error.message}"` : ""),
      );
      lines.push(`  budget remaining: minute=${r.minuteRemaining} day=${r.dayRemaining}`);
    }
  }

  if (result.fx) {
    lines.push("");
    const rates = Object.entries(result.fx.rates)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    lines.push(`FX: base=${result.fx.base} {${rates}} cached=${result.fx.cached}${result.fx.error ? ` error="${result.fx.error.message}"` : ""}`);
  }

  if (result.eurusd) {
    const e = result.eurusd;
    lines.push("");
    lines.push(
      `EUR/USD: now=${e.now ? e.now.toString() : "—"} prevClose=${e.previousClose ? e.previousClose.toString() : "—"} ` +
        `source=${e.source} cached=${e.cached}${e.error ? ` error="${e.error.message}"` : ""}`,
    );
  }

  if (result.blob) {
    lines.push("");
    lines.push(`BLOB: ${result.blob.status}${result.blob.usedConditional ? " (sent conditional validators)" : ""}`);
  }

  return lines.join("\n");
}

/** Convenience: run a scenario and return its formatted block in one call. */
export async function runAndFormat(scenario: Scenario): Promise<string> {
  return formatResult(await runScenario(scenario));
}

/** Re-export the cache reader the CLI uses to print the post-run quote cache. */
export { readCachedQuotes };
