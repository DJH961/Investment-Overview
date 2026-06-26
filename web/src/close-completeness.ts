/**
 * Multi-provider **session-close completeness** resolution shared by the live 1D
 * and 1W graphs (docs/session_close_completeness_plan.md, C3–C7).
 *
 * The reframing this module implements: stop asking *"is this bar near the
 * closing bell?"* and start asking *"have we got the best close anyone can give
 * us?"*. A liquid symbol answers for free (it has a bar at the bell); a quiet or
 * weak-on-primary symbol answers the moment a **second** provider agrees nothing
 * newer exists — and we **remember** that answer (the persisted
 * {@link StoredCloseProbe}) so we never re-fetch it that day, even after a
 * restart. A genuine provider outage is treated as an outage (a few spaced,
 * back-off-bounded retries), never a per-render hammer.
 *
 * The algorithm is provider/granularity agnostic: the 1D curve passes a one-hour
 * tolerance and the intraday legs; the 1W curve passes a one-trading-day
 * tolerance and the daily-close legs. Both fetch through their existing capacity
 * split / reservation authority, so no new uncapped network path is introduced
 * (P6).
 */

import { sessionBarsComplete } from "./session-fx";
import type { Bar } from "./timeseries";
import type { BarFetcher } from "./intraday";
import type { StoredCloseProbe } from "./timeseries-store";

/**
 * Minimum spacing between post-close probes of a still-unsettled short symbol
 * (10 minutes). Far longer than a render (so a per-second redraw never re-fetches)
 * yet far shorter than a session (so a genuinely-late close still resolves within
 * the evening). At 10 min this caps the probe to at most ~6 fetches/hour/symbol
 * while the close settles — a negligible, bounded free-tier cost. The C4 spacing
 * gate that kills the per-render hammer.
 */
export const PROBE_MIN_MS = 10 * 60 * 1000;

/** One hour in ms — the pacing quantum for provisional two-source agreements. */
export const HOUR_MS = 60 * 60 * 1000;

/**
 * How many times both providers must independently agree on the same pre-close
 * tip before the day's close is accepted (the first agreement counts toward this
 * total). A single coincidental match is no longer terminal: the resolver records
 * the first two agreements as **provisional** (`sources: 2, settled: false`) and
 * only settles on the third, each re-check paced to the next full hour (see
 * {@link nextFullHourStart}) so the scarce Tiingo budget is spent at most once an
 * hour while the agreement is confirmed.
 */
export const AGREEMENTS_TO_SETTLE = 3;

/**
 * The start of the first full clock-hour strictly after `t` (wall-clock ms). A
 * provisional agreement recorded at 15:48 may next be re-probed at 16:00, the one
 * after that at the top of the following hour, and so on — so the confirmation
 * re-checks land on hour boundaries regardless of when the app happens to be open
 * (e.g. an attempt that only fires at 16:08 still gates its successor to 17:00).
 */
export function nextFullHourStart(t: number): number {
  return Math.floor(t / HOUR_MS) * HOUR_MS + HOUR_MS;
}

/**
 * Whether a stored close-probe's spacing gate permits another post-close fetch at
 * `nowMs`. A **provisional two-source agreement** (`sources === 2 && !settled`)
 * is paced to the start of the next full hour after its last attempt — the
 * token-efficient confirmation cadence the two-step agreement needs — while every
 * other still-unsettled probe uses the flat `probeMinMs` window. An absent probe
 * (or a settled one, which callers exclude earlier) is always ready.
 */
export function closeProbeReady(
  probe: { sources: number; settled: boolean; lastAttemptAt: number } | undefined,
  nowMs: number,
  probeMinMs: number,
): boolean {
  if (!probe) return true;
  if (probe.sources === 2 && !probe.settled) {
    return nowMs >= nextFullHourStart(probe.lastAttemptAt);
  }
  return nowMs - probe.lastAttemptAt >= probeMinMs;
}

