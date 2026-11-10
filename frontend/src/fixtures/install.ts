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
 */

type Fixtures = Record<string, unknown>;

/** The day the fixtures were recorded; every date is shifted to the browser's today. */
const ANCHOR = "2026-06-30";
const VERSION_SENTINEL = "fixtures-version";
const STORAGE_KEY = "iv.fixtures";

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

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.origin);
    if (!url.pathname.startsWith("/api/")) return realFetch(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
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
