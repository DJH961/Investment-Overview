import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { formatTime, formatWeekdayTime, parseInstant } from "../../lib/format";
import type { OverviewDto } from "../../lib/queries/portfolio";
import { useTimeZone } from "../../lib/timezone";
import { Bell } from "lucide-react";
import { useBlip, useMarketPhase, usePrevious, type MarketPhase } from "./marketPhase";
import "./MarketClock.scss";

type FreshnessDto = NonNullable<OverviewDto["freshness"]>;
export type ClockFreshness = Pick<FreshnessDto, "market_state" | "next_open_at" | "next_close_at"> & {
  session_opened_at?: string | null;
  /** The last close before now (half-days and holidays included); the overnight bar starts here. */
  last_close_at?: string | null;
};

export interface MarketClockProps {
  freshness: ClockFreshness | null | undefined;
  /** Called once when a countdown reaches zero (refetch the server's next instants). */
  onBoundary?: () => void;
  /** Fixed clock (tests): no ticking. */
  now?: Date;
  /** "full": the desktop statement. "near": the compact phone band, only in the last 15 min to a bell (and 5 after). "sheet": the statement inside the phone sheet. */
  variant?: "full" | "near" | "sheet";
  /** Ask for fresh instants at zero (default). Off for a second instance of the same clock. */
  fire?: boolean;
}

const SECOND = 1000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The first instant at or after `ms` that is a full hour on the wall clock of `timeZone`. */
export function firstFullHour(ms: number, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat("de-DE", { timeZone, minute: "numeric", second: "numeric" }).formatToParts(new Date(ms));
  const min = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const sec = Number(parts.find((p) => p.type === "second")?.value ?? 0);
  const past = min * MINUTE + sec * 1000 + (ms % 1000);
  return past === 0 ? ms : ms - past + HOUR;
}
const DAY = 24 * HOUR;
/** After the boundary passed, "the bell has rung" is said for this long while the refetch lands. */
const JUST_PASSED = 5 * MINUTE;
/** A regular NYSE session (09:30-16:00) and the wait overnight (16:00-09:30). */
const SESSION = 6.5 * HOUR;
const OVERNIGHT = 17.5 * HOUR;
/** Under this long to a bell the digits take the accent color. */
const SOON = HOUR;
const NY = "America/New_York";

/** "3 h 12 min", "12 min", "45 s": rounded up, so it never says 0 before the moment. */
export function formatCountdown(ms: number): string {
  if (ms < MINUTE) return `${Math.max(1, Math.ceil(ms / 1000))} s`;
  const mins = Math.ceil(ms / MINUTE);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** The same span in words for a screen reader: "1 hour 46 minutes", "2 days 19 hours". */
function spoken(ms: number): string {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (ms < MINUTE) return plural(Math.max(1, Math.ceil(ms / SECOND)), "second");
  const mins = Math.ceil(ms / MINUTE);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  const parts = d > 0 ? [plural(d, "day"), h ? plural(h, "hour") : ""] : [h ? plural(h, "hour") : "", m ? plural(m, "minute") : ""];
  return parts.filter(Boolean).join(" ");
}

export interface CountdownParts {
  days: number;
  /** "HH:MM:SS", zero padded. */
  clock: string;
}

/** Whole seconds, rounded up (never 0 before the moment), as days + HH:MM:SS. Never negative. */
export function splitCountdown(ms: number): CountdownParts {
  const total = Math.max(0, Math.ceil(ms / SECOND));
  const days = Math.floor(total / 86_400);
  const rest = total - days * 86_400;
  const p = (n: number) => String(n).padStart(2, "0");
  return { days, clock: `${p(Math.floor(rest / 3600))}:${p(Math.floor((rest % 3600) / 60))}:${p(rest % 60)}` };
}

export interface ClockView {
  /** "Open", "Closed", "Holiday". */
  state: string;
  /** "since 15:30" (open), else null. */
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
 * How far along the track is (0..1). Open: from the session's open to the close. Closed:
 * from the previous close to the next open (overnight is 17.5 h; a Monday open waits
 * out the weekend, Fri 16:00 to Mon 09:30). Only an approximation of the start: the
 * server sends the next instants only.
 */
export function trackSpan(f: ClockFreshness): { start: number; end: number } | null {
  const open = f.market_state === "open";
  const target = open ? f.next_close_at : f.next_open_at;
  if (!target) return null;
  const at = parseInstant(target).getTime();
  if (Number.isNaN(at)) return null;
  let start: number;
  if (open) {
    const opened = f.session_opened_at ? parseInstant(f.session_opened_at).getTime() : Number.NaN;
    start = Number.isNaN(opened) ? at - SESSION : opened;
  } else {
    // The server's real last close (13:00 ET after a half-day, the day before a holiday);
    // an estimate only for older payloads without it.
    const closed = f.last_close_at ? parseInstant(f.last_close_at).getTime() : Number.NaN;
    if (!Number.isNaN(closed)) start = closed;
    else {
      const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: NY }).format(at);
      start = at - OVERNIGHT - (weekday === "Mon" ? 2 * DAY : 0);
    }
  }
  return at > start ? { start, end: at } : null;
}