/**
 * The slice of {@link SeriesBackoff} the resolver needs. Declared structurally
 * here (rather than imported from `live-graph.ts`) so this module stays free of a
 * circular dependency; a `cacheSeriesBackoff()` instance satisfies it directly.
 */
export interface CloseProbeBackoff {
  /** True when `key` is in an armed cooldown at `now` (skip the network). */
  suppressed(key: string, now: number): boolean;
  /** Record a failed/outage attempt; arms the cooldown at the Nth strike. */
  fail(key: string, now: number): void;
  /** Forget `key` after a reached-close / settled resolution. */
  succeed(key: string): void;
}

/** The newest bar instant in a (possibly empty/undefined) list, or `null`. */
export function newestBarInstant(bars: Bar[] | undefined): number | null {
  if (!bars || bars.length === 0) return null;
  let best = bars[0].t;
  for (const b of bars) if (b.t > best) best = b.t;
  return best;
}

/**
 * The four terminal verdicts a symbol's after-close resolution can reach. Mapped
 * onto the polling log's severities so each one shows the right glyph in the
 * downloadable trail (plan C6): a settle is a `good` ✓, a still-filling step is a
 * neutral `info` ·, and a both-sources-failed outage is a `warn` ↩ back-off.
 */
export type CloseResolveOutcome =
  | "reached-close"
  | "progressed"
  | "settled-by-agreement"
  | "deferred-outage";

/** Severity bucket (mirrors the polling log's `PollLogLevel`, kept decoupled). */
export type CloseResolveLevel = "good" | "info" | "warn" | "error";

/**
 * One structured close-resolution log event (plan C6). Carries an **explicit**
 * severity so the polling-log renderer shows the correct glyph instead of having
 * to keyword-infer it, plus the machine-readable `outcome`/`symbol` for tests and
 * future filtering. `message` is the human-facing, ready-to-show line.
 */
export interface CloseResolveLog {
  /** The symbol this verdict is about (e.g. `"DAX"`). */
  symbol: string;
  /** The terminal verdict reached for this symbol. */
  outcome: CloseResolveOutcome;
  /** Explicit polling-log severity for this line. */
  level: CloseResolveLevel;
  /** The human-facing line, already including the `1D`/`1W` label and symbol. */
  message: string;
}

/** Inputs to {@link resolveCloseCompleteness}. */
export interface CloseResolutionInput {
  /** The incomplete-but-present short symbols to resolve (already spacing-gated). */
  symbols: string[];
  /** Current stored bars, for the previous-tip fallback when no probe exists. */
  storedBars: Record<string, Bar[]>;
  /** Current persisted probes (per symbol), or `undefined`. */
  probes: Record<string, StoredCloseProbe> | undefined;
  /** The session/window close instant a complete track must reach. */
  closeMs: number;
  /** Advance/agreement tolerance: one bar interval (1D) or ~half a day (1W). */
  tol: number;
  /**
   * Tolerance for the *reached-close* test (`sessionBarsComplete`), if it differs
   * from {@link tol}. The 1D curve uses the same one-hour slack for both; the 1W
   * curve judges "covers the settled close" exactly (`completeTol = 0`) while
   * still allowing ~half a day of slack for the advance/agreement comparison.
   * Defaults to {@link tol}.
   */
  completeTol?: number;
  /** Clamp fetched bars to the session day / window before judging. */
  clampBars: (bars: Bar[]) => Bar[];
  /** Primary provider leg (Twelve Data on web). */
  fetchPrimary: BarFetcher;
  /** Secondary provider leg (Tiingo) used for the single escalation; null disables it. */
  fetchSecondary: BarFetcher | null;
  /** Wall-clock now (ms). */
  now: number;
  /** Outage back-off (struck on deferred-outage, cleared on settle); null disables. */
  backoff?: CloseProbeBackoff | null;
  /** Build the back-off key for a symbol. */
  backoffKey?: (symbol: string) => string;
  /** One structured verdict event per resolved short symbol (C6). */
  log?: (event: CloseResolveLog) => void;
  /** Log label, e.g. `"1D"` / `"1W"`. */
  label: string;
  /** Render a bar instant for the log (defaults to the raw ms). */
  formatInstant?: (t: number) => string;
}

