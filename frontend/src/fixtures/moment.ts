/**
 * `?at=<moment>` for the fixture build: puts the whole app at one market moment.
 *
 * Two halves. The pure half derives, from an instant, where the US session and the
 * FX week stand (bells, freshness stamps, what the 1D graph and the day figures show).
 * The patch half rewrites the recorded answers (`overview`, `graphs/1d`, `holdings`,
 * `refresh/status`) so every figure tells that one story: hero value = the chart's
 * last point = the High tile = prev close + day move. Fixture builds only.
 *
 * Simplifications: no exchange holidays or half days; the recorded day is extended
 * to a full 09:30-16:00 New York session by a smooth, rising continuation.
 */

type Obj = Record<string, unknown>;

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const STEP = 5 * MIN;
const KNOTS = 79; // 09:30 .. 16:00 every five minutes

/** The moments with a name; anything else must be an ISO instant. */
export const MOMENTS = ["preopen", "opening", "firsttick", "preclose", "closing", "closed", "fxfri", "fxsun"] as const;
export type MomentName = (typeof MOMENTS)[number];

// ---- calendar (New York) -------------------------------------------------------------

const dayOf = (ms: number): number => Math.floor(ms / DAY);
const weekday = (day: number): number => (((day + 4) % 7) + 7) % 7; // 0 = Sunday
const isoDay = (day: number): string => new Date(day * DAY).toISOString().slice(0, 10);
const isoAt = (ms: number): string => new Date(ms).toISOString().slice(0, 19) + "+00:00";

/** First Sunday on or after the 1st of a month (0-based), as a day number. */
function firstSunday(year: number, month: number, nth = 1): number {
  const first = dayOf(Date.UTC(year, month, 1));
  return first + ((7 - weekday(first)) % 7) + (nth - 1) * 7;
}

/** New York's UTC offset in hours on a New York calendar day (US rule: 2nd Sun Mar - 1st Sun Nov). */
export function nyOffset(day: number): number {
  const year = new Date(day * DAY).getUTCFullYear();
  return day >= firstSunday(year, 2, 2) && day < firstSunday(year, 10) ? -4 : -5;
}

/** The UTC instant of a New York wall-clock time on a calendar day. */
export function nyTime(day: number, hour: number, minute = 0): number {
  return day * DAY + (hour - nyOffset(day)) * HOUR + minute * MIN;
}

/** The New York calendar day an instant falls on. */
export function nyDay(at: number): number {
  const guess = nyOffset(dayOf(at));
  return dayOf(at + guess * HOUR);
}

const isTrading = (day: number): boolean => weekday(day) >= 1 && weekday(day) <= 5;
const openOf = (day: number): number => nyTime(day, 9, 30);
const closeOf = (day: number): number => nyTime(day, 16);

function prevTrading(from: number): number {
  let d = from;
  while (!isTrading(d)) d -= 1;
  return d;
}
function nextTrading(from: number): number {
  let d = from;
  while (!isTrading(d)) d += 1;
  return d;
}

// ---- the moment ---------------------------------------------------------------------------

/** The Tuesday the fixtures were recorded on, moved to the browser's week (`weeks` whole weeks). */
export function namedInstant(name: MomentName, tuesday: number): number {
  const open = openOf(tuesday);
  const close = closeOf(tuesday);
  switch (name) {
    case "preopen":
      return open - 10 * MIN;
    case "opening":
      return open + 40_000;
    case "firsttick":
      return open + 2 * MIN + 10_000;
    case "preclose":
      return close - 2 * MIN;
    case "closing":
      return close + 40_000;
    case "closed":
      return close + 4 * MIN;
    case "fxfri":
      return nyTime(tuesday + 3, 17, 5); // Friday, five minutes after the FX close
    case "fxsun":
      return nyTime(tuesday + 5, 17, 20); // Sunday, twenty minutes after the FX reopen
  }
}

/**
 * The instant a switch value stands for: a moment name (relative to `tuesday`, the
 * fixture anchor day in the browser's week) or an ISO instant. null for anything else.
 */
export function parseMoment(spec: string | null | undefined, tuesday: number): number | null {
  if (!spec) return null;
  const named = (MOMENTS as readonly string[]).includes(spec) ? namedInstant(spec as MomentName, tuesday) : null;
  if (named !== null) return named;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(spec)) return null;
  const t = Date.parse(spec);
  return Number.isNaN(t) ? null : t;
}

