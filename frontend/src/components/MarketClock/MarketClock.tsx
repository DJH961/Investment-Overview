import { Clock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { formatTime, formatWeekdayTime, parseInstant } from "../../lib/format";
import type { OverviewDto } from "../../lib/queries/portfolio";
import { useTimeZone } from "../../lib/timezone";
import "./MarketClock.scss";

type FreshnessDto = NonNullable<OverviewDto["freshness"]>;
export type ClockFreshness = Pick<FreshnessDto, "market_state" | "next_open_at" | "next_close_at"> & {
  session_opened_at?: string | null;
};

export interface MarketClockProps {
  freshness: ClockFreshness | null | undefined;
  /** Called once when a countdown reaches zero (refetch the server's next instants). */
  onBoundary?: () => void;
  /** Fixed clock (tests): no ticking. */
  now?: Date;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** After the boundary passed, "now" is said for this long while the refetch lands. */
const JUST_PASSED = 5 * MINUTE;

/** "3 h 12 min", "12 min", "45 s": rounded up, so it never says 0 before the moment. */
export function formatCountdown(ms: number): string {
  if (ms < MINUTE) return `${Math.max(1, Math.ceil(ms / 1000))} s`;
  const mins = Math.ceil(ms / MINUTE);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export interface ClockView {
  /** "Open", "Closed", "Holiday". */
  state: string;
  /** "since 15:30" (open, desktop only), else null. */
  since: string | null;
  /** "closes in 3 h 12 min", "opens Mon 15:30", "closing now"; null when the instant is unknown or stale. */
  next: string | null;
  /** Milliseconds to the boundary (null: none / already past). */
  remaining: number | null;
  /** The instant being counted to. */
  target: string | null;
}

/**
 * What the clock says, from the server's next open / close and the current time. A
 * target in the past (a stale payload, fixtures recorded days ago) never shows a
 * negative time: just after the moment it says "now", later only the state.
 */
export function clockView(f: ClockFreshness, now: Date, timeZone?: string): ClockView {
  const open = f.market_state === "open";
  const state = open ? "Open" : f.market_state === "holiday" ? "Holiday" : "Closed";
  const target = (open ? f.next_close_at : f.next_open_at) ?? null;
  const at = target ? parseInstant(target).getTime() : Number.NaN;
  const since = open && f.session_opened_at ? `since ${formatTime(f.session_opened_at, timeZone)}` : null;
  if (Number.isNaN(at)) return { state, since, next: null, remaining: null, target: null };
  const ms = at - now.getTime();
  const verb = open ? "closes" : "opens";
  if (ms <= 0) {
    const next = -ms < JUST_PASSED ? (open ? "closing now" : "opening now") : null;
    return { state, since, next, remaining: null, target };
  }
  const next = ms < 24 * HOUR ? `${verb} in ${formatCountdown(ms)}` : `${verb} ${formatWeekdayTime(at, timeZone)}`;
  return { state, since, next, remaining: ms, target };
}

/**
 * The current time, re-read once a second in the last two minutes, else every 15 s,
 * landing on the boundary itself; once past it, one last tick ends the "now" phrase.
 * Nothing ticks for a target long gone (stale data) or a fixed clock.
 */
function useNow(fixed: Date | undefined, target: string | null): Date {
  const [now, setNow] = useState(() => fixed ?? new Date());
  useEffect(() => {
    if (fixed || !target) return;
    const at = parseInstant(target).getTime();
    if (Number.isNaN(at)) return;
    const remaining = at - now.getTime();
    let wait: number;
    if (remaining > 0) wait = Math.min(remaining <= 2 * MINUTE ? 1000 : 15_000, remaining);
    else if (-remaining < JUST_PASSED) wait = JUST_PASSED + remaining;
    else return;
    const id = window.setTimeout(() => setNow(new Date()), Math.max(50, wait));
    return () => window.clearTimeout(id);
  }, [fixed, target, now]);
  return fixed ?? now;
}

/**
 * The market clock (plan P13) in the Overview hero: "Open since 15:30 · closes in
 * 3 h 12 min" or "Closed · opens in 2 h 14 min", in the owner's time zone. Pure
 * presentation of the server's next open / close (NYSE calendar, half-days included).
 * When a countdown reaches zero it asks once for fresh instants; a target already in
 * the past at mount (stale data) never triggers a refetch loop. One line on phones.
 */
export function MarketClock({ freshness, onBoundary, now: fixed }: MarketClockProps) {
  const timeZone = useTimeZone();
  const open = freshness?.market_state === "open";
  const now = useNow(fixed, (open ? freshness?.next_close_at : freshness?.next_open_at) ?? null);
  const view = freshness ? clockView(freshness, now, timeZone) : null;
  // Fire once per target, and only when this clock saw it count down to zero.
  const armed = useRef<string | null>(null);
  const fired = useRef<string | null>(null);
  const target = view?.target ?? null;
  const counting = view?.remaining != null;
  useEffect(() => {
    if (!target) return;
    if (counting) {
      armed.current = target;
      return;
    }
    if (armed.current === target && fired.current !== target) {
      fired.current = target;
      onBoundary?.();
    }
  }, [target, counting, onBoundary]);
  if (!view) return null;
  return (
    <p className="market-clock" data-testid="market-clock" aria-live="off">
      <span className="market-clock__line">
        <Clock className="market-clock__icon" aria-hidden />
        <span className="market-clock__state">{view.state}</span>
        {view.since && <span className="market-clock__since">{view.since}</span>}
        {view.next && (
          <>
            <span className="market-clock__sep" aria-hidden>
              ·
            </span>
            <span className="market-clock__next">{view.next}</span>
          </>
        )}
      </span>
    </p>
  );
}
