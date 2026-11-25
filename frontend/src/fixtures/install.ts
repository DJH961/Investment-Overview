/**
 * Fixture mode (`VITE_FIXTURES=1`): the real app with no backend and no login.
 *
 * `main.tsx` imports this dynamically behind the build flag, so a normal build
 * contains neither this file nor the JSON. It replaces `fetch` for `/api/*`
 * with answers recorded by `backend/.../tools/make_fixtures.py`, and
 * `EventSource` with a stream that opens and then stays quiet.
 *
 * Data set: `?fixtures=empty` (remembered for the tab) selects the empty ledger,
 * anything else the full, deliberately nasty one.
 *
 * Daily Brief switch (remembered for the tab): `?brief=sessions` (the recorded
 * multi-session window, the default), `?brief=session` (one session, figures copied
 * from the overview fixture the way the server does), `?brief=fx` (the weekend
 * currency line) or `?brief=off` (not due). Dismissing the card acknowledges it for
 * the tab, as the server would; any `?brief=` brings it back.
 *
 * View switches (remembered for the tab): `?ccy=EUR|USD`, `?theme=light|dark|auto`,
 * `?rail=1|0` (sidebar folded or open), e.g. `/currency?ccy=USD&theme=dark&rail=1`.
 *
 * Market moment (remembered for the tab): `?at=<moment>` puts the whole app at one
 * moment: the browser clock (Date) reads that instant (and keeps running), and the
 * freshness, market regime, daily caption, 1D graph, day figures, holdings stamps,
 * refresh status and `market_session` bells all agree with it (see ./moment.ts).
 * Moments: `preopen` (10 min before the open), `opening` (open, no prices yet),
 * `firsttick`, `preclose` (2 min before the close), `closing` (bell rang, close being
 * settled), `closed`, `fxfri` (Friday after the FX close), `fxsun` (Sunday after the
 * FX reopen), or an ISO instant such as `2026-11-24T20:58:00Z`. Named moments fall on
 * the recorded Tuesday of the browser's week, so weekdays line up. `?at=live` clears it.
 */

import { currencyDollarFixture, currencyScenariosFixture } from "./currencyDollar";
import { currencyEffectFixture, effectScale } from "./currencyEffect";
import { clockOffset, installClock, marketAt, parseMoment, patchForMoment, sessionEvents, nyDay, type Moment } from "./moment";
import { rateHistoryFixture } from "./rateHistory";
import { journeyAnswer, journeyExtend } from "./journey";
import { v71Answer, v71Extend } from "./v71";

type Fixtures = Record<string, unknown>;

/** The day the fixtures were recorded; every date is shifted to the browser's today. */
const ANCHOR = "2026-06-30";
const VERSION_SENTINEL = "fixtures-version";
const STORAGE_KEY = "iv.fixtures";
const BRIEF_KEY = "iv.fixtures.brief";
type BriefMode = "sessions" | "session" | "fx" | "off";

declare const __APP_VERSION__: string;

function pickDataset(): "full" | "empty" | "nice" {
  try {
    const asked = new URLSearchParams(window.location.search).get("fixtures");
    if (asked === "empty" || asked === "full" || asked === "nice") window.sessionStorage.setItem(STORAGE_KEY, asked);
    const kept = window.sessionStorage.getItem(STORAGE_KEY);
    return kept === "empty" || kept === "nice" ? kept : "full";
  } catch {
    return "full";
  }
}

const AT_KEY = "iv.fixtures.at";

/** The `?at=` switch, remembered for the tab; `?at=live` clears it. Returns the stored spec or null. */
function pickAt(): string | null {
  try {
    const asked = new URLSearchParams(window.location.search).get("at");
    if (asked === "live") window.sessionStorage.removeItem(AT_KEY);
    else if (asked) window.sessionStorage.setItem(AT_KEY, asked);
    return window.sessionStorage.getItem(AT_KEY);
  } catch {
    return null;
  }
}