/** How far the browser clock must run ahead of (or behind) the real one to read `target`. */
export const clockOffset = (target: number, realNow: number): number => target - realNow;

/** Replaces `Date` (and `Date.now`) so "now" reads real time plus `offset`; the clock keeps running. */
export function installClock(offset: number): void {
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...(args as [number]));
    }
    static now(): number {
      return RealDate.now() + offset;
    }
  }
  (window as unknown as { Date: DateConstructor }).Date = FakeDate as unknown as DateConstructor;
}

export interface Moment {
  at: number;
  /** New York calendar day of the instant. */
  today: number;
  isOpen: boolean;
  /** Bell rang, the server is still settling the close (payload still says open). */
  closingWindow: boolean;
  /** Open, no price yet. */
  opening: boolean;
  /** A trading day, before its open. */
  preopen: boolean;
  payloadOpen: boolean;
  /** Prices stream. */
  live: boolean;
  /** The day the payload's day figures belong to. */
  dataDay: number;
  /** The day the 1D graph shows. */
  graphDay: number;
  fresh: {
    market_state: "open" | "closed";
    last_close_at: string;
    next_open_at: string;
    next_close_at: string;
    session_opened_at: string | null;
    prices_live: boolean;
    last_price_update_at: string;
    price_market_at: string;
    price_observed_at: string;
  };
  fxFrozen: boolean;
  fxReopenAt: string | null;
  fxObservedAt: string;
  /** The graph's last instant (null: the whole session, or none yet when `opening`). */
  upto: number | null;
}

export function marketAt(at: number): Moment {
  const today = nyDay(at);
  const trading = isTrading(today);
  const open = openOf(today);
  const close = closeOf(today);
  const isOpen = trading && at >= open && at < close;
  const closingWindow = trading && at >= close && at < close + 3 * MIN;
  const opening = isOpen && at < open + 2 * MIN;
  const preopen = trading && at < open;
  const payloadOpen = isOpen || closingWindow;
  const live = isOpen && !opening;

  const lastCloseDay = prevTrading(trading && at >= close ? today : today - 1);
  const nextOpenDay = nextTrading(trading && at < open ? today : today + 1);
  const dataDay = payloadOpen && !opening ? today : lastCloseDay;
  const graphDay = opening ? today : dataDay;

  // FX week: shut from Friday 17:00 to Sunday 17:00 New York time.
  const w = weekday(today);
  const hh = (at - nyTime(today, 0)) / HOUR;
  const fxFrozen = (w === 5 && hh >= 17) || w === 6 || (w === 0 && hh < 17);
  const friday = today - ((w - 5 + 7) % 7);
  const fxClose = nyTime(friday, 17);

  const lastClose = closeOf(lastCloseDay);
  let update: number;
  let market: number;
  if (live) {
    update = at - 10_000;
    market = at - 20_000;
  } else if (closingWindow) {
    update = close - 5_000;
    market = close - 10_000;
  } else {
    market = lastClose;
    update = fxFrozen ? fxClose + 30_000 : preopen || opening ? lastClose + 150_000 : Math.max(lastClose + 150_000, at - 5 * MIN);
  }
  const upto = live ? update : closingWindow ? update : opening ? null : null;
  return {
    at,
    today,
    isOpen,
    closingWindow,
    opening,
    preopen,
    payloadOpen,
    live,
    dataDay,
    graphDay,
    fresh: {
      market_state: payloadOpen ? "open" : "closed",
      last_close_at: isoAt(payloadOpen ? closeOf(prevTrading(today - 1)) : lastClose),
      next_open_at: isoAt(openOf(payloadOpen ? nextTrading(today + 1) : nextOpenDay)),
      next_close_at: isoAt(closeOf(payloadOpen ? today : nextOpenDay)),
      session_opened_at: payloadOpen ? isoAt(open) : null,
      prices_live: live,
      last_price_update_at: isoAt(update),
      price_market_at: isoAt(market),
      price_observed_at: isoAt(update),
    },
    fxFrozen,
    fxReopenAt: fxFrozen ? isoAt(nyTime(friday + 2, 17)) : null,
    fxObservedAt: isoAt(fxFrozen ? fxClose : at - 20_000),
    upto,
  };
}

