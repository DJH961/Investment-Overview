/**
 * Pillar 2 (WS5) — the **two-step login handshake**, as a pure reconcile-diff
 * (`docs/centralized_data_pull_plan.md` §"Pillar 2 — Never stale on login").
 *
 * Login is two steps that cooperate through the freshness ledger so they are
 * **additive, never redundant**:
 *
 *  1. **Step 1 — prefetch (may start before unlock).** Pull what the *predicted*
 *     symbol set (last-known holdings) + market state say we need, against the
 *     ledger. It books a set of symbols (and FX).
 *  2. **Step 2 — post-decrypt reconcile.** Decrypting the blob reveals the truth —
 *     the blob is staler than predicted, or a **newly-bought symbol** appeared.
 *     Step 2 pulls **only the diff**, deduped against Step 1 via the same ledger,
 *     so it can never re-fetch what Step 1 already booked. A seconds-later
 *     re-login finds everything inside its freshness window and pulls nothing — no
 *     special re-login guard is needed.
 *
 * This module is **pure** so the dedup rules are unit-testable in isolation
 * (`web/test/login-handshake.test.ts`); the caller dispatches the resulting diff
 * to the existing fetchers under the reservation + breaker authority and logs the
 * returned {@link reason} so the handshake is never undiscoverable.
 */

/** What Step 1 (the prefetch) actually booked, so Step 2 can dedup against it. */
export interface PrefetchBooked {
  /** Market/NAV symbols Step 1 already fetched (or has in flight). */
  symbols: string[];
  /** Whether Step 1 already pulled EUR/USD FX. */
  fx: boolean;
}

/** The truth the decrypted blob reveals, judged against the freshness ledger. */
export interface PostDecryptTruth {
  /**
   * The book's *actual* current symbols (from the decrypted holdings) that are
   * **stale** per the freshness ledger — i.e. still need a pull. A symbol the
   * ledger considers fresh is omitted (it is already inside its window).
   */
  staleSymbols: string[];
  /** Whether FX is still stale per the ledger after Step 1. */
  fxStale: boolean;
}

/** The Step-2 diff: only what Step 1 missed and the ledger still wants. */
export interface HandshakeDiff {
  /** Symbols Step 2 must pull — stale truth symbols not already booked in Step 1. */
  symbols: string[];
  /** Symbols the blob revealed that Step 1's prediction never knew about. */
  newlyDiscovered: string[];
  /** Whether Step 2 must still pull FX (stale and not booked by Step 1). */
  fx: boolean;
  /** Whether Step 2 has anything to do at all (false ⇒ a true no-op re-login). */
  hasWork: boolean;
  /** A one-line, log-ready explanation of the reconcile. */
  reason: string;
}

/**
 * Reconcile Step 2 against Step 1 through the freshness ledger: the diff is the
 * **stale** truth symbols that Step 1 did **not** already book, plus FX only if it
 * is both stale and unbooked. Symbols the prediction never knew about (newly
 * bought since the last session) are surfaced separately for the log — they are a
 * subset of the diff, since a never-seen symbol is always stale and unbooked.
 *
 * Deduping is by the symbol set Step 1 booked, so Step 2 can never re-fetch what
 * Step 1 already paid for. When nothing is stale-and-unbooked the diff is empty
 * ({@link HandshakeDiff.hasWork} `=== false`) — the seconds-later re-login no-op.
 */
export function reconcileHandshake(
  booked: PrefetchBooked,
  truth: PostDecryptTruth,
): HandshakeDiff {
  const bookedSet = new Set(booked.symbols);
  // The diff: stale truth symbols Step 1 didn't already book (dedup via the set).
  const seen = new Set<string>();
  const symbols: string[] = [];
  for (const s of truth.staleSymbols) {
    if (bookedSet.has(s) || seen.has(s)) continue;
    seen.add(s);
    symbols.push(s);
  }
  // Newly-discovered = diff symbols the prediction never warmed (a strict subset
  // here, but tracked explicitly so the log can call them out by name).
  const newlyDiscovered = symbols.slice();
  const fx = truth.fxStale && !booked.fx;
  const hasWork = symbols.length > 0 || fx;

  let reason: string;
  if (!hasWork) {
    reason = "Login reconcile: blob matched the prefetch — nothing new to pull (re-login no-op).";
  } else {
    const parts: string[] = [];
    if (symbols.length > 0) {
      parts.push(
        `${symbols.length} symbol(s) diff` +
          (newlyDiscovered.length > 0 ? ` (incl. newly-bought: ${newlyDiscovered.join(", ")})` : ""),
      );
    }
    if (fx) parts.push("FX");
    reason = `Login reconcile: pulling ${parts.join(" + ")} (deduped against the prefetch).`;
  }

  return { symbols, newlyDiscovered, fx, hasWork, reason };
}