function pickBrief(): BriefMode {
  try {
    const asked = new URLSearchParams(window.location.search).get("brief");
    if (asked === "sessions" || asked === "session" || asked === "fx" || asked === "off") {
      window.sessionStorage.setItem(BRIEF_KEY, asked);
    }
    const kept = window.sessionStorage.getItem(BRIEF_KEY);
    return kept === "session" || kept === "fx" || kept === "off" ? kept : "sessions";
  } catch {
    return "sessions";
  }
}

/**
 * View switches for screenshots and reviews (remembered for the tab, like `?brief=`):
 * `?ccy=EUR|USD` reporting currency, `?theme=light|dark|auto`, `?rail=1|0` sidebar
 * folded or open. They seed the app's own preferences before it renders and make the
 * fixture settings answer with them, so the server value does not switch them back.
 * In-app toggles keep working and update the remembered choice.
 */
type View = { ccy?: "EUR" | "USD"; theme?: "light" | "dark" | "auto"; rail?: boolean };
const VIEW_KEY = "iv.fixtures.view";

function readView(): View {
  try {
    return JSON.parse(window.sessionStorage.getItem(VIEW_KEY) ?? "{}") as View;
  } catch {
    return {};
  }
}

function saveView(view: View): void {
  try {
    window.sessionStorage.setItem(VIEW_KEY, JSON.stringify(view));
    if (view.ccy) window.localStorage.setItem("iv.ccy", view.ccy);
    if (view.theme === "auto") window.localStorage.removeItem("iv.theme");
    else if (view.theme) window.localStorage.setItem("iv.theme", view.theme);
    if (view.rail !== undefined) window.localStorage.setItem("iv.sidebar.rail", view.rail ? "1" : "0");
  } catch {
    /* private mode: the switch lasts for this page only */
  }
}

function pickView(): View {
  const view = readView();
  try {
    const q = new URLSearchParams(window.location.search);
    const ccy = q.get("ccy")?.toUpperCase();
    if (ccy === "EUR" || ccy === "USD") view.ccy = ccy;
    const theme = q.get("theme");
    if (theme === "light" || theme === "dark") view.theme = theme;
    if (theme === "auto" || theme === "system") view.theme = "auto";
    const rail = q.get("rail");
    if (rail === "1" || rail === "0") view.rail = rail === "1";
  } catch {
    /* no URL switches */
  }
  saveView(view);
  return view;
}

/** The recorded `GET /api/settings/values` answer (`{ values: {...} }`) with the view switches applied. */
function withView(body: unknown, view: View): unknown {
  const values = field(body, "values");
  if (!values || typeof values !== "object") return body;
  return { ...(body as Record<string, unknown>), values: viewValues(values, view) };
}

function viewValues(values: unknown, view: View): Record<string, unknown> {
  const out = { ...(values as Record<string, unknown>) };
  const set = (key: string, value: string) => {
    const cur = out[key];
    out[key] = cur && typeof cur === "object" ? { ...(cur as object), value } : { value };
  };
  if (view.ccy) set("display_currency", view.ccy);
  if (view.theme) set("theme", view.theme);
  return out;
}

type Obj = Record<string, unknown>;
const field = (o: unknown, k: string): unknown => (o && typeof o === "object" ? (o as Obj)[k] : undefined);

/**
 * The currency since the last look (7.0 contract), added until the recorder writes
 * it: the euro rose 1.0712 → 1.0765, so the dollar holdings lost a little in euros
 * (EUR view) and the regular €1,000 buys $5.30 more (USD view, investing power).
 * A recorded value always wins.
 */
