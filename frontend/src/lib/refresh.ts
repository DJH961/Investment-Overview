import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useToast } from "../components/Toast";
import { ApiError, api } from "./api";
import type { components } from "./api-types";
import { markStale, markStaleAndRefetch, scheduleRefetch } from "./queries/invalidation";

type RefreshStatusDto = components["schemas"]["RefreshStatus"];

/** What the app knows about the server's price refresh (fed by SSE, the POST and polling). */
export interface RefreshState {
  running: boolean;
  /** The owner asked for this run (refresh button, pull-to-refresh): louder feedback than a scheduled one. */
  explicit: boolean;
  source: string | null;
  /** A historic download (determinate progress) rather than a quote round. */
  historical: boolean;
  done: number;
  total: number;
  label: string | null;
  /** When new prices last landed (ISO), from `refresh_finished` / `tick`. */
  lastUpdateAt: string | null;
  /** From the latest tick: market open, a fresh pull and a recent (non-frozen) price. */
  pricesLive: boolean | null;
  /** From the latest tick: when the newest stock/ETF price was struck (ISO). */
  priceMarketAt: string | null;
  /**
   * Counts the automatic updates that landed (a tick, or an auto run with no tick after
   * it). Each new value plays the top bar's one-turn "landed" cue once.
   */
  landed: number;
  /** The last `market_session` SSE event (the server's bell), or null before the first one. */
  marketSession: MarketSessionEvent | null;
}

/** A US-market bell from the server: `closing` at the close while EOD settles, `closed` once it is in, `opening` at the open, `open` with the first tick. */
export type MarketSessionState = "opening" | "open" | "closing" | "closed";

export interface MarketSessionEvent {
  state: MarketSessionState;
  /** When the server published it (ISO). */
  at: string | null;
  /** The next bell after this one (ISO), when known. */
  nextBell: string | null;
  /** When this client received it (ms): ages the event when the server's clock is not trusted. */
  receivedAt: number;
}

const SESSION_STATES: readonly MarketSessionState[] = ["opening", "open", "closing", "closed"];

export const IDLE_REFRESH: RefreshState = {
  running: false,
  explicit: false,
  source: null,
  historical: false,
  done: 0,
  total: 0,
  label: null,
  lastUpdateAt: null,
  pricesLive: null,
  priceMarketAt: null,
  landed: 0,
  marketSession: null,
};

let state: RefreshState = IDLE_REFRESH;
const listeners = new Set<() => void>();

export function getRefreshState(): RefreshState {
  return state;
}

export function setRefreshState(patch: Partial<RefreshState>): void {
  const next = { ...state, ...patch };
  if ((Object.keys(next) as (keyof RefreshState)[]).every((k) => next[k] === state[k])) return;
  state = next;
  listeners.forEach((l) => l());
}

/** Test helper: back to idle. */
export function resetRefreshState(): void {
  if (autoRefetchTimer) clearTimeout(autoRefetchTimer);
  autoRefetchTimer = undefined;
  state = IDLE_REFRESH;
  listeners.forEach((l) => l());
}

/**
 * An automatic run's reports refetch waits for the tick that follows it (the scheduler
 * publishes `refresh_finished`, then `tick` with the new totals), so a minute brings ONE
 * wave of refetches, not two. If no tick comes within this delay the refetch runs anyway.
 */
export const AUTO_REFETCH_WAIT_MS = 8000;
let autoRefetchTimer: ReturnType<typeof setTimeout> | undefined;

function landed(): void {
  setRefreshState({ landed: state.landed + 1 });
}

function deferAutoRefetch(queryClient: QueryClient): void {
  // Stale now (inactive pages refetch when opened); the active ones refetch with the tick.
  markStale(queryClient, "refresh");
  if (autoRefetchTimer) clearTimeout(autoRefetchTimer);
  autoRefetchTimer = setTimeout(() => {
    autoRefetchTimer = undefined;
    scheduleRefetch(queryClient, "refresh");
    landed();
  }, AUTO_REFETCH_WAIT_MS);
}

/**
 * A tick arrived: whether an automatic run's refetch was waiting for it. The caller then
 * refetches the wider "refresh" set in the tick's single wave.
 */
export function takeDeferredAutoRefetch(): boolean {
  if (!autoRefetchTimer) return false;
  clearTimeout(autoRefetchTimer);
  autoRefetchTimer = undefined;
  return true;
}

export function useRefreshState(): RefreshState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => IDLE_REFRESH,
  );
}

/** A refresh finished: mark the report queries stale and refetch the open ones once (staggered). */
export function invalidateReports(queryClient: QueryClient): void {
  markStaleAndRefetch(queryClient, "refresh");
}

function fromStatus(s: RefreshStatusDto): Partial<RefreshState> {
  return {
    running: s.running,
    ...(s.running ? {} : { explicit: false }),
    source: s.source ?? null,
    historical: s.historical,
    done: s.progress_done,
    total: s.progress_total,
    label: s.progress_label ?? null,
    ...(s.last_update_at ? { lastUpdateAt: s.last_update_at } : {}),
  };
}