/** What {@link resolveCloseCompleteness} produces, ready to merge into the store. */
export interface CloseResolutionResult {
  /** Bars to merge per symbol (reached-close / progressed / settled tips). */
  bars: Record<string, Bar[]>;
  /** Probe records to merge per symbol. */
  closeProbe: Record<string, StoredCloseProbe>;
  /** Symbols that reached the close — their probe is cleared. */
  closeProbeClear: string[];
  /** All bars actually fetched (primary + secondary), for `onFreshBars`. */
  fetched: Map<string, Bar[]>;
}

/**
 * Resolve each after-close *incomplete-but-present* symbol into one of
 * {reached-close, progressed, settled-by-agreement, deferred-outage} using the
 * **second** provider as the tie-breaker (plan C3, principles P1/P2/P4/P5).
 *
 * One primary leg covers the whole batch; only the symbols that did **not**
 * advance against their remembered tip escalate — once each, to the secondary —
 * so the scarce second budget is spent on exactly the symbols that need it. All
 * time comparisons use `tol` (never raw equality) so a trailing partial bar that
 * only moves seconds reads as *no advance* rather than false progress (P5).
 */
export async function resolveCloseCompleteness(
  input: CloseResolutionInput,
): Promise<CloseResolutionResult> {
  const {
    symbols,
    storedBars,
    probes,
    closeMs,
    tol,
    clampBars,
    fetchPrimary,
    fetchSecondary,
    now,
    backoff,
    log,
    label,
  } = input;
  const completeTol = input.completeTol ?? tol;
  const result: CloseResolutionResult = {
    bars: {},
    closeProbe: {},
    closeProbeClear: [],
    fetched: new Map<string, Bar[]>(),
  };
  if (symbols.length === 0) return result;
  const key = (s: string): string => (input.backoffKey ? input.backoffKey(s) : s);
  const fmt = input.formatInstant ?? ((t: number): string => String(t));
  const prevTipOf = (s: string): number =>
    probes?.[s]?.lastBarAt ?? newestBarInstant(storedBars[s]) ?? 0;

  const primary = await fetchPrimary(symbols);
  for (const [s, bars] of primary) if (bars.length > 0) result.fetched.set(s, bars);

  // First pass over the primary leg: settle the easy wins (reached-close /
  // progressed) and collect the no-advance symbols for a single escalation.
  const escalate: string[] = [];
  const aBarsBySymbol = new Map<string, Bar[]>();
  for (const s of symbols) {
    const aBars = clampBars(primary.get(s) ?? []);
    aBarsBySymbol.set(s, aBars);
    const tipA = newestBarInstant(aBars);
    if (aBars.length > 0 && sessionBarsComplete(aBars, closeMs, completeTol)) {
      result.bars[s] = aBars;
      result.closeProbeClear.push(s);
      backoff?.succeed(key(s));
      log?.({
        symbol: s,
        outcome: "reached-close",
        level: "good",
        message: `${label} graph · ${s}: reached the closing bar at ${fmt(tipA as number)} — settled (1 source).`,
      });
      continue;
    }
    const prevTip = prevTipOf(s);
    if (tipA !== null && tipA > prevTip + tol) {
      result.bars[s] = aBars;
      result.closeProbe[s] = {
        lastBarAt: tipA,
        attempts: (probes?.[s]?.attempts ?? 0) + 1,
        sources: 1,
        settled: false,
        lastAttemptAt: now,
      };
      log?.({
        symbol: s,
        outcome: "progressed",
        level: "info",
        message: `${label} graph · ${s}: still filling toward the close ${fmt(prevTip)} → ${fmt(tipA)} (1 source) — will check again later.`,
      });
      continue;
    }
    escalate.push(s);
  }

  if (escalate.length === 0) return result;

  // The single secondary escalation for the symbols the primary could not move.
  const secondary = fetchSecondary
    ? await fetchSecondary(escalate)
    : new Map<string, Bar[]>();
  for (const [s, bars] of secondary) if (bars.length > 0) result.fetched.set(s, bars);

  for (const s of escalate) {
    const attempts = (probes?.[s]?.attempts ?? 0) + 1;
    const aBars = aBarsBySymbol.get(s) ?? [];
    const tipA = newestBarInstant(aBars);
    const bBars = clampBars(secondary.get(s) ?? []);
    const tipB = newestBarInstant(bBars);

    if (bBars.length > 0 && sessionBarsComplete(bBars, closeMs, completeTol)) {
      result.bars[s] = bBars;
      result.closeProbeClear.push(s);
      backoff?.succeed(key(s));
      log?.({
        symbol: s,
        outcome: "reached-close",
        level: "good",
        message: `${label} graph · ${s}: backup provider reached the closing bar at ${fmt(tipB as number)} — settled (2 sources).`,
      });
      continue;
    }
    if (tipB !== null && (tipA === null || tipB > tipA + tol)) {
      result.bars[s] = bBars;
      result.closeProbe[s] = {
        lastBarAt: tipB,
        attempts,
        sources: 1,
        settled: false,
        lastAttemptAt: now,
      };
      log?.({
        symbol: s,
        outcome: "progressed",
        level: "info",
        message: `${label} graph · ${s}: backup provider advanced the close ${fmt(tipA ?? prevTipOf(s))} → ${fmt(tipB)} — will check again later.`,
      });
      continue;
    }
    if (tipA !== null && tipB !== null && Math.abs(tipB - tipA) <= tol) {
      // Two independent sources agree on the same last bar. One coincidental
      // match is not enough: count it as a *provisional* agreement and only
      // accept the close once both providers have agreed AGREEMENTS_TO_SETTLE
      // times (the first counts). Until then the symbol stays unsettled and its
      // re-check is paced to the next full hour by `closeProbeReady`.
      const agreements = (probes?.[s]?.agreements ?? 0) + 1;
      const settled = agreements >= AGREEMENTS_TO_SETTLE;
      result.bars[s] = aBars;
      result.closeProbe[s] = {
        lastBarAt: tipA,
        attempts,
        sources: 2,
        settled,
        lastAttemptAt: now,
        agreements,
      };
      if (settled) {
        backoff?.succeed(key(s));
        log?.({
          symbol: s,
          outcome: "settled-by-agreement",
          level: "good",
          message: `${label} graph · ${s}: both providers agreed the last bar is ${fmt(tipA)} ${agreements}× — settled for the day, no newer close exists (2 sources).`,
        });
      } else {
        log?.({
          symbol: s,
          outcome: "progressed",
          level: "info",
          message: `${label} graph · ${s}: both providers agree the last bar is ${fmt(tipA)} (agreement ${agreements}/${AGREEMENTS_TO_SETTLE}) — will re-confirm next hour.`,
        });
      }
      continue;
    }
    // Neither provider could advance or confirm — a real outage. Record the
    // attempt (so the spacing gate holds) and strike the back-off, never settle.
    result.closeProbe[s] = {
      lastBarAt: tipA ?? prevTipOf(s),
      attempts,
      sources: tipA !== null ? 1 : 0,
      settled: false,
      lastAttemptAt: now,
    };
    backoff?.fail(key(s), now);
    log?.({
      symbol: s,
      outcome: "deferred-outage",
      level: "warn",
      message: `${label} graph · ${s}: neither provider could advance the close — backed off (attempt ${attempts}), will retry later.`,
    });
  }

  return result;
}

