import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import full from "../../fixtures/data/full.json";
import type { BriefDto } from "../../lib/queries/brief";
import { DailyBrief, eventLabel } from "./DailyBrief";

vi.mock("../../lib/timezone", () => ({ useTimeZone: () => "UTC" }));

afterEach(() => vi.unstubAllGlobals());

const recorded = (full as unknown as Record<string, BriefDto>)["GET /api/brief"];

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

function mount(currency: "EUR" | "USD" = "EUR") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <DailyBrief currency={currency} />
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
    // The ledger rows that landed while away are named.
    expect(screen.getByTestId("brief-events")).toHaveTextContent("Interest, Dividend FAKEB");
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

  it("names ledger events in a few words", () => {
    expect(eventLabel({ id: 1, kind: "dividend_cash", symbol: "VT", date: "2026-06-30", created_at: "x" })).toBe("Dividend VT");
    expect(eventLabel({ id: 2, kind: "interest", symbol: null, date: "2026-06-30", created_at: "x" })).toBe("Interest");
    expect(eventLabel({ id: 3, kind: "odd_kind", symbol: null, date: "2026-06-30", created_at: "x" })).toBe("odd kind");
  });
});
