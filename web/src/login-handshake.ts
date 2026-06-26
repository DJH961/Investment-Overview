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
  /**
   * The symbols Step 1's *prediction* knew about (the last-known holdings it
   * considered when warming). Used to label a Step-2 diff symbol as
   * **newly-discovered** only when the prediction never knew it — not merely
   * because it was stale. Optional: when omitted the prediction set defaults to
   * the booked symbols.
   */
  predicted?: string[];
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
  /**
   * C6 — symbols whose decrypted `nativeCurrency` differs from the currency the
   * pre-decrypt plan (C2) assumed when Step 1 primed/booked them. A primed quote
   * denominated in the wrong currency must be re-pulled even if the ledger would
   * otherwise call it fresh, so these are folded into the diff and flagged in the
   * reason. Distinct from `newlyDiscovered` (a brand-new holding): a currency
   * surprise is an *existing* symbol whose denomination changed. Optional; a
   * steady-state USD-only book produces none.
   */
  currencyMismatches?: string[];
}

/** The Step-2 diff: only what Step 1 missed and the ledger still wants. */
export interface HandshakeDiff {
  /** Symbols Step 2 must pull — stale truth symbols not already booked in Step 1. */
  symbols: string[];
  /** Symbols the blob revealed that Step 1's prediction never knew about. */
  newlyDiscovered: string[];
  /** Symbols whose decrypted currency differed from the plan's assumption (C6). */
  currencyMismatches: string[];
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
 * is both stale and unbooked. Symbols the *prediction* never knew about (newly
 * bought since the last session) are surfaced separately for the log — a diff
 * symbol counts as newly-discovered only when it is absent from Step 1's
 * predicted set, not merely because it is stale.
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
  // The prediction set Step 1 warmed against. Defaults to the booked symbols when
  // the caller doesn't supply an explicit prediction.
  const predictedSet = new Set(booked.predicted ?? booked.symbols);
  // The diff: stale truth symbols Step 1 didn't already book (dedup via the set).
  const seen = new Set<string>();
  const symbols: string[] = [];
  for (const s of truth.staleSymbols) {
    if (bookedSet.has(s) || seen.has(s)) continue;
    seen.add(s);
    symbols.push(s);
  }
  // C6 — a currency mismatch forces a re-pull even when the ledger calls the
  // symbol fresh: Step 1 may have primed it in the wrong denomination from the
  // stale plan currency. Fold each mismatch into the diff (deduped), regardless of
  // whether it was booked, so the wrongly-denominated quote is corrected.
  const currencyMismatches: string[] = [];
  for (const s of truth.currencyMismatches ?? []) {
    if (seen.has(s)) {
      currencyMismatches.push(s);
      continue;
    }
    seen.add(s);
    symbols.push(s);
    currencyMismatches.push(s);
  }
  // Newly-discovered = diff symbols the prediction never knew about (so a stale
  // but already-predicted symbol is *not* mislabelled "newly-bought"). A currency
  // mismatch is an existing symbol, so it is excluded from this label.
  const mismatchSet = new Set(currencyMismatches);
  const newlyDiscovered = symbols.filter((s) => !predictedSet.has(s) && !mismatchSet.has(s));
  const fx = truth.fxStale && !booked.fx;
  const hasWork = symbols.length > 0 || fx;

  let reason: string;
  if (!hasWork) {
    reason = "Login reconcile: blob matched the prefetch — nothing new to pull (re-login no-op).";
  } else {
    const parts: string[] = [];
    if (symbols.length > 0) {
      const labels: string[] = [];
      if (newlyDiscovered.length > 0) labels.push(`newly-bought: ${newlyDiscovered.join(", ")}`);
      if (currencyMismatches.length > 0) labels.push(`currency-mismatch: ${currencyMismatches.join(", ")}`);
      parts.push(`${symbols.length} symbol(s) diff` + (labels.length > 0 ? ` (incl. ${labels.join("; ")})` : ""));
    }
    if (fx) parts.push("FX");
    reason = `Login reconcile: pulling ${parts.join(" + ")} (deduped against the prefetch).`;
  }

  return { symbols, newlyDiscovered, currencyMismatches, fx, hasWork, reason };
}