function withCurrencyEffect(base: Obj): Obj {
  if (!base.due || "currency_effect_since" in base || "investing_power_since" in base) return base;
  const first = (base.boundaries as { at?: string }[] | undefined)?.[0]?.at;
  const since = typeof base.last_ack_at === "string" ? base.last_ack_at : (first ?? null);
  if (!since) return base;
  const rates = { rate_then: "1.0712", rate_now: "1.0765", since };
  return {
    ...base,
    currency_effect_since: { EUR: { amount: "-1187.42", pct: "-0.0049", ...rates }, USD: null },
    investing_power_since: {
      EUR: null,
      USD: {
        amount_eur: "1000",
        amount_usd_now: "1076.50",
        amount_usd_then: "1071.20",
        net: "5.30",
        pct: "0.004948",
        ...rates,
      },
    },
  };
}

/** The recorded Brief, reshaped to the chosen kind with figures copied from the overview (as the server does). */
function briefFor(mode: BriefMode, data: Fixtures, recorded: unknown): unknown {
  const base = withCurrencyEffect((recorded ?? {}) as Obj);
  if (mode === "off") return { ...base, due: false, kind: null, events: [], events_total: 0 };
  if (mode === "sessions") {
    // The recorded window is one session: widen it to three for this mode.
    const last = (base.sessions as string[] | undefined)?.at(-1) ?? ANCHOR;
    const day = dayNumber(last);
    const iso = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);
    return { ...base, kind: "sessions", sessions: [iso(day - 4), iso(day - 1), last] /* Fri, Mon, Tue of the recorded week */, sessions_passed: 3, move: null, visit_from: `${iso(day - 5)}T21:00:00+00:00` };
  }
  const both = data["GET /api/overview/both"];
  const sides = ["EUR", "USD"] as const;
  if (mode === "session") {
    const move = Object.fromEntries(
      sides.map((c) => {
        const o = field(both, c);
        const k = field(o, "kpis");
        const split = field(o, "day_split");
        // As the server does: the headline is the hero's (the split's Total, the estimate
        // while estimating); Market = Total - Currency (euro view, market open), the
        // dollar view has no currency leg.
        const estimated = Boolean(field(split, "estimated"));
        const est = estimated ? field(k, "estimate") : undefined;
        const total = Number(field(split, "price_move") ?? field(k, "daily_move"));
        const fx = c === "EUR" && field(split, "currency_move") != null ? Number(field(split, "currency_move")) : null;
        const overnight = Boolean(field(split, "overnight"));
        const market = fx !== null && !overnight ? total - fx : total;
        return [
          c,
          {
            session_date: field(k, "daily_growth_as_of") ?? (base.sessions as string[] | undefined)?.at(-1),
            day_move: String(total),
            day_move_pct: est ? field(est, "daily_growth_pct") : field(k, "daily_growth_pct"),
            price_move: String(market),
            currency_move: fx === null ? null : String(fx),
            currency_overnight: overnight,
            estimated,
            movers: field(o, "movers"),
          },
        ];
      }),
    );
    const sessions = (base.sessions as string[] | undefined)?.slice(-1) ?? [];
    // Away since the evening before that session (the recorded absence spans three).
    const day = dayNumber(sessions[0] ?? ANCHOR);
    const visitFrom = `${new Date((day - 1) * 86_400_000).toISOString().slice(0, 10)}T21:00:00+00:00`;
    // The recorded currency effect spans the three-session absence; for one session away
    // it is the session's own currency part (the same window, give or take an hour).
    const recordedFx = (base.currency_effect_since as { EUR?: Obj | null } | null | undefined)?.EUR ?? null;
    const eurMove = (move as Record<string, Obj>).EUR;
    const fxAmount = eurMove?.currency_move as string | null | undefined;
    const eurKpis = field(field(both, "EUR"), "kpis");
    const endBook = Number(field(field(eurKpis, "estimate"), "total_value") ?? field(eurKpis, "total_value"));
    const startBook = endBook - Number(eurMove?.day_move ?? 0);
    const fxPct = fxAmount && startBook > 0 ? String(Number(fxAmount) / startBook) : recordedFx?.pct;
    const currencyEffect =
      recordedFx && fxAmount ? { EUR: { ...recordedFx, amount: fxAmount, pct: fxPct, since: visitFrom }, USD: null } : base.currency_effect_since;
    return {
      ...base,
      kind: "session",
      sessions,
      sessions_passed: 1,
      move,
      visit_from: visitFrom,
      window_move: null,
      currency_effect_since: currencyEffect,
    };
  }
  const fx = Object.fromEntries(
    sides.map((c) => {
      const today = field(field(field(both, c), "currency"), "today");
      const move = field(today, "move");
      return [
        c,
        { pair: field(today, "pair"), spot_display: field(today, "spot_display"), pct: field(move, "pct"), anchor_kind: field(move, "anchor_kind") },
      ];
    }),
  );
  return { ...base, kind: "fx_reopen", sessions: [], sessions_passed: 0, boundaries: [], events: [], events_total: 0, fx_move: fx };
}

