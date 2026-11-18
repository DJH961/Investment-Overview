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
 */

type Fixtures = Record<string, unknown>;

/** The day the fixtures were recorded; every date is shifted to the browser's today. */
const ANCHOR = "2026-06-30";
const VERSION_SENTINEL = "fixtures-version";
const STORAGE_KEY = "iv.fixtures";
const BRIEF_KEY = "iv.fixtures.brief";
type BriefMode = "sessions" | "session" | "fx" | "off";

declare const __APP_VERSION__: string;

function pickDataset(): "full" | "empty" {
  try {
    const asked = new URLSearchParams(window.location.search).get("fixtures");
    if (asked === "empty" || asked === "full") window.sessionStorage.setItem(STORAGE_KEY, asked);
    return window.sessionStorage.getItem(STORAGE_KEY) === "empty" ? "empty" : "full";
  } catch {
    return "full";
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
    }, 0);
  }
  close(): void {
    this.readyState = 2;
  }
}

export async function installFixtures(): Promise<void> {
  const dataset = pickDataset();
  const data = (
    dataset === "empty" ? await import("./data/empty.json") : await import("./data/full.json")
  ).default as Fixtures;
  // Whole weeks only, so weekdays survive the shift (a recorded Tuesday stays a Tuesday,
  // sessions never land on a weekend). The data can be up to six days old; screenshot
  // scripts set the browser clock to the shifted anchor day.
  const days = Math.floor((dayNumber(new Date().toISOString().slice(0, 10)) - dayNumber(ANCHOR)) / 7) * 7;
  const version = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "";
  const realFetch = window.fetch.bind(window);
  let briefMode = pickBrief();

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
    if (method !== "GET") {
      const body = findBody(data, method, url.pathname + url.search);
      return body === undefined ? json({}) : respond(body);
    }
    const body = findBody(data, "GET", url.pathname + url.search);
    if (body === undefined || (typeof body === "object" && body !== null && "__status" in body)) {
      return json({ detail: "No fixture for this endpoint." }, 404);
    }
    return respond(body);
  };

  function respond(body: unknown): Response {
    const text = shiftDates(JSON.stringify(body), days).split(VERSION_SENTINEL).join(version);
    return new Response(text, { status: 200, headers: { "Content-Type": "application/json" } });
  }

  (window as unknown as { EventSource: unknown }).EventSource = QuietEventSource;
  document.documentElement.dataset.fixtures = dataset;
}
