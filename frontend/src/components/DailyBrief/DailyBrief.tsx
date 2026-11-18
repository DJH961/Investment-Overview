import { ArrowDownRight, ArrowUpRight, CalendarRange, Newspaper, Repeat, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Chip } from "../Chip";
import { DeltaBadge } from "../DeltaBadge";
import { IconButton } from "../IconButton";
import { Money } from "../Money";
import { Percent } from "../Percent";
import { useDisplayPrefs } from "../../lib/displayPrefs";
import { formatDayLabel, formatDayTime, formatNumber, formatWeekdayTime } from "../../lib/format";
import type { ReportingCurrency } from "../../lib/prefs";
import { toNum, useOverview } from "../../lib/queries/portfolio";
import {
  useAckBrief,
  useBrief,
  type BriefDto,
  type BriefMoveDto,
  type BriefMoverDto,
} from "../../lib/queries/brief";
import { useTimeZone } from "../../lib/timezone";
import "./DailyBrief.scss";

export interface DailyBriefProps {
  currency: ReportingCurrency;
}

const DAY_MS = 86_400_000;

/** "Tue 16:00" within the last six days, "Tue 30 Jun 16:00" further back. */
export function sinceLabel(iso: string, now: string, timeZone?: string): string {
  const gap = Date.parse(now) - Date.parse(iso);
  return Number.isFinite(gap) && gap >= 0 && gap < 6 * DAY_MS ? formatWeekdayTime(iso, timeZone) : formatDayTime(iso, timeZone);
}

/** "2:41": a countdown in minutes and seconds (rounded up, never below 0:00). */
export function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** An EUR/USD rate for a "then → now" line: four decimals in the owner's number format. */
const rate = (v: string) => formatNumber(toNum(v), 4);

/** One figure of the brief: an eyebrow label, the figure, an optional small line under it. */
function Fact({ label, value, note, testId, wide = false }: { label: ReactNode; value: ReactNode; note?: ReactNode; testId?: string; wide?: boolean }) {
  return (
    <div className={wide ? "daily-brief__fact daily-brief__fact--wide" : "daily-brief__fact"} data-testid={testId}>
      <dt className="daily-brief__label">{label}</dt>
      <dd className="daily-brief__value">{value}</dd>
      {note && <dd className="daily-brief__note">{note}</dd>}
    </div>
  );
}

function SessionFact({ move, currency }: { move: BriefMoveDto; currency: ReportingCurrency }) {
  // The euro view splits the move into the market and the currency; the dollar view has
  // no currency leg, so it shows the book's value then → now instead.
  const fx = toNum(move.currency_move ?? null);
  const kpis = useOverview(currency).data?.kpis;
  // The hero's headline book: the estimate while estimating, else the official total.
  const total = toNum((move.estimated ? kpis?.estimate?.total_value : null) ?? kpis?.total_value ?? null);
  const dayMove = toNum(move.day_move ?? null);
  // Shown to the cent, Market + Currency must add up to the headline as displayed:
  // Market = rounded headline − rounded currency part (a display subtraction only).
  const cents = (v: number) => Math.round(v * 100) / 100;
  const market = dayMove !== null && fx !== null ? cents(cents(dayMove) - cents(fx)) : toNum(move.price_move ?? null);
  // The Overview's value is the book after that session only when it is the same session.
  const sameDay = !kpis?.daily_growth_as_of || kpis.daily_growth_as_of === move.session_date;
  const now = sameDay ? total : null;
  const start = now !== null && dayMove !== null ? now - dayMove : null;
  return (
    <Fact
      testId="brief-session"
      label={
        <>
          <span className="daily-brief__long">Session of </span>
          <span className="daily-brief__short">Session </span>
          {formatDayLabel(move.session_date)}
          {move.estimated && <span className="daily-brief__est"> ≈ est.</span>}
        </>
      }
      value={
        <span className="daily-brief__figure" data-testid="brief-figure">
          <Money amount={toNum(move.day_move ?? null)} currency={currency} signed colored />
          <DeltaBadge value={toNum(move.day_move_pct ?? null)} />
        </span>
      }
      note={
        currency === "EUR" ? (
          <span className="daily-brief__parts" data-testid="brief-split" data-ccy-specific="">
            <span className="daily-brief__pair">
              <span className="daily-brief__key">Market</span>
              <Money amount={market} currency={currency} signed colored />
            </span>
            {fx !== null && (
              <span className="daily-brief__pair">
                <span className="daily-brief__key">Currency</span>
                <Money amount={fx} currency={currency} signed colored />
              </span>
            )}
          </span>
        ) : (
          // The dollar view: the headline is the whole move, so "Market" would repeat it;
          // the line says where the book stood instead (server values, one subtraction).
          start !== null &&
          now !== null && (
            <span className="daily-brief__line" data-testid="brief-value-path" data-ccy-specific="">
              <Money amount={start} currency={currency} digits={0} /> → <Money amount={now} currency={currency} digits={0} />
            </span>
          )
        )
      }
    />
  );
}

