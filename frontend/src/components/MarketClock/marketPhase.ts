import { useEffect, useRef, useState } from "react";
import { parseInstant } from "../../lib/format";
import { useRefreshState, type MarketSessionEvent } from "../../lib/refresh";
import type { ClockFreshness } from "./MarketClock";

/**
 * Where the US session stands for the screen, from the bell to the first tick:
 * live → closing → closed, and closed → opening → live.
 * - `live`: open and prices streaming. `open`: open, prices not live (stalled, delayed).
 * - `closing`: the closing bell rang and the server is settling the closing prices.
 * - `closed` / `holiday`: shut, the close is in.
 * - `opening`: the opening bell rang, the first tick has not landed yet.
 */
export type MarketPhase = "live" | "open" | "closing" | "closed" | "opening" | "holiday";

const MINUTE = 60_000;
/** A `closing` event older than this no longer holds (the `closed` one got lost): the payload decides. */
export const CLOSING_MAX = 15 * MINUTE;
/** The same for `opening` (no tick came: the payload decides). */
export const OPENING_MAX = 30 * MINUTE;
/** The hero says "Closed" for this long after the close, then the clock alone says it. */
export const JUST_CLOSED = 60 * MINUTE;

const ms = (iso: string | null | undefined): number => {
  if (!iso) return Number.NaN;
  return parseInstant(iso).getTime();
};

export interface PhaseInput {
  freshness: ClockFreshness | null | undefined;
  /** The last `market_session` event, if any. */
  session: MarketSessionEvent | null;
  /** The last tick's (or bell's) `prices_live`; null before the first. */
  pricesLive: boolean | null;
  /** The payload's own "prices are live" (`daily_caption.live`). */
  payloadLive: boolean;
  now: Date;
}

/** The phase the payload and the clock alone give, with the instant it began (for ordering against an event). */
function basePhase(f: ClockFreshness, now: number): { phase: MarketPhase; since: number } {
  // A bell passed on the client clock holds "closing" / "opening" only for a while: a
  // payload whose instants are long past (stale cache, fixtures) keeps its own state.
  if (f.market_state === "open") {
    const close = ms(f.next_close_at);
    if (!Number.isNaN(close) && now >= close && now - close < CLOSING_MAX) return { phase: "closing", since: close };
    const opened = ms(f.session_opened_at);
    return { phase: "open", since: Number.isNaN(opened) ? -Infinity : opened };
  }
  const open = ms(f.next_open_at);
  if (!Number.isNaN(open) && now >= open && now - open < OPENING_MAX) return { phase: "opening", since: open };
  const closed = ms(f.last_close_at);
  return { phase: f.market_state === "holiday" ? "holiday" : "closed", since: Number.isNaN(closed) ? -Infinity : closed };
}

/** Whether the bell event still holds (a lost follow-up never leaves "Closing…" up for good). */
function eventHolds(ev: MarketSessionEvent, now: number): boolean {
  const age = now - ev.receivedAt;
  if (ev.state === "closing") return age < CLOSING_MAX;
  if (ev.state === "opening") return age < OPENING_MAX;
  return true;
}

/**
 * The phase on screen. The payload and the client clock give one (a bell passed on the
 * clock means "closing" / "opening" until the payload catches up); a newer
 * `market_session` event overrides it (the event wins). Live needs prices that stream.
 */
export function marketPhase({ freshness, session, pricesLive, payloadLive, now }: PhaseInput): MarketPhase | null {
  if (!freshness) return null;
  const t = now.getTime();
  const base = basePhase(freshness, t);
  let phase = base.phase;
  let fromEvent = false;
  if (session && eventHolds(session, t)) {
    const at = ms(session.at);
    // An event from before the payload's own last bell is old news.
    if (Number.isNaN(at) || at >= base.since) {
      phase = session.state;
      fromEvent = true;
    }
  }
  if (phase === "closed" && freshness.market_state === "holiday") return "holiday";
  if (phase === "opening") {
    // The first tick after the opening bell turns it live (the bell cleared pricesLive).
    return fromEvent && pricesLive === true ? "live" : "opening";
  }
  if (phase === "open") return (pricesLive ?? payloadLive) ? "live" : "open";
  return phase;
}

/** The next instant at which the phase can change by the clock alone (ms), or null. */
export function nextPhaseChange({ freshness, session, now }: Pick<PhaseInput, "freshness" | "session" | "now">): number | null {
  if (!freshness) return null;
  const t = now.getTime();
  const bell = freshness.market_state === "open" ? ms(freshness.next_close_at) : ms(freshness.next_open_at);
  const candidates = [
    bell,
    bell + (freshness.market_state === "open" ? CLOSING_MAX : OPENING_MAX),
    ms(freshness.last_close_at) + JUST_CLOSED,
    session?.state === "closing" ? session.receivedAt + CLOSING_MAX : Number.NaN,
    session?.state === "opening" ? session.receivedAt + OPENING_MAX : Number.NaN,
  ].filter((v) => Number.isFinite(v) && v > t);
  return candidates.length ? Math.min(...candidates) : null;
}

/**
 * The market phase, kept current: it re-reads the clock at the next bell or when a bell
 * event runs out, and follows the refresh state (ticks, `market_session` events). A
 * fixed clock (tests) never ticks.
 */
export function useMarketPhase(freshness: ClockFreshness | null | undefined, payloadLive: boolean, fixed?: Date): { phase: MarketPhase | null; now: Date } {
  const refresh = useRefreshState();
  const [wall, setWall] = useState(() => new Date());
  const now = fixed ?? wall;
  const session = refresh.marketSession;
  const next = fixed ? null : nextPhaseChange({ freshness, session, now });
  useEffect(() => {
    if (next === null) return;
    const id = window.setTimeout(() => setWall(new Date()), Math.min(2 ** 31 - 1, Math.max(20, next - Date.now() + 20)));
    return () => window.clearTimeout(id);
  }, [next]);
  // A new event re-reads the clock too (its age counts from now).
  useEffect(() => {
    if (!fixed && session) setWall(new Date());
  }, [session, fixed]);
  return { phase: marketPhase({ freshness, session, pricesLive: refresh.pricesLive, payloadLive, now }), now };
}

/** The phase it was just before the current one (null on the first render), for one-off cues. */
export function usePrevious<T>(value: T): T | null {
  const ref = useRef<{ cur: T; prev: T | null }>({ cur: value, prev: null });
  if (ref.current.cur !== value) ref.current = { cur: value, prev: ref.current.cur };
  return ref.current.prev;
}

/**
 * True for `duration` ms after `on` turns true (again each time it turns true), false
 * as soon as `on` is false. Drives a one-shot animation class.
 */
export function useBlip(on: boolean, duration: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    setShown(on);
    if (!on) return undefined;
    const id = window.setTimeout(() => setShown(false), duration);
    return () => window.clearTimeout(id);
  }, [on, duration]);
  return shown;
}
