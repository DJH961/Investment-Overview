import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import full from "../../fixtures/data/full.json";
import { DisplayPrefsProvider } from "../../lib/displayPrefs";
import type { SettingsValues } from "../../lib/queries/settings";
import type { BriefDto } from "../../lib/queries/brief";
import { DailyBrief, formatRemaining, sinceLabel, useAutoClose } from "./DailyBrief";

vi.mock("../../lib/timezone", () => ({ useTimeZone: () => "UTC" }));

afterEach(() => vi.unstubAllGlobals());

const recorded = (full as Record<string, unknown>)["GET /api/brief"] as BriefDto;

const move = (ccy: "EUR" | "USD") => ({
  session_date: "2026-06-30",
  day_move: ccy === "EUR" ? "1234.5" : "1400",
  day_move_pct: "0.0125",
  price_move: ccy === "EUR" ? "1500" : "1400",
  currency_move: ccy === "EUR" ? "-265.5" : null,
  currency_overnight: false,
  estimated: false,
  movers: {
    basis_date: "2026-06-30",
    eligible_count: 3,
    winners: [{ symbol: "AAA", name: "Alpha", pct: "0.031", move: "300", reason: "total" }],
    losers: [{ symbol: "BBB", name: "Beta", pct: "-0.012", move: "-80", reason: "total" }],
  },
});