// TODO: switch to `S["BriefOut"]["window_move"]` once api-types.ts carries it.
/** The whole absence as one move (server figures: EUR parts add up, flows are separate). */
export interface BriefWindowMove {
  start_at: string;
  end_at: string;
  start_value: string | null;
  end_value: string | null;
  move: string | null;
  pct: string | null;
  price_move: string | null;
  currency_move: string | null;
  net_flows: string | null;
  estimated: boolean;
  start_basis?: "intraday" | "close";
  movers?: BriefMoveDto["movers"];
}
type WindowByCurrency = { EUR: BriefWindowMove | null; USD: BriefWindowMove | null } | null;
const windowOf = (b: BriefDto, currency: ReportingCurrency): BriefWindowMove | null =>
  (b as BriefDto & { window_move?: WindowByCurrency }).window_move?.[currency] ?? null;

/** A custom time frame (several sessions away): the same figure row as one session. */
function WindowFact({ brief, w, currency }: { brief: BriefDto; w: BriefWindowMove; currency: ReportingCurrency }) {
  const move = toNum(w.move);
  const fx = toNum(w.currency_move);
  // Shown to the cent, Market + Currency add up to the headline as displayed.
  const cents = (v: number) => Math.round(v * 100) / 100;
  const market = move !== null && fx !== null ? cents(cents(move) - cents(fx)) : toNum(w.price_move);
  const flows = toNum(w.net_flows);
  const first = brief.sessions[0];
  const last = brief.sessions[brief.sessions.length - 1];
  const days = first && last && first !== last ? `${formatDayLabel(first)} – ${formatDayLabel(last)}` : first ? formatDayLabel(first) : null;
  const start = toNum(w.start_value);
  const end = toNum(w.end_value);
  const deposits =
    flows !== null && flows !== 0 ? (
      <span className="daily-brief__pair" data-testid="brief-flows">
        <span className="daily-brief__key">{flows > 0 ? "Deposits" : "Withdrawals"}</span>
        <Money amount={Math.abs(flows)} currency={currency} />
      </span>
    ) : null;
  return (
    <Fact
      testId="brief-window-move"
      label={
        <>
          {days ?? "Time away"}
          {w.estimated && <span className="daily-brief__est"> ≈ est.</span>}
        </>
      }
      value={
        <span className="daily-brief__figure" data-testid="brief-figure">
          <Money amount={move} currency={currency} signed colored />
          <DeltaBadge value={toNum(w.pct)} />
        </span>
      }
      note={
        currency === "EUR" ? (
          <span className="daily-brief__parts" data-testid="brief-split" data-ccy-specific="">
            <span className="daily-brief__pair">
              <span className="daily-brief__key">Market</span>
              <Money amount={market} currency={currency} signed colored />
            </span>
            {fx !== null && (
              <span className="daily-brief__pair">
                <span className="daily-brief__key">Currency</span>
                <Money amount={fx} currency={currency} signed colored />
              </span>
            )}
            {deposits}
          </span>
        ) : (
          <>
            {start !== null && end !== null && (
              <span className="daily-brief__line" data-testid="brief-value-path" data-ccy-specific="">
                <Money amount={start} currency={currency} digits={0} /> → <Money amount={end} currency={currency} digits={0} />
              </span>
            )}
            {deposits && <span className="daily-brief__line">{deposits}</span>}
          </>
        )
      }
    />
  );
}