/**
 * The 7.2 strip tiles (`effect_this_year`, `effect_lifetime`, `dollar_trend`), added to the
 * recorded `/api/currency/both` until the recorder writes them: the figures of the effect
 * fixture's YTD and All ranges, so the strip and Impact agree. A recorded tile always wins.
 */
function withStripTiles(body: unknown, data: Fixtures): unknown {
  if (!body || typeof body !== "object") return body;
  const both = body as Record<"EUR" | "USD", Obj>;
  if ((both.EUR?.stats as Obj[] | undefined)?.some((s) => s.key === "effect_this_year")) return body;
  const fx = fixtureBook(data);
  const ytd = currencyEffectFixture("ytd", { now: fx.now, scale: fx.scale, data }) as Record<"EUR" | "USD", Obj>;
  const all = currencyEffectFixture("all", { now: fx.now, scale: fx.scale, data }) as Record<"EUR" | "USD", Obj>;
  const tile = (key: string, side: Obj, c: "EUR" | "USD") => {
    const h = side.headline as Obj;
    return { key, value: h.effect, unit: "money", currency: c, secondary: h.effect_pp, secondary_unit: "fraction", secondary_currency: null, kind: h.kind };
  };
  const out: Record<string, Obj> = {};
  for (const c of ["EUR", "USD"] as const) {
    const stats = [...((both[c]?.stats as Obj[] | undefined) ?? [])];
    const at = Math.max(0, stats.findIndex((s) => s.key === "effect_today") + 1);
    stats.splice(at, 0, tile("effect_this_year", ytd[c], c), tile("effect_lifetime", all[c], c));
    stats.push({ key: "dollar_trend", value: "-0.0420", unit: "fraction", currency: null, kind: null, direction: "dollar_down", normal: "normal", since: null });
    out[c] = { ...both[c], stats };
  }
  return out;
}

/** The synthetic book's anchors: today's rate, your average rate, and the scale that ends it at the recorded total. */
function fixtureBook(data: Fixtures): { now: number; avg: number; scale: number } {
  const life = ((data["GET /api/currency/both"] as Obj | undefined)?.EUR as Obj | undefined)?.lifetime as Obj | undefined;
  const now = Number(life?.current_rate ?? 1.16);
  const total = Number(((data["GET /api/overview/both"] as Obj | undefined)?.EUR as { kpis?: Obj } | undefined)?.kpis?.total_value ?? 0);
  return { now, avg: Number(life?.avg_invest_rate ?? 1.09), scale: effectScale(now, total) };
}

