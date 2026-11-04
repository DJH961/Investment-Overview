/**
 * Warm the cache right after sign-in / app start, so the first tap on a page
 * or a graph range shows data instead of a spinner.
 *
 * Requests run one after another (the server is a small box) in the order the
 * owner is most likely to need them, and only for what is missing or stale:
 * `prefetchQuery` skips anything still fresh, so reopening the app costs
 * nothing extra.
 */
import type { QueryClient } from "@tanstack/react-query";
import { STORAGE_PREFIX } from "./usePersistentState";
import type { ReportingCurrency } from "./prefs";
import type { HoldingsGroupBy } from "./queries/holdings";
import {
  allocationsQuery,
  GRAPH_RANGES,
  graphQuery,
  holdingsQuery,
  overviewQuery,
  type GraphRange,
} from "./queries/portfolio";
import { accountsQuery } from "./queries/accounts";
import { dividendsQuery, depositsQuery } from "./queries/activity";
import { instrumentsQuery } from "./queries/instruments";
import { ledgerAllQuery } from "./queries/ledgerAll";
import {
  analyticsQuery,
  calculatorInputsQuery,
  DEFAULT_LOOKBACK_DAYS,
  periodsQuery,
} from "./queries/reports";
import { settingsSchemaQuery, settingsValuesQuery } from "./queries/settings";

function stored<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

/** The ledger-side pages (no reporting currency involved). */
function ledgerJobs() {
  return [
    instrumentsQuery(),
    accountsQuery(),
    ledgerAllQuery(),
    settingsSchemaQuery(),
    settingsValuesQuery(),
  ];
}

/** Every report page's default query, most likely first. One fetch each: it holds both currencies. */
function reportJobs(ccy: ReportingCurrency) {
  const range = stored<GraphRange>("chart.overview.range");
  const first = range && GRAPH_RANGES.includes(range) ? range : null;
  const groupBy = stored<HoldingsGroupBy>("holdings.group") ?? "none";
  const lookback = Number(stored<string>("risk.lookback") ?? DEFAULT_LOOKBACK_DAYS);
  const ranges = first ? [first, ...GRAPH_RANGES.filter((r) => r !== first)] : GRAPH_RANGES;
  return [
    overviewQuery(ccy),
    ...(first ? [graphQuery(first, ccy)] : []),
    holdingsQuery(ccy, groupBy),
    periodsQuery("monthly", ccy),
    periodsQuery("yearly", ccy),
    ...ranges.filter((r) => r !== first).map((r) => graphQuery(r, ccy)),
    allocationsQuery(ccy),
    calculatorInputsQuery(ccy),
    analyticsQuery(ccy, Number.isFinite(lookback) && lookback > 0 ? lookback : DEFAULT_LOOKBACK_DAYS),
    depositsQuery(ccy),
    dividendsQuery(ccy),
  ];
}

/**
 * The jobs in priority order (exported for tests): everything reachable from the
 * nav, one request per page. The `/both` responses already hold the other
 * currency, so a currency switch is a cache hit with no request (G6).
 */
export function prefetchPlan(ccy: ReportingCurrency) {
  return [...reportJobs(ccy), ...ledgerJobs()];
}

/** Wait for the browser to be idle (max 2 s), so prefetching never competes with taps. */
function idle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout: 2000 });
    else setTimeout(resolve, 0);
  });
}

const QUIET_POLL_MS = 250;
const QUIET_MAX_MS = 15_000;

/**
 * Wait until no other query is loading (the page on screen, a refetch after a tick),
 * at most 15 s. The server has one CPU: a background prefetch must never queue in
 * front of what the user is looking at. Exported for tests.
 */
export async function quiet(qc: QueryClient, signal?: AbortSignal): Promise<void> {
  const began = Date.now();
  while (qc.isFetching() > 0 && Date.now() - began < QUIET_MAX_MS) {
    if (signal?.aborted) return;
    await new Promise((r) => setTimeout(r, QUIET_POLL_MS));
  }
}

/**
 * Run the plan one request at a time, each only when nothing else is loading and the
 * browser is idle; stops early when `signal` aborts (sign-out, unmount).
 */
export async function prefetchKeyData(qc: QueryClient, ccy: ReportingCurrency, signal?: AbortSignal): Promise<void> {
  for (const options of prefetchPlan(ccy)) {
    if (signal?.aborted) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    await quiet(qc, signal);
    await idle();
    if (signal?.aborted) return;
    // Errors are fine here: the page retries when it actually opens.
    await qc.prefetchQuery(options as Parameters<QueryClient["prefetchQuery"]>[0]).catch(() => undefined);
  }
}
