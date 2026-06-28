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
  /**
   * An **explicit** deferral born of a user-driven "update everything" request —
   * a "Reset base" or "Force-fetch every price now" pull that overflowed the
   * free-tier budget and had to be spread across rounds. These were created *to*
   * be re-pulled, so {@link DeferredQueue.drain} must **not** clear them on the
   * strength of a still-fresh cached value the way it does an ordinary
   * (auto-refresh) deferral: they stay queued — and are surfaced as still-missing
   * — until they are genuinely re-fetched ({@link DeferredQueue.clear}) or age out
   * via the retry cap. Sticky: once a symbol is parked as a force deferral it
   * stays one even if a later ordinary round re-defers it.
   */
  force: boolean;
}

/**
 * A serialisable snapshot of one parked symbol — what {@link DeferredQueue.snapshot}
 * emits and {@link DeferredQueue.restore} ingests, so the queue's "remember what
 * still needs updating" promise survives a reload (the **long-term** queue): a
 * symbol parked because no service could be reached is re-attempted on the next
 * session too, not silently forgotten when the tab is closed.
 */
export interface DeferredSnapshotEntry {
  symbol: string;
  reason: string;
  attempts: number;
  force: boolean;
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

  /**
   * Emit the queue's contents (insertion order preserved) as plain objects, so a
   * caller can persist the **long-term** queue across reloads. Pure: it neither
   * stores nor mutates anything.
   */
  snapshot(): DeferredSnapshotEntry[] {
    const out: DeferredSnapshotEntry[] = [];
    for (const [symbol, entry] of this.queue) {
      out.push({ symbol, reason: entry.reason, attempts: entry.attempts, force: entry.force });
    }
    return out;
  }

  /**
   * Repopulate an **empty** queue from a {@link snapshot}, preserving each
   * symbol's reason, attempt count and force flag (so a restored entry still
   * ages out via the retry cap rather than retrying forever). Malformed or
   * empty-symbol entries are skipped; the queue stays bounded (oldest evicted
   * first). A no-op once anything is already queued, so restoring can never clash
   * with live deferrals from the current session.
   */
  restore(entries: Iterable<DeferredSnapshotEntry>): void {
    if (this.queue.size > 0) return;
    for (const entry of entries) {
      const symbol = entry?.symbol;
      if (!symbol || this.queue.has(symbol)) continue;
      const attempts = Number.isFinite(entry.attempts) ? Math.max(0, Math.trunc(entry.attempts)) : 0;
      this.queue.set(symbol, {
        reason: typeof entry.reason === "string" ? entry.reason : "restored",
        attempts,
        force: entry.force === true,
      });
      while (this.queue.size > this.max) {
        const oldest = this.queue.keys().next().value;
        if (oldest === undefined) break;
        this.queue.delete(oldest);
      }
    }
  }

  /** Whether `symbol` is currently parked. */
  has(symbol: string): boolean {
    return this.queue.has(symbol);
  }

  /**
   * Whether any currently-parked symbol is an **explicit** force deferral (a
   * user-driven "update everything" pull — Reset base / Force-fetch every price /
   * a closed-market cache-distrust Refresh — that overflowed the budget). These
   * were created *to* be re-pulled, so a caller that would otherwise skip a round
   * (e.g. the automatic scheduler's "book fully up to date" short-circuit, which
   * judges a closed-market settled close already in hand as nothing-to-fetch) must
   * still run so {@link drain} can surface and re-pull them — otherwise they sit
   * "Updating…" indefinitely behind a freshness skip that does not know the user
   * asked for them.
   */
  hasForced(): boolean {
    for (const entry of this.queue.values()) {
      if (entry.force) return true;
    }
    return false;
  }

  /**
   * Park `symbols` with the given `reason`. Re-deferring an already-queued symbol
   * updates its reason but does **not** reset its attempt count (so a perpetually
   * deferred symbol still ages out). The queue is bounded: once it exceeds `max`,
   * the oldest entries are evicted first.
   *
   * `force` marks the deferral as an explicit user-driven "update everything" pull
   * (Reset base / Force-fetch every price now) that must survive the freshness
   * clear in {@link drain}. The flag is **sticky**: once a symbol is parked as a
   * force deferral, re-deferring it (even by an ordinary round) keeps it a force
   * deferral.
   */
  enqueue(symbols: Iterable<string>, reason: string, force = false): void {
    for (const symbol of symbols) {
      if (!symbol) continue;
      const existing = this.queue.get(symbol);
      if (existing) {
        existing.reason = reason;
        if (force) existing.force = true;
        continue;
      }
      this.queue.set(symbol, { reason, attempts: 0, force });
      while (this.queue.size > this.max) {
        const oldest = this.queue.keys().next().value;
        if (oldest === undefined) break;
        this.queue.delete(oldest);
      }
    }
  }

  /**
   * Forget `symbols` outright — used once a parked symbol has genuinely been
   * re-fetched this round, so its deferral promise is fulfilled and it should not
   * linger (which matters most for {@link DeferredEntry.force} entries, since they
   * bypass the freshness clear and would otherwise keep re-pulling until the retry
   * cap). Returns the symbols that were actually parked (for logging).
   */
  clear(symbols: Iterable<string>): string[] {
    const cleared: string[] = [];
    for (const symbol of symbols) {
      if (this.queue.delete(symbol)) cleared.push(symbol);
    }
    return cleared;
  }

  /**
   * Drain the queue. `hasFreshQuote(symbol)` reports whether the caches/blob have
   * since satisfied a symbol (so it is cleared, not re-fetched) — **except** for
   * {@link DeferredEntry.force} entries, which were explicitly created to be
   * re-pulled and therefore ignore the freshness clear entirely (they stay
   * still-missing until genuinely re-fetched via {@link clear} or aged out). Every
   * other entry has its attempt count incremented; those over the retry cap are
   * dropped, the rest are returned as still-missing. Cleared and dropped symbols
   * are removed from the queue; still-missing symbols remain parked for the next
   * drain.
   */
  drain(hasFreshQuote: (symbol: string) => boolean): DeferredDrainResult {
    const stillMissing: string[] = [];
    const clearedBySatisfied: string[] = [];
    const exhausted: string[] = [];
    for (const [symbol, entry] of [...this.queue]) {
      // An explicit force deferral was created *to* be re-pulled: never let a
      // still-fresh cached value optimise it away (the bug this guards against).
      if (!entry.force && hasFreshQuote(symbol)) {
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