/** Applies one SSE event of the refresh family. Returns true when it was one. */
export function applyRefreshEvent(queryClient: QueryClient, ev: Record<string, unknown>): boolean {
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  switch (ev.type) {
    case "refresh_started":
      setRefreshState({ running: true, source: str(ev.source), historical: false, done: 0, total: 0, label: null });
      return true;
    case "refresh_progress":
      setRefreshState({
        running: true,
        historical: ev.historical === true,
        done: num(ev.progress_done),
        total: num(ev.progress_total),
        label: str(ev.progress_label),
      });
      return true;
    case "refresh_finished": {
      const last = str(ev.last_update_at);
      const explicit = state.explicit;
      setRefreshState({
        running: false,
        explicit: false,
        historical: false,
        done: 0,
        total: 0,
        label: null,
        ...(last ? { lastUpdateAt: last } : {}),
      });
      // The owner's own refresh shows its result at once; an automatic one waits for its tick.
      if (explicit) invalidateReports(queryClient);
      else deferAutoRefetch(queryClient);
      return true;
    }
    case "market_session":
    case "session_closed":
    case "session_opened": {
      // `session_closed` / `session_opened` are the plan's older names for the same bells.
      const named = ev.type === "session_closed" ? "closed" : ev.type === "session_opened" ? "opening" : ev.state;
      if (!SESSION_STATES.includes(named as MarketSessionState)) return true;
      const session = named as MarketSessionState;
      // From the close until a new session's first tick the last tick's "live" is stale:
      // clear it, so nothing keeps saying "Live" past the bell.
      const pricesLive = session === "open" ? (typeof ev.prices_live === "boolean" ? ev.prices_live : state.pricesLive) : false;
      setRefreshState({
        pricesLive,
        marketSession: { state: session, at: str(ev.at), nextBell: str(ev.next_bell), receivedAt: Date.now() },
      });
      return true;
    }
    case "tick":
    case "fx": {
      // A fresh live FX rate moves the "Updated" stamp too (the server sends it on both).
      const last = str(ev.last_update_at);
      setRefreshState({
        ...(last ? { lastUpdateAt: last } : {}),
        ...(typeof ev.prices_live === "boolean" ? { pricesLive: ev.prices_live } : {}),
        ...(str(ev.price_market_at) ? { priceMarketAt: str(ev.price_market_at) } : {}),
      });
      // A tick with news lands visibly (one turn of the icon); an FX-only update just moves the stamp.
      if (ev.type === "tick" && ev.unchanged !== true) landed();
      return false; // ticks also drive the live query invalidation
    }
    default:
      return false;
  }
}

const POLL_MS = 2000;

/** A 409 from `POST /api/refresh` that means "the close is being settled" (`detail.reason === "settling_close"`). */
export function isSettlingClose(body: unknown): boolean {
  if (!body || typeof body !== "object" || !("detail" in body)) return false;
  const detail = (body as { detail: unknown }).detail;
  if (!detail || typeof detail !== "object") return false;
  const { reason, code } = detail as { reason?: unknown; code?: unknown };
  return reason === "settling_close" || code === "settling_close";
}

/**
 * Top-bar refresh: `POST /api/refresh?force=true` (409 = already running, which
 * is fine), then wait for `refresh_finished` over SSE. While running it also polls
 * `/api/refresh/status` every 2 s as a fallback for a dropped stream; on
 * completion every report query is refetched.
 */
export function useServerRefresh(): { start: () => void; state: RefreshState } {
  const queryClient = useQueryClient();
  const current = useRefreshState();
  const { toast } = useToast();

  const start = useCallback(() => {
    if (getRefreshState().running) return;
    setRefreshState({ running: true, explicit: true, source: "manual", historical: false, done: 0, total: 0, label: null });
    // The POST only starts the job; a bounded wait keeps a dead connection from
    // leaving the bar spinning forever.
    api<RefreshStatusDto>("/api/refresh?force=true", { method: "POST", timeoutMs: 30_000 })
      .then((s) => setRefreshState({ ...fromStatus(s), running: true }))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 409) {
          // The bell just rang and the server is settling the closing prices: a calm
          // note, never an error. The status poll ends "Updating…" when EOD is in.
          if (isSettlingClose(err.body)) {
            toast({ title: "Closing prices are being settled…", description: "The day's closing prices appear in a minute." });
            return;
          }
          // Already running (another device or the schedule): say so here, keep "Updating…".
          toast({ title: "A refresh is already running", description: "The new prices appear when it finishes." });
          return;
        }
        setRefreshState({ running: false, explicit: false });
        toast({
          title: "Couldn't start a refresh",
          description: err instanceof Error ? err.message : undefined,
          tone: "error",
        });
      });
  }, [toast]);

  useEffect(() => {
    if (!current.running) return;
    let cancelled = false;
    const timer = setInterval(() => {
      api<RefreshStatusDto>("/api/refresh/status", { timeoutMs: 5000 })
        .then((s) => {
          if (cancelled || !getRefreshState().running) return;
          setRefreshState(fromStatus(s));
          if (!s.running) invalidateReports(queryClient);
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [current.running, queryClient]);

  return { start, state: current };
}

/**
 * How loudly the app reports an update. "loud": the owner asked (refresh button,
 * pull-to-refresh) or a history download has progress to show: progress bar, status
 * chip, the icon spinning the whole time. "quiet": the server is updating by itself
 * (a scheduled pull): the icon stays still with a soft pulse ring, and when it lands
 * it turns once (`RefreshState.landed`). Background refetches of the pages' own data
 * are not an update at all: they leave the bar idle.
 */
export type UpdateMode = "idle" | "quiet" | "loud";

export function deriveUpdateMode(refresh: Pick<RefreshState, "running" | "explicit" | "historical">): UpdateMode {
  if (!refresh.running) return "idle";
  // A historic download has real progress to show, so it keeps the bar even when nobody clicked.
  return refresh.explicit || refresh.historical ? "loud" : "quiet";
}

export function useUpdateMode(): UpdateMode {
  return deriveUpdateMode(useRefreshState());
}