function SessionsFact({ brief }: { brief: BriefDto }) {
  const n = Math.max(brief.sessions_passed, brief.sessions.length);
  return (
    <Fact
      testId="brief-sessions"
      wide
      label="Sessions while away"
      value={<span className="daily-brief__figure">{n === 1 ? "1 session passed" : `${n} sessions passed`}</span>}
      note={
        <>
          {brief.sessions.map((d) => formatDayLabel(d)).join(" · ")}
          <span className="daily-brief__aside"> No totals across several sessions yet; the graph below covers them.</span>
        </>
      }
    />
  );
}

function FxReopenFact({ brief, currency }: { brief: BriefDto; currency: ReportingCurrency }) {
  const fx = brief.fx_move?.[currency] ?? null;
  return (
    <Fact
      testId="brief-fx"
      label="The currency market reopened"
      value={
        <span className="daily-brief__figure">
          <span>
            {fx?.pair ?? "EUR/USD"} {formatNumber(toNum(fx?.spot_display ?? null), 4)}
          </span>
          {fx?.pct != null && <Percent ratio={toNum(fx.pct)} signed colored />}
        </span>
      }
      note="Stocks did not trade"
    />
  );
}

const NONE = <span className="daily-brief__figure daily-brief__figure--none">–</span>;

/**
 * The currency since the last look, in the app's convention (as the Overview's currency
 * box): the EUR view shows the currency effect on the portfolio in euros, the USD view
 * the investing power of the regular euro amount in dollars. Both are server figures
 * (never converted here); a side without one shows a calm dash in the same slot, so a
 * currency switch never changes the card's shape.
 */
function CurrencySinceFact({ brief, currency }: { brief: BriefDto; currency: ReportingCurrency }) {
  const timeZone = useTimeZone();
  const title = (iso: string | undefined) => (iso ? `Since you last looked · ${sinceLabel(iso, brief.now, timeZone)}` : undefined);
  if (currency === "USD") {
    const ip = brief.investing_power_since?.USD ?? null;
    const eur = toNum(ip?.amount_eur ?? null);
    return (
      <Fact
        testId="brief-currency-effect"
        wide
        label={<span title={title(ip?.since)}>Investing power</span>}
        value={
          ip ? (
            <span className="daily-brief__figure">
              <Money amount={toNum(ip.net)} currency="USD" signed colored />
              <DeltaBadge value={toNum(ip.pct)} />
            </span>
          ) : (
            NONE
          )
        }
        note={
          ip ? (
            <>
              <span className="daily-brief__line">
                <Money amount={eur} currency="EUR" digits={eur !== null && Number.isInteger(eur) ? 0 : 2} /> →{" "}
                <Money amount={toNum(ip.amount_usd_now)} currency="USD" /> (was <Money amount={toNum(ip.amount_usd_then)} currency="USD" />)
              </span>
              <span className="daily-brief__line">
                EUR/USD {rate(ip.rate_then)} → {rate(ip.rate_now)}
              </span>
            </>
          ) : (
            "No rate on record"
          )
        }
      />
    );
  }
  const effect = brief.currency_effect_since?.EUR ?? null;
  return (
    <Fact
      testId="brief-currency-effect"
      wide
      label={<span title={title(effect?.since)}>Currency effect</span>}
      value={
        effect ? (
          <span className="daily-brief__figure">
            <Money amount={toNum(effect.amount)} currency="EUR" signed colored />
            <DeltaBadge value={toNum(effect.pct)} />
          </span>
        ) : (
          NONE
        )
      }
      note={
        effect ? (
          <>
            <span className="daily-brief__line">Dollar holdings in euros</span>
            <span className="daily-brief__line">
              EUR/USD {rate(effect.rate_then)} → {rate(effect.rate_now)}
            </span>
          </>
        ) : (
          "No rate on record"
        )
      }
    />
  );
}