/** The `market_session` events the stream would have delivered to a tab opened at this moment. */
export function sessionEvents(m: Moment): Obj[] {
  const closeIso = isoAt(closeOf(m.today));
  if (m.opening) return [{ type: "market_session", state: "opening", at: isoAt(openOf(m.today)), next_bell: closeIso }];
  if (m.closingWindow) return [{ type: "market_session", state: "closing", at: closeIso, next_bell: m.fresh.next_open_at }];
  if (!m.payloadOpen && isTrading(m.today) && m.at >= closeOf(m.today) && m.at - closeOf(m.today) < 60 * MIN) {
    return [{ type: "market_session", state: "closed", at: closeIso, next_bell: m.fresh.next_open_at }];
  }
  return [];
}

// ---- the day's curve ---------------------------------------------------------------------

/** The recorded part of the day, continued to the close with a smooth, rising walk (new highs, so the end is the High). */
export function extendCurve(recorded: number[]): number[] {
  const have = recorded.slice(0, KNOTS);
  const last = have[have.length - 1];
  const rest = KNOTS - have.length;
  for (let j = 1; j <= rest; j++) have.push(last * (1 + 0.0011 * (j / rest) + 0.00002 * Math.sin(1.1 * j)));
  return have;
}

interface Point {
  t: number;
  v: number;
}

export interface Frame {
  ref: number;
  points: Point[];
  tip: number;
  day: number;
}

function valueAt(curve: number[], open: number, t: number): number {
  const x = Math.min(KNOTS - 1, Math.max(0, (t - open) / STEP));
  const i = Math.floor(x);
  const a = curve[i];
  const b = curve[Math.min(i + 1, curve.length - 1)];
  return a + (b - a) * (x - i);
}

/**
 * One currency's frame on `day`: the points the graph draws and the reference (prev close).
 * `scaleToRef` rescales the day so it ends exactly at the recorded reference (the session
 * before the recorded one: its close is the recorded day's prev close).
 */
export function frameFor(recorded: number[], ref: number, day: number, upto: number | null, scaleToRef: boolean): Frame {
  const curve = extendCurve(recorded);
  const k = scaleToRef ? ref / curve[curve.length - 1] : 1;
  const scaled = curve.map((v) => v * k);
  const open = openOf(day);
  const cut = upto ?? closeOf(day);
  const points: Point[] = [];
  for (let i = 0; i < scaled.length && open + i * STEP <= cut; i++) points.push({ t: open + i * STEP, v: scaled[i] });
  if (points.length < 2 || points[points.length - 1].t < cut) {
    // The first ticks sit between knots: never below the open's value, so the High is the last price.
    const floor = points.length < 2 ? points[0].v : -Infinity;
    points.push({ t: cut, v: Math.max(floor, valueAt(scaled, open, cut)) });
  }
  return { ref: ref * k, points, tip: points[points.length - 1].v, day };
}

/** The 1D graph frame and the day-figures frame of one currency at a moment. */
export function framesAt(m: Moment, recorded: number[], ref: number): { graph: Frame; day: Frame } {
  const scaleToRef = m.preopen;
  if (m.opening) {
    // Today has no price yet: a flat stub at the prev close; the day figures are the last session's.
    const open = openOf(m.graphDay);
    const stub: Frame = { ref, points: [{ t: open, v: ref }, { t: Math.min(m.at, closeOf(m.graphDay)), v: ref }], tip: ref, day: m.graphDay };
    return { graph: stub, day: frameFor(recorded, ref, m.dataDay, null, true) };
  }
  const f = frameFor(recorded, ref, m.graphDay, m.upto, scaleToRef);
  return { graph: f, day: f };
}

// ---- patching the recorded answers ----------------------------------------------------------

const num = (v: unknown): number => Number(v);
const money = (n: number): string => n.toFixed(8);
const frac = (n: number): string => n.toFixed(10);
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const SIDES = ["EUR", "USD"] as const;
type Side = (typeof SIDES)[number];
const other = (c: Side): Side => (c === "EUR" ? "USD" : "EUR");

interface Moved {
  /** Day frames of both currencies (own and secondary). */
  day: Record<Side, Frame>;
  graph: Record<Side, Frame>;
}

function movedFrom(m: Moment, data: Obj): Moved | null {
  const both = data["GET /api/graphs/1d/both"];
  if (!isObj(both)) return null;
  const out: Partial<Moved> = { day: {} as Record<Side, Frame>, graph: {} as Record<Side, Frame> };
  for (const c of SIDES) {
    const g = both[c];
    if (!isObj(g) || !Array.isArray(g.points) || g.points.length < 2) return null;
    const recorded = (g.points as Obj[]).map((p) => num(p.v));
    const f = framesAt(m, recorded, num(g.reference));
    out.day![c] = f.day;
    out.graph![c] = f.graph;
  }
  return out as Moved;
}

