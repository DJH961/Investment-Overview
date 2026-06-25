/**
 * Pillar 5 (WS6) — **provider fan-out under one authority**, as a pure planner
 * (`docs/centralized_data_pull_plan.md` §"Pillar 5 — Provider spilling").
 *
 * Steady state, Twelve Data leads (≤8 symbols/request) and Tiingo takes genuine
 * overflow. For **login / manual** of a big sleeve, dripping 8/min over several
 * minutes is too slow for a "glance for 2 minutes" app, so this planner **fans
 * out across providers in parallel** — e.g. 20 symbols ⇒ 8 via Twelve Data + 12
 * via Tiingo at once — for an instant first paint.
 *
 * It only decides the **split**; the legs are dispatched to the existing fetchers,
 * each already routed through `reservation.ts` (the credit authority) and the
 * `provider-breaker.ts` 429 breaker. The planner therefore *cannot* and *does not*
 * bypass the hard caps — it merely proposes how many symbols each provider takes,
 * clamped to what the caller says is currently spendable.
 *
 * The five hard invariants from the plan are encoded here and asserted in
 * `web/test/provider-fanout.test.ts`:
 *
 * 1. The Twelve Data leg is **always one request of ≤8 symbols** (TD `time_series`
 *    is all-or-nothing; a >8 batch 429s wholesale).
 * 2. The "instant" fan-out trigger is **>16 symbols** (>2 TD-minutes of work).
 *    At or below it, the normal lead/overflow spacing applies (no Tiingo spill).
 * 3. **Login / start is top priority**: exempt from the 16+ latency throttle (it
 *    may spend Tiingo freely for instant first paint) — but never from the
 *    reservation authority or the 429 breaker (modelled here as the spendable caps).
 * 4. **Never cut into the last {@link TIINGO_RESERVE_CREDITS} Tiingo credits when
 *    the 16+ rule fires — *except* on login / start**, which may consume even the
 *    reserve.
 * 5. **No path is exempt from the hard provider caps** — every leg is clamped to
 *    the caller-supplied spendable budgets.
 */

/** The TD `time_series` per-request ceiling (all-or-nothing above this). */
export const TWELVE_DATA_BATCH = 8;

/** Above this symbol count a pull is "instant" work worth a parallel Tiingo spill. */
export const FANOUT_INSTANT_THRESHOLD = 16;

/** The last Tiingo credits a *non-login* fan-out must leave untouched (Pillar 5.4). */
export const TIINGO_RESERVE_CREDITS = 10;

/** Which mechanism is asking — only `start`/`manual` may fan out (Pillar 5.3). */
export type FanoutKind = "start" | "auto" | "manual" | "reset";

export interface FanoutInputs {
  /** The mechanism requesting the pull. */
  kind: FanoutKind;
  /** Symbols needing a fresh quote/bar this round (priority-ordered, largest first). */
  symbols: string[];
  /** Twelve Data credits spendable right now (per-minute budget, post-reservation). */
  twelveDataSpendable: number;
  /** Tiingo credits spendable right now (hourly budget, post-reservation). */
  tiingoSpendable: number;
  /** Whether the Tiingo backup provider is configured/available at all. */
  tiingoAvailable: boolean;
  /** Override the instant threshold (testing); defaults to {@link FANOUT_INSTANT_THRESHOLD}. */
  instantThreshold?: number;
  /** Override the Tiingo reserve (testing); defaults to {@link TIINGO_RESERVE_CREDITS}. */
  tiingoReserve?: number;
}

/** The split: which symbols each provider takes *now*, plus what must wait. */
export interface FanoutPlan {
  /** Symbols for the single Twelve Data `time_series` request (≤8). */
  twelveData: string[];
  /** Symbols spilled to Tiingo for an instant parallel result. */
  tiingo: string[];
  /** Symbols that fit no budget this round — deferred to the next tick. */
  deferred: string[];
  /** Whether the parallel fan-out path was taken (vs. plain lead/overflow). */
  fannedOut: boolean;
  /** A one-line, log-ready explanation of the split decision. */
  reason: string;
}

/** Whether a mechanism is a top-priority login pull (Pillar 5.3). */
export function isPriorityPull(kind: FanoutKind): boolean {
  return kind === "start";
}

/**
 * Decide the provider split for a pull. Pure; the caller dispatches each leg to
 * the existing fetchers (which re-clamp against the live reservation + breaker, so
 * this can only ever propose *fewer* credits than are truly available).
 *
 * The Twelve Data leg is filled first (up to {@link TWELVE_DATA_BATCH} and the TD
 * budget). Tiingo takes the overflow **only** when it is worthwhile and allowed:
 *
 * - **Below the instant threshold** (≤16 symbols) on a non-priority pull: no
 *   parallel spill — the overflow waits for the next TD minute (steady spacing).
 * - **At/above the threshold**, or any **login/start** pull: spill the overflow to
 *   Tiingo in parallel, clamped to the Tiingo budget. A non-login spill must leave
 *   the last {@link TIINGO_RESERVE_CREDITS} untouched; login/start may use them.
 */
export function planFanout(input: FanoutInputs): FanoutPlan {
  const instantThreshold = input.instantThreshold ?? FANOUT_INSTANT_THRESHOLD;
  const reserve = input.tiingoReserve ?? TIINGO_RESERVE_CREDITS;
  const priority = isPriorityPull(input.kind);

  // Hard cap #5 / #1: the TD leg is one request of ≤8, clamped to the live budget.
  const tdCapacity = Math.max(0, Math.min(TWELVE_DATA_BATCH, Math.floor(input.twelveDataSpendable)));
  const twelveData = input.symbols.slice(0, tdCapacity);
  let rest = input.symbols.slice(tdCapacity);

  if (rest.length === 0) {
    return {
      twelveData,
      tiingo: [],
      deferred: [],
      fannedOut: false,
      reason: `Twelve Data only: ${twelveData.length} symbol(s) ≤ one TD request.`,
    };
  }

  // Invariant #2/#3: spill to Tiingo only when it is the instant case (>16) or a
  // top-priority login/start pull. Otherwise the overflow waits a TD minute.
  const wantsFanout =
    input.tiingoAvailable && (priority || input.symbols.length > instantThreshold);
  if (!wantsFanout) {
    return {
      twelveData,
      tiingo: [],
      deferred: rest,
      fannedOut: false,
      reason:
        `Twelve Data lead (${twelveData.length}), ${rest.length} deferred to next TD minute ` +
        `(${input.symbols.length} ≤ ${instantThreshold} instant threshold; no Tiingo spill).`,
    };
  }

  // Invariant #4: a non-login spill must leave the last `reserve` Tiingo credits;
  // login/start may consume even the reserve. Invariant #5: clamp to the budget.
  const tiingoBudget = Math.max(0, Math.floor(input.tiingoSpendable));
  const tiingoUsable = priority ? tiingoBudget : Math.max(0, tiingoBudget - reserve);
  const tiingo = rest.slice(0, tiingoUsable);
  rest = rest.slice(tiingoUsable);

  const reservePart = priority
    ? "login may use the Tiingo reserve"
    : `last ${reserve} Tiingo credits reserved`;
  return {
    twelveData,
    tiingo,
    deferred: rest,
    fannedOut: tiingo.length > 0,
    reason:
      `Fan-out: ${twelveData.length} via Twelve Data + ${tiingo.length} via Tiingo in parallel` +
      `${rest.length > 0 ? `, ${rest.length} deferred` : ""} ` +
      `(${input.kind}; ${reservePart}).`,
  };
}