/** How many movers each way the brief names (the server sends the top few). */
const MOVERS_EACH_WAY = 3;

function MoverChip({ m, up }: { m: BriefMoverDto; up: boolean }) {
  return (
    <Chip
      size="sm"
      tone={up ? "pos" : "neg"}
      icon={up ? <ArrowUpRight aria-hidden /> : <ArrowDownRight aria-hidden />}
      title={`${up ? "Up" : "Down"}: ${m.name}${m.twin ? " (ETF twin estimate)" : ""}`}
    >
      {m.symbol} {m.twin ? "≈ " : ""}
      <Percent ratio={toNum(m.pct ?? null)} signed />
    </Chip>
  );
}

/** The session's biggest movers each way, as chips (arrow + sign, never colour alone). */
function MoversFact({ movers }: { movers: BriefMoveDto["movers"] }) {
  const up = movers?.winners.slice(0, MOVERS_EACH_WAY) ?? [];
  const down = movers?.losers.slice(0, MOVERS_EACH_WAY) ?? [];
  if (up.length === 0 && down.length === 0) return null;
  return (
    <Fact
      testId="brief-movers"
      wide
      label="Biggest movers · up and down"
      value={
        <span className="daily-brief__movers">
          <span className="daily-brief__chips" data-testid="brief-movers-up">
            {up.length ? up.map((m) => <MoverChip key={m.symbol} m={m} up />) : <span className="daily-brief__key">None up</span>}
          </span>
          <span className="daily-brief__chips" data-testid="brief-movers-down">
            {down.length ? down.map((m) => <MoverChip key={m.symbol} m={m} up={false} />) : <span className="daily-brief__key">None down</span>}
          </span>
        </span>
      }
    />
  );
}

/**
 * Counts down `minutes` of time on screen (page visible, card neither hovered nor
 * focused), then calls `onDone` once. `minutes` 0 = never: no countdown at all.
 * The caller keys the card by brief, so a new brief starts a fresh count.
 */
export function useAutoClose(minutes: number, onDone: () => void) {
  const total = minutes > 0 ? minutes * 60_000 : 0;
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const done = useRef(onDone);
  const fired = useRef(false);
  useEffect(() => {
    done.current = onDone;
  }, [onDone]);

  useEffect(() => {
    if (total === 0 || paused) return;
    let last = Date.now();
    const id = window.setInterval(() => {
      const t = Date.now();
      const step = t - last;
      last = t;
      // A tab in the background does not use up the time: the brief waits to be seen.
      if (document.visibilityState === "hidden") return;
      setElapsed((e) => e + step);
    }, 1000);
    return () => window.clearInterval(id);
  }, [total, paused]);

  const remaining = Math.max(0, total - elapsed);
  useEffect(() => {
    if (total > 0 && remaining <= 0 && !fired.current) {
      fired.current = true;
      done.current();
    }
  }, [remaining, total]);

  return { remaining: total > 0 ? remaining : null, setPaused };
}

/**
 * The Daily Brief (plan §3.1): what happened since the owner last looked, above the
 * Overview stage, only when the server says one is due. One header line (the window
 * and the close), then one row of figures with hairlines between them (two columns
 * on a phone). Every figure is the server's (copied from the Overview payload of that
 * currency). Dismiss posts the acknowledgement; the card goes at once and stays gone
 * (back only if the write fails). After `brief_autoclose_minutes` on screen (default
 * 3, 0 = never; paused while pointed at or focused) it closes the same way.
 */
