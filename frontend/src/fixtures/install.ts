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
  const since = typeof base.last_ack_at === "string" ? base.last_ack_at : null;
  if (!since) return base;
  const rates = { rate_then: "1.0712", rate_now: "1.0765", since };
  return {
    ...base,
    currency_effect_since: { EUR: { amount: "-1187.42", pct: "-0.0049", ...rates }, USD: null },
    investing_power_since: {
      amount_eur: "1000",
      amount_usd_now: "1076.50",
      amount_usd_then: "1071.20",
      net: "5.30",
      pct: "0.004948",
      ...rates,
    },
  };
}

/** The recorded Brief, reshaped to the chosen kind with figures copied from the overview (as the server does). */
function briefFor(mode: BriefMode, data: Fixtures, recorded: unknown): unknown {
  const base = withCurrencyEffect((recorded ?? {}) as Obj);
  if (mode === "off") return { ...base, due: false, kind: null, events: [], events_total: 0 };
  if (mode === "sessions") return base;
  const both = data["GET /api/overview/both"];
  const sides = ["EUR", "USD"] as const;
  if (mode === "session") {
    const move = Object.fromEntries(
      sides.map((c) => {
        const o = field(both, c);
        const k = field(o, "kpis");
        const split = field(o, "day_split");
        return [
          c,
          {
            session_date: field(k, "daily_growth_as_of") ?? (base.sessions as string[] | undefined)?.at(-1),
            day_move: field(k, "daily_move"),
            day_move_pct: field(k, "daily_growth_pct"),
            price_move: field(split, "price_move"),
            currency_move: field(split, "currency_move"),
            currency_overnight: Boolean(field(split, "overnight")),
            estimated: Boolean(field(split, "estimated")),
            movers: field(o, "movers"),
          },
        ];
      }),
    );
    const sessions = (base.sessions as string[] | undefined)?.slice(-1) ?? [];
    return { ...base, kind: "session", sessions, sessions_passed: 1, move };
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

function shiftDates(text: string, days: number): string {
  if (days === 0) return text;
  return text.replace(/\d{4}-\d{2}-\d{2}/g, (iso) => {
    const shifted = new Date((dayNumber(iso) + days) * 86_400_000);
    return shifted.toISOString().slice(0, 10);
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
  const days = dayNumber(new Date().toISOString().slice(0, 10)) - dayNumber(ANCHOR);
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
