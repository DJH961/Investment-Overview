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
 *
 * **NAVs ride the same sleeve.** The moment a NAV fund needs a price this round it
 * is folded into the one sleeve and obeys every invariant above identically to a
 * stock — same TD lead, same >16 instant spill, same login fast-track, same
 * reserve, same deferral. (Earlier the NAV slice had a separate "Twelve Data only
 * unless login" policy; that divergence is gone.) Only NAV *graph-bars* stay out —
 * NAVs have no intraday series — so this module routes purely their EOD price.
 */

/**
 * The default Twelve Data `time_series` batch size — recommended for the free
 * tier, where it equals the 8 credits/minute budget. The real planner is wired
 * (from `app.ts`) to the live `twelveDataPerMinute` limit via the
 * `twelveDataBatch` input, so raising the limit on a paid plan widens the batch.
 */
export const TWELVE_DATA_BATCH = 8;

/**
 * Above this symbol count a pull is "instant" work worth a parallel Tiingo spill.
 * Defaults to two Twelve Data minutes of work (2 × {@link TWELVE_DATA_BATCH}); the
 * planner derives it from the live batch size when one is supplied.
 */
export const FANOUT_INSTANT_THRESHOLD = 16;

/** The last Tiingo credits a *non-login* fan-out must leave untouched (Pillar 5.4). */
export const TIINGO_RESERVE_CREDITS = 10;

/**
 * Which mechanism is asking. Fan-out is decided by **size and priority, not kind**:
 * `start` (login) is top-priority and always eligible to spill, while *any* kind
 * fans out once the sleeve clears the instant threshold (>16). See {@link planFanout}.
 */
export type FanoutKind = "start" | "auto" | "manual" | "reset";

export interface FanoutInputs {
  /** The mechanism requesting the pull. */
  kind: FanoutKind;
  /** Symbols needing a fresh quote/bar this round (priority-ordered, largest first). */
  symbols: string[];
  /**
   * NAV-fund symbols needing a fresh price this round. They are folded into the
   * one unified sleeve and routed **exactly like stocks** — TD lead, Tiingo spill
   * on a login/start pull or a >16-symbol sleeve, the reserve, and deferral all
   * apply identically. Optional; defaults to none. NAV *graph-bar* backfill is
   * never routed here (NAVs have no intraday series) — this is purely the NAV EOD
   * price/quote.
   */
  navSymbols?: string[];
  /** Twelve Data credits spendable right now (per-minute budget, post-reservation). */
  twelveDataSpendable: number;
  /** Tiingo credits spendable right now (hourly budget, post-reservation). */
  tiingoSpendable: number;
  /** Whether the Tiingo backup provider is configured/available at all. */
  tiingoAvailable: boolean;
  /** Override the instant threshold (testing); defaults to {@link FANOUT_INSTANT_THRESHOLD}. */
  instantThreshold?: number;
  /**
   * The Twelve Data per-request batch size — the live `twelveDataPerMinute` limit
   * in production. Defaults to {@link TWELVE_DATA_BATCH}; the instant threshold,
   * when not given explicitly, derives as 2× this.
   */
  twelveDataBatch?: number;
  /** Override the Tiingo reserve (testing); defaults to {@link TIINGO_RESERVE_CREDITS}. */
  tiingoReserve?: number;
}

/** The split: which symbols each provider takes *now*, plus what must wait. */
export interface FanoutPlan {
  /** Symbols for the single Twelve Data `time_series` request (≤8). */
  twelveData: string[];
  /** Symbols spilled to Tiingo for an instant parallel result. */
  tiingo: string[];
  /** NAV symbols that rode the Twelve Data leg of the unified sleeve. */
  navTwelveData: string[];
  /** NAV symbols that spilled to the Tiingo leg of the unified sleeve. */
  navTiingo: string[];
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
 * - **At or below the instant threshold** (≤16 symbols) on a non-priority pull: no
 *   parallel spill — the overflow waits for the next TD minute (steady spacing).
 * - **Strictly above the threshold** (>16), or any **login/start** pull: spill the
 *   overflow to Tiingo in parallel, clamped to the Tiingo budget. A non-login spill
 *   must leave the last {@link TIINGO_RESERVE_CREDITS} untouched; login/start may use them.
 *
 * NAV funds needing a price (`navSymbols`) are appended to the same sleeve and
 * obey the identical rules — they are no longer a separately-routed slice.
 */
export function planFanout(input: FanoutInputs): FanoutPlan {
  const tdBatch = Math.max(1, Math.floor(input.twelveDataBatch ?? TWELVE_DATA_BATCH));
  const instantThreshold = input.instantThreshold ?? tdBatch * 2;
  const reserve = input.tiingoReserve ?? TIINGO_RESERVE_CREDITS;
  const priority = isPriorityPull(input.kind);
  const navList = input.navSymbols ?? [];
  const navSet = new Set(navList);

  // **NAVs are treated exactly like stocks the moment a pull of them is needed**:
  // one sleeve, one routing path. The market symbols lead (priority-ordered,
  // largest first) and the NAV funds that need a price this round follow, but from
  // here on both share the *identical* policy — the same Twelve Data lead (one
  // request of ≤ the batch size), the same Tiingo spill (only on a login/start
  // pull or a >16-symbol "instant" sleeve), the same reserve discipline, and the
  // same deferral of whatever fits no budget. NAV *graph-bars* are never routed
  // here (NAVs have no intraday series) — this is purely the NAV EOD price/quote.
  const sleeve = [...input.symbols, ...navList];

  // Hard cap #5 / #1: the TD leg is one request of ≤ the batch size, clamped to
  // the live budget.
  const tdSpendable = Math.max(0, Math.floor(input.twelveDataSpendable));
  const tdCapacity = Math.min(tdBatch, tdSpendable);
  const twelveDataAll = sleeve.slice(0, tdCapacity);
  let rest = sleeve.slice(tdCapacity);
  const tiingoBudget = Math.max(0, Math.floor(input.tiingoSpendable));

  // Invariant #2/#3: spill to Tiingo only when it is the instant case (>16, the
  // **whole** sleeve counted — NAVs included) or a top-priority login/start pull.
  // Otherwise the overflow waits a TD minute. Invariant #4: a non-login spill must
  // leave the last `reserve` Tiingo credits; login/start may consume even the
  // reserve. Invariant #5: clamp to the live budget.
  const wantsFanout =
    input.tiingoAvailable && rest.length > 0 && (priority || sleeve.length > instantThreshold);
  let tiingoAll: string[] = [];
  if (wantsFanout) {
    const tiingoUsable = priority ? tiingoBudget : Math.max(0, tiingoBudget - reserve);
    tiingoAll = rest.slice(0, tiingoUsable);
    rest = rest.slice(tiingoAll.length);
  }
  const deferred = rest;

  // Partition each provider leg back into its market + NAV buckets for the report
  // and the reconcile booking (the dispatch concatenates them again, so the split
  // is purely descriptive — the routing decision above made no distinction).
  const marketOf = (xs: string[]): string[] => xs.filter((s) => !navSet.has(s));
  const navOf = (xs: string[]): string[] => xs.filter((s) => navSet.has(s));
  const twelveData = marketOf(twelveDataAll);
  const navTwelveData = navOf(twelveDataAll);
  const tiingo = marketOf(tiingoAll);
  const navTiingo = navOf(tiingoAll);
  const nav: NavSplit = { navTwelveData, navTiingo, deferred: navOf(deferred) };

  return {
    twelveData,
    tiingo,
    navTwelveData,
    navTiingo,
    deferred,
    fannedOut: tiingoAll.length > 0,
    reason: describeFanout({
      twelveData,
      tiingo,
      marketDeferred: marketOf(deferred),
      sleeveLength: sleeve.length,
      instantThreshold,
      wantsFanout,
      priority,
      reserve,
      kind: input.kind,
      nav,
    }),
  };
}

/** Build the one-line, log-ready reason for a (now unified) fan-out decision. */
function describeFanout(args: {
  twelveData: string[];
  tiingo: string[];
  marketDeferred: string[];
  sleeveLength: number;
  instantThreshold: number;
  wantsFanout: boolean;
  priority: boolean;
  reserve: number;
  kind: FanoutKind;
  nav: NavSplit;
}): string {
  const navClause = describeNav(args.nav);
  if (args.tiingo.length === 0 && args.marketDeferred.length === 0) {
    return `Twelve Data only: ${args.twelveData.length} symbol(s) ≤ one TD request${navClause}.`;
  }
  if (!args.wantsFanout) {
    return (
      `Twelve Data lead (${args.twelveData.length}), ${args.marketDeferred.length} deferred to next TD minute ` +
      `(${args.sleeveLength} ≤ ${args.instantThreshold} instant threshold; no Tiingo spill)${navClause}.`
    );
  }
  const reservePart = args.priority
    ? "login may use the Tiingo reserve"
    : `last ${args.reserve} Tiingo credits reserved`;
  return (
    `Fan-out: ${args.twelveData.length} via Twelve Data + ${args.tiingo.length} via Tiingo in parallel` +
    `${args.marketDeferred.length > 0 ? `, ${args.marketDeferred.length} deferred` : ""} ` +
    `(${args.kind}; ${reservePart})${navClause}.`
  );
}

/** The NAV slice of a fan-out: which provider each NAV took, or was deferred. */
interface NavSplit {
  navTwelveData: string[];
  navTiingo: string[];
  deferred: string[];
}

/** Append a short NAV-routing clause to a fan-out reason, or nothing when idle. */
function describeNav(nav: NavSplit): string {
  if (nav.navTwelveData.length === 0 && nav.navTiingo.length === 0 && nav.deferred.length === 0) {
    return "";
  }
  const parts: string[] = [];
  if (nav.navTwelveData.length > 0) parts.push(`${nav.navTwelveData.length} via Twelve Data`);
  if (nav.navTiingo.length > 0) parts.push(`${nav.navTiingo.length} spilled to Tiingo`);
  if (nav.deferred.length > 0) parts.push(`${nav.deferred.length} deferred`);
  return `; NAV: ${parts.join(", ")}`;
}

/** Inputs for the reverse (Tiingo-primary → Twelve Data) safety net. */
export interface SafetyNetInputs {
  /**
   * Whether this pull routed through Tiingo as the **sole primary** (the "via
   * backup" hard refresh, which skips the Twelve Data quote pass entirely). The
   * safety net only engages for this route — on the normal route Twelve Data is
   * the primary that already tried, so a still-missing symbol is genuinely stuck
   * rather than untried.
   */
  viaTiingo: boolean;
  /**
   * Symbols the round wanted priced but the Tiingo primary could not fetch live
   * (the primary pass was skipped, so these are the `report.deferred` holes) —
   * still on a cached / last-known value.
   */
  unfilled: string[];
  /** Symbols the Tiingo primary did fill this round (excluded from the re-pull). */
  tiingoFilled: string[];
}

/** The reverse safety net's verdict: which symbols Twelve Data should catch. */
export interface SafetyNetPlan {
  /** Symbols to re-pull from Twelve Data to catch Tiingo's holes. */
  twelveData: string[];
  /** Whether a Twelve Data safety-net re-pull is warranted this round. */
  engaged: boolean;
  /** A one-line, log-ready explanation of the safety-net decision. */
  reason: string;
}

/**
 * Plan the **reverse safety net**. The forward path is Twelve Data (primary) →
 * Tiingo (fallback). The smart-routing "via backup" hard refresh inverts that —
 * it makes Tiingo the *sole* primary and skips Twelve Data — so a Tiingo failure
 * (unreachable, over-quota, or nothing newer) would leave those symbols stuck on
 * a cached / last-known price with **no** provider behind it. This planner names
 * exactly the holes Tiingo left so the caller can re-pull them on Twelve Data,
 * turning a Tiingo outage into a graceful degrade to the primary instead of to
 * stale data.
 *
 * Pure: it only decides the symbol set. The caller dispatches it to the existing
 * `loadQuotes` fetcher, which re-clamps against the live Twelve Data per-minute /
 * per-day budget — so the safety net respects the same budget + scheduling as
 * every other Twelve Data pull and can never overspend.
 */
export function planTwelveDataSafetyNet(input: SafetyNetInputs): SafetyNetPlan {
  if (!input.viaTiingo) {
    return {
      twelveData: [],
      engaged: false,
      reason: "Safety net idle: Twelve Data was the primary (no Tiingo-only route to back up).",
    };
  }
  const filled = new Set(input.tiingoFilled);
  const twelveData = input.unfilled.filter((symbol) => !filled.has(symbol));
  if (twelveData.length === 0) {
    return {
      twelveData,
      engaged: false,
      reason: "Safety net idle: Tiingo (primary) covered every requested symbol.",
    };
  }
  return {
    twelveData,
    engaged: true,
    reason:
      `Safety net: Tiingo (primary) left ${twelveData.length} symbol(s) unpriced ` +
      `[${twelveData.join(", ")}] — re-pulling on Twelve Data (budget-clamped).`,
  };
}