const pctOf = (move: number, ref: number): number => (ref ? move / ref : 0);

/** Rewrites one KPI block (own or secondary currency) around the frame's tip; returns the move factor. */
function patchKpis(k: Obj, frame: Frame, dataDay: number): { factor: number; total: number; oldTotal: number } {
  const est = isObj(k.estimate) ? k.estimate : null;
  const oldTotal = num(k.total_value);
  const oldMove = num(est ? est.daily_move : k.daily_move);
  const adj = est ? num(est.adjustment) : 0;
  const total = frame.tip - adj;
  const move = total - frame.ref;
  if (est) {
    est.total_value = money(frame.tip);
    est.daily_move = money(frame.tip - frame.ref);
    est.daily_growth_pct = frac(pctOf(frame.tip - frame.ref, frame.ref));
  }
  k.total_value = money(total);
  k.daily_move = money(move);
  k.daily_growth_pct = frac(pctOf(move, frame.ref));
  k.daily_growth_as_of = isoDay(dataDay);
  for (const key of ["capital_gain", "total_return"]) if (k[key] != null) k[key] = money(num(k[key]) + (total - oldTotal));
  const newMove = est ? frame.tip - frame.ref : move;
  return { factor: oldMove ? newMove / oldMove : 0, total, oldTotal };
}

function scaleMovers(movers: unknown, factor: number, dataDay: number): void {
  if (!isObj(movers)) return;
  movers.basis_date = isoDay(dataDay);
  for (const list of [movers.winners, movers.losers]) {
    if (!Array.isArray(list)) continue;
    for (const r of list as Obj[]) {
      if (r.move != null) r.move = (num(r.move) * factor).toFixed(2);
      if (r.pct != null) r.pct = frac(num(r.pct) * factor);
    }
  }
}

function patchOverview(body: Obj, m: Moment, mv: Moved): void {
  for (const c of SIDES) {
    const o = body[c];
    if (!isObj(o) || !isObj(o.kpis)) continue;
    const own = patchKpis(o.kpis, mv.day[c], m.dataDay);
    const sec = isObj(o.kpis_secondary) ? patchKpis(o.kpis_secondary, mv.day[other(c)], m.dataDay) : null;
    o.freshness = { ...(isObj(o.freshness) ? o.freshness : {}), ...m.fresh, feed_stalled_since: null, historical: false };
    o.daily_caption = { ...(isObj(o.daily_caption) ? o.daily_caption : {}), live: m.live, title: m.dataDay === m.today ? "Today" : "Last session" };
    o.is_live = m.live;
    o.as_of = isoDay(m.dataDay);
    scaleMovers(o.movers, own.factor, m.dataDay);
    const day = mv.day[c];
    const split = o.day_split;
    if (isObj(split)) {
      split.price_move = money(day.tip - day.ref);
      if (sec) split.price_move_secondary = money(mv.day[other(c)].tip - mv.day[other(c)].ref);
      if (split.currency_move != null) split.currency_move = money(num(split.currency_move) * own.factor);
    }
    const last = o.last_session;
    if (isObj(last)) {
      const dayMove = day.tip - day.ref;
      const overnight = last.overnight_currency == null ? 0 : num(last.overnight_currency);
      last.day_move = money(dayMove);
      last.day_move_pct = frac(pctOf(dayMove, day.ref));
      last.move = money(dayMove - overnight);
      last.move_pct = frac(pctOf(dayMove - overnight, day.ref));
      last.value_now = money(day.tip);
      last.session_date = isoDay(m.dataDay);
      last.prev_date = isoDay(prevTrading(m.dataDay - 1));
      last.market_open = m.payloadOpen;
    }
    const t = isObj(o.currency) && isObj(o.currency.today) ? o.currency.today : null;
    if (t) {
      const regime = isObj(t.regime) ? t.regime : {};
      t.regime = { ...regime, forex_frozen: m.fxFrozen, forex_open: !m.fxFrozen, market_open: m.isOpen, session_view: m.isOpen };
      t.reopen_at = m.fxReopenAt;
      t.spot_observed_at = m.fxObservedAt.slice(0, 19);
      t.as_of = { ...(isObj(t.as_of) ? t.as_of : {}), observed_at: m.fxObservedAt.slice(0, 19), source: "live", as_of: m.fxObservedAt.slice(0, 10) };
    }
  }
}