export function DailyBrief({ currency }: DailyBriefProps) {
  const brief = useBrief();
  const b = brief.data;
  if (!b || !b.due) return null;
  // Keyed by the window, not by `now` (which moves on every read): a refetch keeps the count.
  return <BriefCard key={`${b.last_ack_at ?? ""}|${b.kind ?? ""}`} brief={b} currency={currency} />;
}

function BriefCard({ brief: b, currency }: { brief: BriefDto; currency: ReportingCurrency }) {
  const timeZone = useTimeZone();
  const { mutate } = useAckBrief();
  const { briefAutocloseMinutes } = useDisplayPrefs();
  const dismiss = useCallback(() => mutate(b.now), [mutate, b.now]);
  const { remaining, setPaused } = useAutoClose(briefAutocloseMinutes, dismiss);
  // Pause while pointed at or focused (listeners on the region itself: it stays a
  // plain landmark, not a control).
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = card.current;
    if (!el) return;
    let hovered = false;
    let focused = false;
    const sync = () => setPaused(hovered || focused);
    const enter = () => {
      hovered = true;
      sync();
    };
    const leave = () => {
      hovered = false;
      sync();
    };
    const focusIn = () => {
      focused = true;
      sync();
    };
    const focusOut = (e: FocusEvent) => {
      if (el.contains(e.relatedTarget as Node | null)) return;
      focused = false;
      sync();
    };
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("focusin", focusIn);
    el.addEventListener("focusout", focusOut);
    return () => {
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("focusin", focusIn);
      el.removeEventListener("focusout", focusOut);
    };
  }, [setPaused]);

  const move = b.move?.[currency] ?? null;
  const kind = b.kind === "session" && move ? "session" : b.kind === "fx_reopen" ? "fx" : "sessions";
  const win = kind === "sessions" ? windowOf(b, currency) : null;
  const n = Math.max(b.sessions_passed, b.sessions.length);
  const icon = kind === "session" ? <Newspaper aria-hidden /> : kind === "fx" ? <Repeat aria-hidden /> : <CalendarRange aria-hidden />;
  // "Since" is the previous visit (the server's marker), as the currency slot's rates use it.
  const sinceIso = b.visit_from ?? b.currency_effect_since?.EUR?.since ?? b.investing_power_since?.USD?.since ?? null;
  const since = sinceIso ? sinceLabel(sinceIso, b.now, timeZone) : null;
  const span = kind === "fx" ? "weekend" : n === 1 ? "1 session" : `${n} sessions`;
  // One slot for the currency since the last look, shown when the server sends either side.
  const showCurrency = Boolean(b.currency_effect_since?.EUR || b.investing_power_since?.USD);

  return (
    <section ref={card} className="daily-brief u-enter" aria-label="Daily brief">
      <header className="daily-brief__head">
        <span className="daily-brief__icon">{icon}</span>
        <h2 className="daily-brief__title">Daily brief</h2>
        <p className="daily-brief__window" data-testid="brief-window">
          {since ? `Since you last looked · ${since}` : "Since you last looked"} · {span}
        </p>
        {remaining !== null && (
          <span className="daily-brief__timer" data-testid="brief-timer" title="Pauses while you point at or focus the brief">
            closes in {formatRemaining(remaining)}
          </span>
        )}
        <IconButton className="daily-brief__dismiss" label="Dismiss the brief" size="sm" icon={<X aria-hidden />} onClick={dismiss} />
      </header>
      <dl className="daily-brief__facts">
        {kind === "session" && move && <SessionFact move={move} currency={currency} />}
        {kind === "sessions" && win && <WindowFact brief={b} w={win} currency={currency} />}
        {kind === "sessions" && !win && <SessionsFact brief={b} />}
        {kind === "fx" && <FxReopenFact brief={b} currency={currency} />}
        {showCurrency && <CurrencySinceFact brief={b} currency={currency} />}
        {kind === "session" && move && <MoversFact movers={move.movers} />}
        {win && <MoversFact movers={win.movers} />}
      </dl>
    </section>
  );
}
