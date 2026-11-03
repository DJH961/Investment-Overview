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
import { periodsQuery } from "./queries/reports";

function stored<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

/** The jobs in priority order (exported for tests). */
export function prefetchPlan(ccy: ReportingCurrency) {
  const range = stored<GraphRange>("chart.overview.range");
  const first = range && GRAPH_RANGES.includes(range) ? range : null;
  const groupBy = stored<HoldingsGroupBy>("holdings.group") ?? "none";
  const ranges = first ? [first, ...GRAPH_RANGES.filter((r) => r !== first)] : GRAPH_RANGES;
  return [
    overviewQuery(ccy),
    ...(first ? [graphQuery(first, ccy)] : []),
    holdingsQuery(ccy, groupBy),
    periodsQuery("monthly", ccy),
    periodsQuery("yearly", ccy),
    ...ranges.filter((r) => r !== first).map((r) => graphQuery(r, ccy)),
    allocationsQuery(ccy),
  ];
}

/** Run the plan sequentially; stops early when `signal` aborts (sign-out, unmount). */
export async function prefetchKeyData(qc: QueryClient, ccy: ReportingCurrency, signal?: AbortSignal): Promise<void> {
  for (const options of prefetchPlan(ccy)) {
    if (signal?.aborted) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    // Errors are fine here: the page retries when it actually opens.
    await qc.prefetchQuery(options as Parameters<QueryClient["prefetchQuery"]>[0]).catch(() => undefined);
  }
}