const session: BriefDto = {
  ...recorded,
  kind: "session",
  sessions: ["2026-06-30"],
  sessions_passed: 1,
  move: { EUR: move("EUR"), USD: move("USD") },
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** fetch stub: GET /api/brief answers `brief()`; the ack answers `ack` (status, optional gate). */
function stub(brief: () => BriefDto, ack: { status: number; gate?: Promise<void> } = { status: 200 }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes("/api/brief/ack")) {
        if (ack.gate) await ack.gate;
        const body = ack.status === 200 ? { last_ack_at: "2026-06-30T18:15:00+00:00" } : { detail: "boom" };
        return new Response(JSON.stringify(body), { status: ack.status, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify(brief()), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
  return calls;
}

/** Settings values with only `brief_autoclose_minutes` set (or none: the defaults). */
const prefs = (minutes?: number): SettingsValues | undefined =>
  minutes === undefined
    ? undefined
    : ({
        brief_autoclose_minutes: { value: minutes, source: "db", default: 3, env_value_present: false, modified_at: null, is_set: true, stored_invalid: false },
      } as never);

function mount(currency: "EUR" | "USD" = "EUR", minutes?: number) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <DisplayPrefsProvider values={prefs(minutes)}>
        <DailyBrief currency={currency} />
      </DisplayPrefsProvider>
    </QueryClientProvider>,
  );
  return { qc, ...view };
}

describe("DailyBrief", () => {
  it("shows nothing when no brief is due (no 'up to date' chrome)", async () => {
    stub(() => ({ ...recorded, due: false }));
    const { container } = mount();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("a multi-session window says how many sessions passed, with no totals", async () => {
    stub(() => recorded);
    mount();
    expect(await screen.findByText(`${recorded.sessions_passed} sessions passed`)).toBeInTheDocument();
    expect(screen.queryByTestId("brief-figure")).toBeNull();
    // The owner's own ledger rows are not news to him (owner): the card does not list them.
    expect(screen.queryByTestId("brief-events")).toBeNull();
    expect(screen.queryByText(/Interest|Dividend FAKEB/)).toBeNull();
  });

  it("one session: the server's move, market vs currency, and the movers", async () => {
    stub(() => session);
    mount("EUR");
    expect(await screen.findByTestId("brief-figure")).toHaveTextContent("+€1,234.50");
    expect(screen.getByTestId("brief-split")).toHaveTextContent("Market+€1,500.00Currency-€265.50");
    expect(screen.getByTestId("brief-movers")).toHaveTextContent("AAA");
    expect(screen.getByTestId("brief-movers")).toHaveTextContent("BBB");
  });

  it("the USD view has no currency leg and says so (same lines)", async () => {
    stub(() => session);
    mount("USD");
    expect(await screen.findByTestId("brief-split")).toHaveTextContent("none in USD");
    expect(screen.getByTestId("brief-figure")).toHaveTextContent("1,400.00");
  });

  it("dismiss: gone at once, the ack carries the instant shown, and it stays gone", async () => {
    let due = true;
    const calls = stub(() => ({ ...recorded, due }));
    const { qc } = mount();
    const close = await screen.findByRole("button", { name: "Dismiss the brief" });
    await userEvent.click(close);
    // Optimistic: the card leaves before the write returns.
    expect(screen.queryByRole("region", { name: "Daily brief" })).toBeNull();
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ seen_at: recorded.now });
    // The server moved its marker; a later read (tick, focus) keeps it gone.
    due = false;
    await qc.invalidateQueries({ queryKey: ["brief"] });
    await waitFor(() => expect(calls.filter((c) => c.method === "GET").length).toBeGreaterThan(1));
    expect(screen.queryByRole("region", { name: "Daily brief" })).toBeNull();
  });

  it("dismiss that fails brings the card back", async () => {
    let open!: () => void;
    stub(() => recorded, { status: 500, gate: new Promise<void>((r) => (open = r)) });
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss the brief" }));
    expect(screen.queryByRole("region", { name: "Daily brief" })).toBeNull();
    open();
    expect(await screen.findByRole("region", { name: "Daily brief" })).toBeInTheDocument();
  });

  it("the header names the window", async () => {
    stub(() => recorded);
    mount();
    expect(await screen.findByTestId("brief-window")).toHaveTextContent(`· ${recorded.sessions_passed} sessions`);
  });

  it("movers: up to three each way, arrow and sign on every chip", async () => {
    const m = (symbol: string, pct: string) => ({ symbol, name: symbol, pct, move: "1", reason: "total" });
    const many = move("EUR");
    many.movers = {
      ...many.movers,
      winners: [m("U1", "0.04"), m("U2", "0.03"), m("U3", "0.02"), m("U4", "0.01")],
      losers: [m("D1", "-0.04")],
    };
    stub(() => ({ ...session, move: { EUR: many, USD: many } }));
    mount("EUR");
    const up = await screen.findByTestId("brief-movers-up");
    expect(up).toHaveTextContent("U1");
    expect(up).toHaveTextContent("U3");
    expect(up).not.toHaveTextContent("U4");
    expect(up).toHaveTextContent("+4.00%");
    expect(screen.getByTestId("brief-movers-down")).toHaveTextContent("D1 -4.00%");
  });

  const since = "2026-06-29T11:00:00+00:00";
  const effect = { amount: "-1187.42", pct: "-0.0049", rate_then: "1.0712", rate_now: "1.0765", since };
  const power = {
    amount_eur: "1000",
    amount_usd_now: "1076.50",
    amount_usd_then: "1071.20",
    net: "5.30",
    pct: "0.004948",
    rate_then: "1.0712",
    rate_now: "1.0765",
    since,
  };
  const withEffect: BriefDto = { ...session, currency_effect_since: { EUR: effect, USD: null }, investing_power_since: power };

  it("EUR view: the currency effect since the last look, with the rates", async () => {
    stub(() => withEffect);
    mount("EUR");
    const slot = await screen.findByTestId("brief-currency-effect");
    expect(slot).toHaveTextContent("Currency effect since Mon 11:00");
    expect(slot).toHaveTextContent("-€1,187.42");
    expect(slot).toHaveTextContent("EUR/USD 1.0712 → 1.0765");
    expect(slot).not.toHaveTextContent("Investing power");
  });

  it("USD view: the investing power of the regular euro amount, server dollars only", async () => {
    stub(() => withEffect);
    mount("USD");
    const slot = await screen.findByTestId("brief-currency-effect");
    expect(slot).toHaveTextContent("Investing power since Mon 11:00");
    expect(slot).toHaveTextContent("+US$5.30");
    expect(slot).toHaveTextContent("Regular €1,000 buys US$1,076.50 (was US$1,071.20)");
    expect(slot).not.toHaveTextContent("1,187.42");
  });

  it("a side without its figure keeps the slot with a dash; neither field omits it", async () => {
    stub(() => ({ ...withEffect, investing_power_since: null }));
    const a = mount("USD");
    expect(await screen.findByTestId("brief-currency-effect")).toHaveTextContent("–");
    a.unmount();
    stub(() => ({ ...withEffect, currency_effect_since: null }));
    const c = mount("EUR");
    expect(await screen.findByTestId("brief-currency-effect")).toHaveTextContent("–");
    c.unmount();
    stub(() => session);
    mount("EUR");
    await screen.findByTestId("brief-figure");
    expect(screen.queryByTestId("brief-currency-effect")).toBeNull();
  });

  it("auto-close: 3 minutes by default, shown as a countdown", async () => {
    stub(() => recorded);
    mount();
    expect(await screen.findByTestId("brief-timer")).toHaveTextContent("closes in 3:00");
  });

  it("auto-close: 0 means never (no countdown)", async () => {
    stub(() => recorded);
    mount("EUR", 0);
    await screen.findByRole("region", { name: "Daily brief" });
    expect(screen.queryByTestId("brief-timer")).toBeNull();
  });

  it("auto-close: a custom value from the settings", async () => {
    stub(() => recorded);
    mount("EUR", 5);
    expect(await screen.findByTestId("brief-timer")).toHaveTextContent("closes in 5:00");
  });

  it("auto-close acknowledges like a dismiss; pointing at the card pauses it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const calls = stub(() => recorded);
      mount("EUR", 1);
      const card = await screen.findByRole("region", { name: "Daily brief" });
      act(() => void card.dispatchEvent(new Event("pointerenter")));
      await act(async () => vi.advanceTimersByTime(90_000));
      expect(screen.getByTestId("brief-timer")).toHaveTextContent(/closes in 0:5\d|closes in 1:00/);
      act(() => void card.dispatchEvent(new Event("pointerleave")));
      await act(async () => vi.advanceTimersByTime(61_000));
      await waitFor(() => expect(screen.queryByRole("region", { name: "Daily brief" })).toBeNull());
      await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ seen_at: recorded.now }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("formats the countdown and the window start", () => {
    expect(formatRemaining(180_000)).toBe("3:00");
    expect(formatRemaining(161_001)).toBe("2:42");
    expect(formatRemaining(-5)).toBe("0:00");
    expect(sinceLabel("2026-06-29T11:00:00Z", "2026-06-30T18:15:00Z", "UTC")).toMatch(/^Mon 11:00$/);
    expect(sinceLabel("2026-06-01T11:00:00Z", "2026-06-30T18:15:00Z", "UTC")).toMatch(/^Mon \S+ 11:00$/);
  });
});

describe("useAutoClose", () => {
  afterEach(() => vi.useRealTimers());

  it("closes after the minutes on screen, once; pausing stops the count", () => {
    vi.useFakeTimers();
    const done = vi.fn();
    const { result } = renderHook(() => useAutoClose(3, done));
    expect(result.current.remaining).toBe(180_000);
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current.remaining).toBe(120_000);
    act(() => result.current.setPaused(true));
    act(() => vi.advanceTimersByTime(300_000));
    expect(done).not.toHaveBeenCalled();
    expect(result.current.remaining).toBe(120_000);
    act(() => result.current.setPaused(false));
    act(() => vi.advanceTimersByTime(121_000));
    expect(done).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(60_000));
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("0 minutes never closes and shows no countdown", () => {
    vi.useFakeTimers();
    const done = vi.fn();
    const { result } = renderHook(() => useAutoClose(0, done));
    act(() => vi.advanceTimersByTime(3_600_000));
    expect(result.current.remaining).toBeNull();
    expect(done).not.toHaveBeenCalled();
  });
});
