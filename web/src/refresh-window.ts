/**
 * Market-phase policy for *what* a refresh should fetch — the companion to
 * {@link ./refresh-policy} (which decides *when* the next auto-refresh runs).
 *
 * The portfolio holds two very different kinds of priceable instrument, and they
 * become stale at different times of day:
 *
 *   - **market** symbols (stocks / ETFs) move continuously while the NYSE regular
 *     session is open and are frozen at their settled close once it shuts; and
 *   - **NAV** funds (mutual funds) strike a single price after the market closes,
 *     so their fresh number only appears in the evening.
 *
 * From the user's point of view there are therefore three meaningfully different
 * windows in a day, and a refresh should behave differently in each:
 *
 *   - **market** — the regular session is open: only live *stock* prices can have
 *     changed, so never chase a NAV that cannot have moved yet;
 *   - **pre-nav** — the session has closed but today's NAV has not published yet:
 *     the stock closes are already in hand, so only the awaited *NAVs* are worth
 *     fetching; and
 *   - **settled** — the session is closed *and* every settled close + today's NAV
 *     is already held (or it is a quiet pre-market / weekend / holiday stretch):
 *     nothing on the market can have changed since we last looked.
 *
 * These pure helpers turn that situation into the concrete fetch decisions the
 * app shell wires into a manual tap and the automatic scheduler.
 */

/** The market-relative situation a refresh runs in; see the module comment. */
export type RefreshPhase = "market" | "pre-nav" | "settled";

/** What a refresh round is allowed to (re-)price this time. */
export interface FetchScope {
  /** Fetch continuously-traded market (stock/ETF) symbols. */
  market: boolean;
  /** Fetch once-a-day NAV-priced funds. */
  nav: boolean;
}

/**
 * Classify the current refresh situation from two cheap signals:
 *   - `marketOpen` — is the NYSE regular session open right now; and
 *   - `navOutstanding` — is at least one NAV fund still missing a NAV that is
 *     genuinely due (we are demonstrably behind a published price).
 *
 * The session always wins: while the market is open we are in the **market**
 * phase even if some NAV looks behind, because a NAV cannot strike until the
 * market shuts. Once closed, a still-due NAV puts us in **pre-nav**; otherwise
 * everything we could hold is in hand and we are **settled**.
 */
export function classifyRefreshPhase(opts: { marketOpen: boolean; navOutstanding: boolean }): RefreshPhase {
  if (opts.marketOpen) return "market";
  if (opts.navOutstanding) return "pre-nav";
  return "settled";
}

/**
 * What a **manual** "refresh now" tap should pull in each phase.
 *
 * A manual tap during the session pulls only the live stock prices; in the
 * post-close pre-NAV window it pulls only the awaited NAVs; and at any other
 * time — fully settled evening, overnight, pre-market, weekend — it re-pulls
 * *everything*. That last case is deliberate: the user only taps refresh outside
 * market hours when they are unsure the cached values are right, so an explicit
 * tap then should verify the whole book from scratch rather than trust the cache.
 */
export function manualFetchScope(phase: RefreshPhase): FetchScope {
  switch (phase) {
    case "market":
      return { market: true, nav: false };
    case "pre-nav":
      return { market: false, nav: true };
    case "settled":
      return { market: true, nav: true };
  }
}

/**
 * What an **automatic** background round should pull in each phase.
 *
 * Mirrors {@link manualFetchScope} for the open and pre-NAV windows — stocks
 * while trading, NAVs while one is still awaited — but, crucially, fetches
 * *nothing* once everything is settled: there is no point spending credits
 * re-polling a closed market whose closes and NAVs we already hold. The
 * scheduler keeps only a slow heartbeat to notice the next session open or NAV
 * publish.
 */
export function autoFetchScope(phase: RefreshPhase): FetchScope {
  switch (phase) {
    case "market":
      return { market: true, nav: false };
    case "pre-nav":
      return { market: false, nav: true };
    case "settled":
      return { market: false, nav: false };
  }
}

/** Whether a scope fetches anything at all (used to detect the idle case). */
export function scopeFetchesAnything(scope: FetchScope): boolean {
  return scope.market || scope.nav;
}