function dayNumber(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

/** New York's UTC offset in hours on a calendar day (−4 in summer, −5 in winter). */
function newYorkOffset(day: number): number {
  const noon = new Date(day * 86_400_000 + 12 * 3_600_000);
  const name = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" })
    .formatToParts(noon)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = /GMT([+-]\d+)/.exec(name ?? "");
  return m ? Number(m[1]) : -5;
}

/**
 * Moves every date to today and every instant by the same days PLUS New York's DST
 * difference, so recorded market hours (an EDT June day) stay at 09:30–16:00 New York
 * time on a winter day too (the clock, the 1D graph and the brief boundaries line up).
 */
function shiftDates(text: string, days: number): string {
  if (days === 0) return text;
  const anchor = dayNumber(ANCHOR);
  const dstHours = newYorkOffset(anchor) - newYorkOffset(anchor + days);
  return text.replace(/(\d{4}-\d{2}-\d{2})(T\d{2}:\d{2}:\d{2})?/g, (_all, iso: string, time?: string) => {
    if (!time || dstHours === 0) {
      return new Date((dayNumber(iso) + days) * 86_400_000).toISOString().slice(0, 10) + (time ?? "");
    }
    const at = new Date(`${iso}${time}Z`).getTime() + (days * 24 + dstHours) * 3_600_000;
    return new Date(at).toISOString().slice(0, 19);
  });
}

function findBody(data: Fixtures, method: string, pathAndQuery: string): unknown | undefined {
  const exact = `${method} ${pathAndQuery}`;
  if (exact in data) return data[exact];
  const path = pathAndQuery.split("?")[0];
  if (`${method} ${path}` in data) return data[`${method} ${path}`];
  const prefix = `${method} ${path}?`;
  const key = Object.keys(data).find((k) => k.startsWith(prefix));
  return key === undefined ? undefined : data[key];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** An EventSource that opens and then never sends anything. */
class QuietEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  /** Events every new stream delivers right after it opens (the bells of a `?at=` moment). */
  static script: Fixtures[] = [];
  readyState = 0;
  url: string;
  withCredentials = false;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(url: string) {
    super();
    this.url = url;
    setTimeout(() => {
      if (this.readyState === 2) return;
      this.readyState = 1;
      this.onopen?.(new Event("open"));
      setTimeout(() => {
        for (const ev of QuietEventSource.script) this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(ev) }));
      }, 150);
    }, 0);
  }
  close(): void {
    this.readyState = 2;
  }
}

