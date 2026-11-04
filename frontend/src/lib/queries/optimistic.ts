/**
 * Optimistic-write helper (G3): cancel in-flight reads, remember what was cached,
 * apply the user's edit to the cached list/object, and hand back a rollback.
 * Derived numbers (totals, returns) are never computed here: callers invalidate those
 * through ./invalidation once the write settles.
 */
import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";

export interface OptimisticContext {
  snapshots: Array<[QueryKey, unknown]>;
}

/**
 * Apply `update` to every cached query matched by `predicate` that holds data.
 * `update` returns the new value, or `undefined` to leave that entry alone.
 */
export async function applyOptimistic(
  qc: QueryClient,
  predicate: (q: Query) => boolean,
  update: (old: unknown, key: QueryKey) => unknown,
): Promise<OptimisticContext> {
  await qc.cancelQueries({ predicate });
  const snapshots: Array<[QueryKey, unknown]> = [];
  for (const q of qc.getQueryCache().findAll({ predicate })) {
    const old = q.state.data;
    if (old === undefined) continue;
    const next = update(old, q.queryKey);
    if (next === undefined) continue;
    snapshots.push([q.queryKey, old]);
    qc.setQueryData(q.queryKey, next);
  }
  return { snapshots };
}

/** Put every snapshot back (the write failed). */
export function rollback(qc: QueryClient, ctx: OptimisticContext | undefined): void {
  if (!ctx) return;
  for (const [key, data] of ctx.snapshots) qc.setQueryData(key, data);
}

export const byRoot =
  (root: string, second?: string) =>
  (q: Query): boolean =>
    q.queryKey[0] === root && (second === undefined || q.queryKey[1] === second);