function patchGraph(body: Obj, m: Moment, mv: Moved): void {
  for (const c of SIDES) {
    const g = body[c];
    if (!isObj(g) || !Array.isArray(g.points)) continue;
    const f = mv.graph[c];
    const o = mv.graph[other(c)];
    const iso = (t: number) => isoAt(t);
    g.points = f.points.map((p) => ({ t: iso(p.t), v: money(p.v) }));
    g.reference = money(f.ref);
    g.session_date = isoDay(f.day);
    g.as_of = isoDay(f.day);
    g.market_open = m.payloadOpen;
    g.sessions = [{ date: isoDay(f.day), open: isoAt(openOf(f.day)), close: isoAt(closeOf(f.day)) }];
    const move = f.tip - f.ref;
    g.direction = move > 0 ? "up" : move < 0 ? "down" : "flat";
    g.growth = { ...(isObj(g.growth) ? g.growth : { mode: "reference" }), pct: frac(pctOf(move, f.ref)) };
    if (isObj(g.secondary)) {
      g.secondary = {
        ...g.secondary,
        anchor_t: iso(f.points[0].t),
        points: o.points.map((p) => ({ t: iso(p.t), v: money(p.v) })),
        growth: { ...(isObj(g.secondary.growth) ? g.secondary.growth : { mode: "reference" }), pct: frac(pctOf(o.tip - o.ref, o.ref)) },
      };
    }
  }
}

function patchHoldings(body: Obj, m: Moment, mv: Moved, data: Obj): void {
  const ov = data["GET /api/overview/both"];
  for (const c of SIDES) {
    const h = body[c];
    if (!isObj(h) || !Array.isArray(h.holdings)) continue;
    const k = isObj(ov) && isObj(ov[c]) ? (ov[c] as Obj).kpis : null;
    const frame = mv.day[c];
    // Same arithmetic as the overview: the book at the day's tip, less the fund estimate.
    const est = isObj(k) && isObj(k.estimate) ? k.estimate : null;
    const adj = est ? num(est.adjustment) : 0;
    const oldTotal = num(h.total_value);
    const total = frame.tip - adj;
    const oldMove = isObj(k) ? num(est ? est.daily_move : k.daily_move) : 0;
    const factor = oldMove ? (frame.tip - frame.ref) / oldMove : 0;
    const g = oldTotal ? total / oldTotal : 1;
    h.total_value = money(total);
    for (const key of ["total_return", "total_capital_gain", "total_unrealised_gain"]) if (h[key] != null) h[key] = money(num(h[key]) + (total - oldTotal));
    if (isObj(h.fx) && h.fx.observed_at) h.fx.observed_at = m.fxObservedAt.slice(0, 19);
    for (const r of h.holdings as Obj[]) {
      r.market_open = m.payloadOpen;
      r.daily_growth_as_of = isoDay(m.dataDay);
      if (r.value != null) r.value = (num(r.value) * g).toFixed(2);
      for (const key of ["today_move", "day_session"]) if (r[key] != null) r[key] = (num(r[key]) * factor).toFixed(2);
      for (const key of ["today_pct", "day_session_pct"]) if (r[key] != null) r[key] = frac(num(r[key]) * factor);
      if (r.price_type !== "nav" && !r.is_money_market && r.asset_class !== "mutual_fund") {
        if (r.price_native != null) r.price_native = (num(r.price_native) * g).toFixed(6);
        r.updated_at = m.fresh.last_price_update_at.slice(0, 19);
        r.price_market_at = m.fresh.price_market_at.slice(0, 19);
        r.price_as_of = m.fresh.price_market_at.slice(0, 10);
      }
    }
  }
}

/**
 * The recorded `body` of a GET answer, already shifted to the browser's week, made to
 * agree with the moment. Other paths pass through unchanged.
 */
export function patchForMoment(path: string, body: unknown, m: Moment, data: Obj): unknown {
  if (!isObj(body)) return body;
  if (path === "/api/refresh/status") return { ...body, last_update_at: m.fresh.last_price_update_at.replace("+00:00", "Z") };
  const handled = path === "/api/overview/both" || path === "/api/graphs/1d/both" || path === "/api/holdings/both";
  if (!handled) return body;
  const mv = movedFrom(m, data);
  if (!mv) return body;
  if (path === "/api/overview/both") patchOverview(body, m, mv);
  else if (path === "/api/graphs/1d/both") patchGraph(body, m, mv);
  else patchHoldings(body, m, mv, data);
  return body;
}