/**
 * The reserved "symbol" the EUR/USD FX track is resolved under, so its probe can
 * live in the same per-day {@link StoredCloseProbe} map as the price symbols
 * without ever colliding with a real ticker. Also the display name in the log.
 */
export const FX_PROBE_KEY = "EUR/USD";

/** Inputs to {@link resolveFxCompleteness} (the single-track FX adapter). */
export interface FxResolutionInput {
  /** The currently stored FX (EUR/USD) bars. */
  storedFx: Bar[];
  /** The persisted FX probe (under {@link FX_PROBE_KEY}), or `undefined`. */
  probe: StoredCloseProbe | undefined;
  /** The session/window close instant a complete FX track must reach. */
  closeMs: number;
  /** Advance/agreement tolerance. */
  tol: number;
  /** Reached-close tolerance, if different from {@link tol}. */
  completeTol?: number;
  /** Clamp fetched FX bars to the session day / window before judging. */
  clampBars: (bars: Bar[]) => Bar[];
  /** Primary FX leg. */
  fetchPrimary: () => Promise<Bar[]>;
  /** Secondary FX leg for the single escalation; null/omitted disables it. */
  fetchSecondary?: (() => Promise<Bar[]>) | null;
  /** Wall-clock now (ms). */
  now: number;
  /** Outage back-off; null disables. */
  backoff?: CloseProbeBackoff | null;
  /** The back-off key for the FX track. */
  backoffKey?: string;
  /** One structured verdict event for the FX track (C6). */
  log?: (event: CloseResolveLog) => void;
  /** Log label, e.g. `"1D"` / `"1W"`. */
  label: string;
  /** Render a bar instant for the log. */
  formatInstant?: (t: number) => string;
}