export function trackProgress(f: ClockFreshness, now: Date): number | null {
  const s = trackSpan(f);
  if (!s) return null;
  return Math.min(1, Math.max(0, (now.getTime() - s.start) / (s.end - s.start)));
}

/**
 * The current time, re-read on every whole second of the countdown (so the digits flip in
 * step with the bell, not with an arbitrary phase); once past the boundary one last tick
 * ends the "bell has rung" phrase. Nothing ticks for a target long gone (stale data) or a
 * fixed clock. Only this component re-renders.
 */
function useNow(fixed: Date | undefined, target: string | null): Date {
  const [now, setNow] = useState(() => fixed ?? new Date());
  useEffect(() => {
    if (fixed || !target) return;
    const at = parseInstant(target).getTime();
    if (Number.isNaN(at)) return;
    const remaining = at - now.getTime();
    let wait: number;
    if (remaining > 0) wait = remaining % SECOND || SECOND;
    else if (-remaining < JUST_PASSED) wait = JUST_PASSED + remaining;
    else return;
    const id = window.setTimeout(() => setNow(new Date()), Math.max(20, wait));
    return () => window.clearTimeout(id);
  }, [fixed, target, now]);
  return fixed ?? now;
}

/** True when the visitor asked the system for less motion. */
function usePrefersStill(): boolean {
  const [still, setStill] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const on = () => setStill(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return still;
}

/**
 * The market countdown (plan P13), the statement piece of the Overview hero: a big
 * HH:MM:SS to the next bell (NYSE calendar, half-days and holidays from the server),
 * a session track (elapsed part of the trading day, or the wait overnight / over the
 * weekend) and the bell's time in the owner's zone. Under an hour the digits take the
 * accent color; in the last minute the seconds breathe (not with reduced motion).
 * The ticking part is hidden from screen readers, which get one still sentence. When
 * the countdown reaches zero it asks once for fresh instants; a target already in the
 * past at mount (stale data) never triggers a refetch loop and never shows a negative.
 */
export function useClockModel(freshness: ClockFreshness | null | undefined, onBoundary: (() => void) | undefined, fixed: Date | undefined, fire: boolean) {
  const timeZone = useTimeZone();
  const still = usePrefersStill();
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
      if (fire) onBoundary?.();
    }
  }, [target, counting, onBoundary, fire]);
  const { phase } = useMarketPhase(freshness, false, fixed);
  if (!view || !freshness) return null;

  const remaining = view.remaining;
  const bellRang = whichBellRang(freshness, now, phase);
  const rung = bellRang !== null;
  // No zero countdown at a bell: a word says it (see the head).
  const parts = remaining != null ? splitCountdown(remaining) : null;
  const progress = trackProgress(freshness, now);
  const span = trackSpan(freshness);
  // Notches on the full hours of the owner's clock (16:00, 17:00 … for a 15:30 open),
  // none on the long overnight / weekend wait.
  const ticks: number[] = [];
  if (span && span.end - span.start <= 8 * HOUR)
    for (let t = firstFullHour(span.start, timeZone); t < span.end - 1000; t += HOUR)
      if (t > span.start + 1000) ticks.push((t - span.start) / (span.end - span.start));
  const copy = clockLabel({ open, remaining, bellRang, phase, target: view.target, now, timeZone });
  const label = copy.long;
  const soon = remaining != null && remaining <= SOON;
  const last = remaining != null && remaining <= MINUTE;
  const at = view.target ? parseInstant(view.target).getTime() : Number.NaN;
  const diffDay = !Number.isNaN(at) && dayKey(at, timeZone) !== dayKey(now.getTime(), timeZone);
  const bellTime = Number.isNaN(at)
    ? null
    : (remaining != null && remaining >= DAY) || (phase === "holiday" && diffDay)
      ? formatWeekdayTime(at, timeZone)
      : formatTime(new Date(at), timeZone);
  // From the bell until the server's next word: "Closing…" / "Opening", never a stale "Open".
  const stateWord = phase === "closing" ? "Closing…" : phase === "opening" ? "Opening" : view.state;
  const sentence = [
    phase === "closing" ? "Market closing: the closing prices are being settled." : phase === "opening" ? "Market opening." : `Market ${view.state.toLowerCase()}.`,
    remaining != null && bellTime ? `${open ? "Closes" : "Opens"} at ${bellTime}, in ${spoken(remaining)}.` : view.next ? `${view.next}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return { view, open, remaining, parts, progress, span, ticks, rung, bellRang, phase, label, short: copy.short, stateWord, soon, last, bellTime, sentence, still, now, timeZone };
}

/**
 * Which bell rang in the last few minutes ("close" / "open"), or null. From the clock
 * (a counted-to bell just passed), from the payload's own last bell (`last_close_at`,
 * `session_opened_at`: it holds across the refetch that lands right after the bell) or
 * from the phase (the server said "closing" / "opening").
 */
export function whichBellRang(f: ClockFreshness, now: Date, phase: MarketPhase | null): "close" | "open" | null {
  const t = now.getTime();
  const within = (iso: string | null | undefined) => {
    if (!iso) return false;
    const at = parseInstant(iso).getTime();
    return !Number.isNaN(at) && t >= at && t - at < JUST_PASSED;
  };
  const open = f.market_state === "open";
  if ((open && within(f.next_close_at)) || (!open && within(f.last_close_at))) return "close";
  if ((!open && within(f.next_open_at)) || (open && within(f.session_opened_at))) return "open";
  if (phase === "closing") return within(f.next_close_at) || within(f.last_close_at) ? "close" : null;
  if (phase === "opening") return within(f.next_open_at) || within(f.session_opened_at) ? "open" : null;
  return null;
}

/** Same calendar day in `timeZone`? */
function dayKey(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

/**
 * The clock's head line, long (wide screens) and short (phones, fits 360 px):
 * - a bell just rang: "The closing bell has rung" / "Bell! Closing time";
 * - still settling the close / waiting for the first tick;
 * - open: "Until the closing bell";
 * - closed: under an hour "Until the opening bell", the next morning "Opens in 17 h",
 *   further off (a weekend, a holiday) "See you Mon 15:30" (the owner's zone).
 */
export function clockLabel(o: {
  open: boolean;
  remaining: number | null;
  bellRang: "close" | "open" | null;
  phase: MarketPhase | null;
  target: string | null;
  now: Date;
  timeZone?: string;
}): { long: string; short: string } {
  // Once the close is settled the clock reads like any shut market ("Opens in 17 h"), not "Bell! Closing time".
  if (o.bellRang === "close" && o.phase !== "closed") return { long: "The closing bell has rung", short: "Bell! Closing time" };
  if (o.bellRang === "open") return { long: "The opening bell has rung", short: "Bell! Market's open" };
  if (o.phase === "closing") return { long: "Settling the closing prices", short: "Settling the close" };
  if (o.phase === "opening") return { long: "Waiting for the first prices", short: "First prices soon" };
  if (o.open) return { long: "Until the closing bell", short: "Until the closing bell" };
  if (o.remaining == null || o.remaining <= SOON || !o.target) return { long: "Until the opening bell", short: "Until the opening bell" };
  const at = parseInstant(o.target).getTime();
  const tomorrow = dayKey(at, o.timeZone) === dayKey(o.now.getTime() + DAY, o.timeZone) || dayKey(at, o.timeZone) === dayKey(o.now.getTime(), o.timeZone);
  if (o.phase === "holiday") {
    const when = formatWeekdayTime(at, o.timeZone);
    return { long: `Holiday · opens ${when}`, short: `Holiday · ${when}` };
  }
  if (tomorrow && o.remaining < DAY) {
    const text = `Opens in ${Math.floor(o.remaining / HOUR)} h`;
    return { long: text, short: text };
  }
  const text = `See you ${formatWeekdayTime(at, o.timeZone)}`;
  return { long: text, short: text };
}

/** The compact "Open for 1h 46m" text (state, then the time until it changes): minutes only, never seconds (the quiet phone chip). */
export function formatChipSpan(ms: number): string {
  const mins = Math.max(1, Math.ceil(ms / MINUTE));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** True while the compact phone band shows: the last 15 minutes to a bell and 5 minutes after it rang. */
export const NEAR_WINDOW = 15 * MINUTE;

export function MarketClock({ freshness, onBoundary, now: fixed, variant = "full", fire = true }: MarketClockProps) {
  const model = useClockModel(freshness, onBoundary, fixed, fire);
  // The session bar finishes with one light sweep when the closing bell rings.
  const modelPhase = model?.phase ?? null;
  const prevPhase = usePrevious(modelPhase);
  const sweeping = useBlip(modelPhase === "closing" && prevPhase !== "closing", 1800) && !model?.still;
  if (!model) return null;
  const { open, remaining, parts, progress, span, ticks, rung, bellRang, phase, label, short, stateWord, soon, last, bellTime, sentence, still, timeZone } =
    model;
  // Settling the close / waiting for the first tick: the head says so even without digits.
  const pending = phase === "closing" || phase === "opening";
  const worded = Boolean(parts) || pending || rung;
  const bellWord = parts ? null : phase === "closing" ? "Settling…" : phase === "opening" ? "Opening…" : bellRang === "close" ? "Closed" : bellRang === "open" ? "Open" : null;
  if (variant === "near" && !(rung || pending || (parts && remaining != null && remaining <= NEAR_WINDOW))) return null;
  return (
    <section
      className={clsx(
        "market-clock",
        open ? "market-clock--open" : "market-clock--shut",
        soon && "market-clock--soon",
        last && !still && "market-clock--last",
        !parts && "market-clock--bare",
        parts && parts.days > 0 && "market-clock--days",
        rung && !still && "market-clock--ring",
        pending && "market-clock--pending",
        variant !== "full" && `market-clock--${variant}`,
      )}
      data-testid="market-clock"
      data-phase={phase ?? undefined}
      aria-label="Market clock"
    >
      <p className="market-clock__sr" aria-live="off">
        {sentence}
      </p>
      <div className="market-clock__visual" aria-hidden>
        <div className="market-clock__head">
          <span className="market-clock__label">
            <span className={clsx("market-clock__bell", bellRang && "market-clock__bell--rang")} data-testid="market-clock-bell">
              <Bell className="market-clock__bell-icon" aria-hidden />
            </span>
            {!worded ? (
              <span className="market-clock__label-text">{stateWord}</span>
            ) : short !== label ? (
              <>
                <span className="market-clock__label-text market-clock__label-text--long">{label}</span>
                <span className="market-clock__label-text market-clock__label-text--short">{short}</span>
              </>
            ) : (
              <span className="market-clock__label-text">{label}</span>
            )}
          </span>
          <span className="market-clock__state">{worded ? stateWord : null}</span>
        </div>
        {parts && (
          <div className="market-clock__digits" data-testid="market-clock-digits">
            {parts.days > 0 && (
              <span className="market-clock__days">
                {parts.days}
                <abbr className="market-clock__unit" title="days">
                  d
                </abbr>
              </span>
            )}
            <span className="market-clock__time">{parts.clock}</span>
          </div>
        )}
        {bellWord && (
          <div className="market-clock__digits market-clock__digits--word" data-testid="market-clock-word">
            <span className="market-clock__time">{bellWord}</span>
          </div>
        )}
        {progress != null && span && (
          <div className="market-clock__bar" data-testid="market-clock-track">
            <div className="market-clock__track">
              <span className="market-clock__fill" style={{ width: `${(progress * 100).toFixed(2)}%` }} />
              {sweeping && <span className="market-clock__sweep" data-testid="market-clock-sweep" />}
              {ticks.map((t) => (
                <span key={t} className="market-clock__tick" style={{ left: `${(t * 100).toFixed(3)}%` }} />
              ))}
            </div>
            <div className="market-clock__ends">
              <span>{open ? formatTime(new Date(span.start), timeZone) : "Last close"}</span>{" "}
              <span>{bellTime}</span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
