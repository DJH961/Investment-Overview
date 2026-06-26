/**
 * C9 — the **deferred work-queue** (`docs/single_brain_pull_plan.md` §"C9 — A
 * real work-queue for deferrals").
 *
 * When a pull cannot fit every symbol into the free-tier minute, the overflow is
 * *deferred*. The bug C9 fixes is that a deferral used to be a silent hope: the
 * symbol simply wasn't fetched and nothing tracked it, so an entry could vanish
 * unlogged and a fund could stay stale until the blob happened to rescue it.
 *
 * This queue makes a deferral an accountable promise. Each parked symbol carries
 * the reason it was parked and an attempt count. On the next round the queue is
 * **drained**: any symbol the caches/blob have since satisfied is cleared (with a
 * logged reason, never re-fetched); a symbol that has been retried too many times
 * is dropped (logged) instead of bursting forever; the rest are returned as the
 * still-missing set the round must pull. The queue is bounded so a flood of
 * deferrals can never grow without limit (oldest evicted first).
 *
 * It is deliberately **pure** (no storage, no clock, no logging) so the bookkeeping
 * is unit-testable in isolation (`web/test/deferred-queue.test.ts`); the caller
 * (`app.ts`) owns the cache lookup and the polling-log lines.
 */

/** Default cap on how many parked symbols are tracked (oldest evicted first). */
export const DEFERRED_QUEUE_MAX = 64;

/** Default per-symbol retry cap before a never-filling entry is dropped. */
export const DEFERRED_MAX_ATTEMPTS = 4;

/** A single parked symbol: why it was deferred and how many drains it has survived. */
interface DeferredEntry {
  reason: string;
  attempts: number;
}

/** The categorised outcome of a single {@link DeferredQueue.drain}. */
export interface DeferredDrainResult {
  /** Symbols that still need a pull this round (returned to the caller). */
  stillMissing: string[];
  /** Symbols cleared because a fresh cached/blob quote now exists (never re-fetched). */
  clearedBySatisfied: string[];
  /** Symbols dropped after exceeding the retry cap. */
  exhausted: string[];
}

/**
 * A bounded, retry-capped queue of budget-deferred symbols. Insertion order is
 * preserved (a `Map`), so eviction and draining are deterministic and testable.
 */
export class DeferredQueue {
  private readonly queue = new Map<string, DeferredEntry>();

  constructor(
    private readonly max: number = DEFERRED_QUEUE_MAX,
    private readonly maxAttempts: number = DEFERRED_MAX_ATTEMPTS,
  ) {}

  /** How many symbols are currently parked. */
  get size(): number {
    return this.queue.size;
  }

  /** Whether `symbol` is currently parked. */
  has(symbol: string): boolean {
    return this.queue.has(symbol);
  }

  /**
   * Park `symbols` with the given `reason`. Re-deferring an already-queued symbol
   * updates its reason but does **not** reset its attempt count (so a perpetually
   * deferred symbol still ages out). The queue is bounded: once it exceeds `max`,
   * the oldest entries are evicted first.
   */
  enqueue(symbols: Iterable<string>, reason: string): void {
    for (const symbol of symbols) {
      if (!symbol) continue;
      const existing = this.queue.get(symbol);
      if (existing) {
        existing.reason = reason;
        continue;
      }
      this.queue.set(symbol, { reason, attempts: 0 });
      while (this.queue.size > this.max) {
        const oldest = this.queue.keys().next().value;
        if (oldest === undefined) break;
        this.queue.delete(oldest);
      }
    }
  }

  /**
   * Drain the queue. `hasFreshQuote(symbol)` reports whether the caches/blob have
   * since satisfied a symbol (so it is cleared, not re-fetched). Every other entry
   * has its attempt count incremented; those over the retry cap are dropped, the
   * rest are returned as still-missing. Cleared and dropped symbols are removed
   * from the queue; still-missing symbols remain parked for the next drain.
   */
  drain(hasFreshQuote: (symbol: string) => boolean): DeferredDrainResult {
    const stillMissing: string[] = [];
    const clearedBySatisfied: string[] = [];
    const exhausted: string[] = [];
    for (const [symbol, entry] of [...this.queue]) {
      if (hasFreshQuote(symbol)) {
        clearedBySatisfied.push(symbol);
        this.queue.delete(symbol);
        continue;
      }
      entry.attempts += 1;
      if (entry.attempts > this.maxAttempts) {
        exhausted.push(symbol);
        this.queue.delete(symbol);
        continue;
      }
      stillMissing.push(symbol);
    }
    return { stillMissing, clearedBySatisfied, exhausted };
  }
}
