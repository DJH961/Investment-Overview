/**
 * The one place that says which cached queries a write (or a server event) makes
 * stale. G4 in docs/v6_speed_plan.md: no write may invalidate the whole app.
 *
 * Each entry lists query-key roots (the first element of the key). Projection
 * results are pure compounding over their own inputs, so they never appear here.
 */
import type { QueryClient } from "@tanstack/react-query";
import { runAsBackgroundRefetch } from "../api";

/** Everything that is computed from prices, FX or the ledger. */
export const REPORT_ROOTS = [
  "overview",
  "holdings",
  "graphs",
  "periods",
  "allocations",
  "analytics",
  "calculator",
  "deposits",
] as const;

export const INVALIDATION = {
  /** Create / edit / delete one transaction. */
  transactionWrite: [...REPORT_ROOTS, "transactions", "transaction", "diagnostics"],
  /** Confirm or undo an import: also new instruments, accounts and the batch list. */
  importWrite: [...REPORT_ROOTS, "transactions", "transaction", "import-batches", "instruments", "accounts", "diagnostics"],
  /** Rename / create / delete an account: its name shows in holdings, ledger rows, filters and Activity. */
  accountWrite: ["accounts", ...REPORT_ROOTS, "transactions", "transaction", "import-batches"],
  /** Names, classes and TERs show up in holdings, allocations, risk and the ledger rows. */
  // "graphs": a changed ETF twin redraws the 1D line.
  instrumentEdit: ["instruments", "overview", "holdings", "allocations", "analytics", "calculator", "deposits", "transactions", "graphs"],
  /** EUR returns are rebuilt server-side from the conversions; values and ledger rows are untouched. */
  fxConversionWrite: ["fx-conversions", "overview", "holdings", "graphs", "periods", "analytics", "calculator", "deposits"],
  /** Prices or FX moved (tick, fx event): the live numbers. */
  tick: ["overview", "holdings", "graphs", "periods", "allocations"],
  /** End-of-day jobs or a price refresh finished: every report. */
  refresh: [...REPORT_ROOTS, "diagnostics"],
} as const satisfies Record<string, readonly string[]>;

export type InvalidationKind = keyof typeof INVALIDATION;

/** Settings no report depends on (mirrors `read_cache.PRESENTATION_SETTINGS` on the server). */
export const PRESENTATION_SETTINGS: ReadonlySet<string> = new Set(["display_currency", "theme"]);

/** True when a settings write touched anything a report is computed from. */
export function settingsAffectReports(keys: readonly string[]): boolean {
  return keys.length === 0 ? false : keys.some((k) => !PRESENTATION_SETTINGS.has(k));
}

/** Maintenance jobs that never change report data. */
export function jobAffectsReports(job: unknown): boolean {
  return !String(job).startsWith("backup.");
}

/** True for a query that belongs to one of `roots` (projection results excluded). */
export function matchesRoots(queryKey: readonly unknown[], roots: readonly string[]): boolean {
  if (!roots.includes(String(queryKey[0]))) return false;
  return !(queryKey[0] === "calculator" && queryKey[1] === "projection");
}

/** Mark the queries of `kind` stale; the active ones refetch now. */
export function invalidateFor(queryClient: QueryClient, kind: InvalidationKind): Promise<void> {
  const roots: readonly string[] = INVALIDATION[kind];
  return queryClient.invalidateQueries({ predicate: (q) => matchesRoots(q.queryKey, roots) });
}

// ---- live (SSE) refetching ---------------------------------------------------

/** Ticks spread their refetch over 0..STAGGER_MS so a deploy or a busy minute never bursts. */
export const STAGGER_MS = 5000;

/** Mark the queries of `kind` stale without fetching (inactive ones refetch when opened). */
export function markStale(queryClient: QueryClient, kind: InvalidationKind): void {
  const roots: readonly string[] = INVALIDATION[kind];
  void queryClient.invalidateQueries({ predicate: (q) => matchesRoots(q.queryKey, roots), refetchType: "none" });
}

interface Pending {
  timer: ReturnType<typeof setTimeout>;
  kinds: Set<InvalidationKind>;
}
const pending = new WeakMap<QueryClient, Pending>();

/**
 * Refetch the ACTIVE queries of `kind` once, after a random 0..STAGGER_MS delay.
 * Further calls during the delay join the same refetch (their kinds are merged).
 */
export function scheduleRefetch(queryClient: QueryClient, kind: InvalidationKind): void {
  const existing = pending.get(queryClient);
  if (existing) {
    existing.kinds.add(kind);
    return;
  }
  const kinds = new Set<InvalidationKind>([kind]);
  const timer = setTimeout(() => {
    pending.delete(queryClient);
    const roots = new Set<string>([...kinds].flatMap((k) => INVALIDATION[k]));
    // Started by a tick, not the user: the server must not count it as activity.
    void runAsBackgroundRefetch(() =>
      queryClient.refetchQueries({ type: "active", predicate: (q) => matchesRoots(q.queryKey, [...roots]) }),
    ).catch(() => undefined);
  }, Math.random() * STAGGER_MS);
  pending.set(queryClient, { timer, kinds });
}

/** Refetch every active query once (staggered), e.g. after a restart. */
export function scheduleRefetchAllActive(queryClient: QueryClient): void {
  setTimeout(() => {
    void queryClient.refetchQueries({ type: "active", predicate: (q) => q.queryKey[0] !== "auth" }).catch(() => undefined);
  }, Math.random() * STAGGER_MS);
}

/** Stale now, refetch (active only, staggered) shortly. */
export function markStaleAndRefetch(queryClient: QueryClient, kind: InvalidationKind): void {
  markStale(queryClient, kind);
  scheduleRefetch(queryClient, kind);
}