export async function installFixtures(): Promise<void> {
  const dataset = pickDataset();
  const data = (
    dataset === "empty"
      ? await import("./data/empty.json")
      : dataset === "nice"
        ? await import("./data/nice.json")
        : await import("./data/full.json")
  ).default as Fixtures;
  // Whole weeks only, so weekdays survive the shift (a recorded Tuesday stays a Tuesday,
  // sessions never land on a weekend). The data can be up to six days old; screenshot
  // scripts set the browser clock to the shifted anchor day.
  const weeksSince = (day: number) => Math.floor((day - dayNumber(ANCHOR)) / 7) * 7;
  let days = weeksSince(dayNumber(new Date().toISOString().slice(0, 10)));
  // `?at=`: the moment's own week decides the shift, and the clock is set to it from here on.
  const atSpec = pickAt();
  const atInstant = parseMoment(atSpec, dayNumber(ANCHOR) + days);
  let moment: Moment | null = null;
  if (atInstant !== null) {
    days = weeksSince(nyDay(atInstant));
    installClock(clockOffset(atInstant, Date.now()));
    moment = marketAt(atInstant);
    QuietEventSource.script = sessionEvents(moment) as Fixtures[];
  }
  const version = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "";
  const realFetch = window.fetch.bind(window);
  let briefMode = pickBrief();
  const view = pickView();

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.origin);
    if (!url.pathname.startsWith("/api/")) return realFetch(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (url.pathname === "/api/brief/ack" && method === "POST") {
      briefMode = "off";
      try {
        window.sessionStorage.setItem(BRIEF_KEY, "off");
      } catch {
        /* private mode: the ack lasts for this page only */
      }
      return json({ last_ack_at: new Date().toISOString() });
    }
    if (url.pathname === "/api/brief" && method === "GET") return respond(briefFor(briefMode, data, data["GET /api/brief"]));
    if (url.pathname === "/api/settings/values") {
      if (method === "PATCH") {
        // An in-app toggle: remember it, so the next read does not switch it back.
        try {
          const sent = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { changes?: Record<string, string> };
          const c = sent.changes ?? {};
          if (c.display_currency === "EUR" || c.display_currency === "USD") view.ccy = c.display_currency;
          if (c.theme === "light" || c.theme === "dark" || c.theme === "auto") view.theme = c.theme;
          saveView(view);
          return respond({
            changed: Object.keys(c),
            values: field(withView(data["GET /api/settings/values"], view), "values") ?? {},
          });
        } catch {
          /* fall through to the recorded answer */
        }
      }
      if (method === "GET") return respond(withView(data["GET /api/settings/values"], view));
    }
    // 7.4 currency journey (see ./journey): its own reads, the cash-out preview.
    const journey = journeyAnswer(url, method, data, typeof init?.body === "string" ? init.body : undefined);
    if (journey !== undefined) {
      const status = (journey as { __status?: number }).__status;
      return status ? json({ detail: "Fixture answer" }, status) : respond(journey);
    }
    if (method !== "GET") {
      const body = findBody(data, method, url.pathname + url.search);
      return body === undefined ? json({}) : respond(body);
    }
    // Until the recorder writes them (v7.2): a synthetic rate history and currency effect,
    // one invented book under both, so the chart's conversions and Impact's deposits agree.
    const recordedPath = (p: string) => Object.keys(data).some((k) => k === `GET ${p}` || k.startsWith(`GET ${p}?`));
    if (url.pathname === "/api/currency/rate-history" && !recordedPath(url.pathname)) {
      const fx = fixtureBook(data);
      return json(rateHistoryFixture(url.searchParams.get("range") ?? "1y", fx));
    }
    if (url.pathname === "/api/currency/effect/both" && !recordedPath(url.pathname) && dataset !== "empty") {
      const fx = fixtureBook(data);
      return json(currencyEffectFixture(url.searchParams.get("range") ?? "ytd", { now: fx.now, scale: fx.scale, data }));
    }
    if (url.pathname === "/api/currency/dollar/both" && !recordedPath(url.pathname) && dataset !== "empty") {
      const fx = fixtureBook(data);
      return json(currencyDollarFixture(url.searchParams.get("range") ?? "1y", fx.now));
    }
    if (url.pathname === "/api/currency/scenarios/both" && !recordedPath(url.pathname) && dataset !== "empty") {
      const fx = fixtureBook(data);
      return json(currencyScenariosFixture(fx.now));
    }
    // 7.1 endpoints are synthesised until the recorder writes them (see ./v71).
    const made = v71Answer(url, data);
    if (made !== undefined) {
      const status = (made as { __status?: number }).__status;
      return status ? json({ detail: "Fixture answer" }, status) : respond(journeyExtend(url.pathname, made, data));
    }
    const recorded = findBody(data, "GET", url.pathname + url.search);
    const extended = recorded === undefined ? undefined : journeyExtend(url.pathname, v71Extend(url.pathname, recorded, data), data);
    const body = url.pathname === "/api/currency/both" && dataset !== "empty" ? withStripTiles(extended, data) : extended;
    if (body === undefined || (typeof body === "object" && body !== null && "__status" in body)) {
      return json({ detail: "No fixture for this endpoint." }, 404);
    }
    return respond(body, url.pathname);
  };

  function respond(body: unknown, path = ""): Response {
    let text = shiftDates(JSON.stringify(body), days);
    // Patched after the shift: the moment's own instants are final.
    if (moment && dataset !== "empty") text = JSON.stringify(patchForMoment(path, JSON.parse(text), moment, data));
    text = text.split(VERSION_SENTINEL).join(version);
    return new Response(text, { status: 200, headers: { "Content-Type": "application/json" } });
  }

  (window as unknown as { EventSource: unknown }).EventSource = QuietEventSource;
  document.documentElement.dataset.fixtures = dataset;
}