/** What {@link resolveFxCompleteness} produces, ready to merge into the store. */
export interface FxResolutionResult {
  /** FX bars to merge, or `undefined` when nothing new was booked. */
  fx?: Bar[];
  /** FX probe to set under {@link FX_PROBE_KEY}, or `undefined`. */
  probe?: StoredCloseProbe;
  /** True when the FX probe should be cleared (reached-close). */
  probeClear: boolean;
}

/**
 * Resolve the **EUR/USD FX track** with the exact same progress → escalate →
 * settle algorithm the price symbols use (new-requirement parity): a per-render
 * redraw after the close must not re-pull FX, an incomplete-but-present FX track
 * must still be advanced to its settled close (so the rebased EUR line is not
 * stuck on a stale intraday rate), and once settled it is remembered for the day.
 *
 * Thin adapter over {@link resolveCloseCompleteness}: FX is modelled as the single
 * {@link FX_PROBE_KEY} symbol so its probe shares the per-day store map and the
 * back-off/logging behaviour is identical to the price legs.
 */
export async function resolveFxCompleteness(
  input: FxResolutionInput,
): Promise<FxResolutionResult> {
  const sym = FX_PROBE_KEY;
  const secondary = input.fetchSecondary ?? null;
  const res = await resolveCloseCompleteness({
    symbols: [sym],
    storedBars: { [sym]: input.storedFx },
    probes: input.probe ? { [sym]: input.probe } : undefined,
    closeMs: input.closeMs,
    tol: input.tol,
    completeTol: input.completeTol,
    clampBars: input.clampBars,
    fetchPrimary: async () => new Map([[sym, await input.fetchPrimary()]]),
    fetchSecondary: secondary ? async () => new Map([[sym, await secondary()]]) : null,
    now: input.now,
    backoff: input.backoff,
    backoffKey: () => input.backoffKey ?? sym,
    log: input.log,
    label: input.label,
    formatInstant: input.formatInstant,
  });
  return {
    fx: res.bars[sym],
    probe: res.closeProbe[sym],
    probeClear: res.closeProbeClear.includes(sym),
  };
}
