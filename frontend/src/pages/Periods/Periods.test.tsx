import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrefsProvider } from "../../lib/prefs";
import { Periods } from "./Periods";

// lib/shell.tsx hands out an unstable setShell (loops with useShellStatus); stub until fixed.
vi.mock("../../lib/shell", () => ({ useShellStatus: () => undefined }));

function wrap(node: React.ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PrefsProvider>
        <MemoryRouter>{node}</MemoryRouter>
      </PrefsProvider>
    </QueryClientProvider>,
  );
}

const json = (body: unknown) => new Response(JSON.stringify({ EUR: body, USD: body }), { status: 200 });

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const row = (label: string, over: Record<string, unknown> = {}) => ({
  label,
  is_current: false,
  closing_value: "1000",
  growth_pct: "0.05",
  net_flow: "10",
  contributions: "10",
  dividends: "0",
  interest: "0",
  opening_value: "900",
  period_growth_xirr: "0.06",
  total_growth_compounded: "0.2",
  ...over,
});

function stubPeriods() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const monthly = String(url).includes("/monthly");
      return json({
        as_of: "2026-10-31",
        ccy: "EUR",
        granularity: monthly ? "monthly" : "yearly",
        rows: monthly
          ? [row("2025-12"), row("2026-01"), row("2026-02", { is_current: true })]
          : [row("2025"), row("2026", { is_current: true })],
      });
    }),
  );
}

describe("Periods", () => {
  it("renders rows and a dash for missing values", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          as_of: "2026-10-31",
          ccy: "EUR",
          granularity: "monthly",
          rows: [
            {
              label: "2026-10",
              is_current: true,
              closing_value: "1000",
              growth_pct: "0.05",
              net_flow: null,
              contributions: "100",
              dividends: "0",
              interest: "0",
              opening_value: "900",
              period_growth_xirr: null,
              total_growth_compounded: null,
            },
          ],
        }),
      ),
    );
    wrap(<Periods />);
    expect((await screen.findAllByText("Oct 2026")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("shows an error state on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 400 })));
    wrap(<Periods />);
    expect(await screen.findByText("Could not load periods")).toBeInTheDocument();
  });
});

describe("Periods by year", () => {
  it("opens the current year only and remembers folds", async () => {
    stubPeriods();
    wrap(<Periods />);
    // Month names also label the growth chart's axis: look inside the year tables.
    const y2026 = await screen.findByRole("table", { name: "2026 months" });
    expect(within(y2026).getByText("Feb 2026")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "2025 months" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /2025/ }));
    const y2025 = await screen.findByRole("table", { name: "2025 months" });
    expect(within(y2025).getByText("Dec 2025")).toBeInTheDocument();
    expect(window.localStorage.getItem("iv.fold.periods.year.2025")).toBe("true");
  });

  it("requests padded months and shows Total growth and XIRR on the yearly view", async () => {
    stubPeriods();
    wrap(<Periods />);
    await screen.findByRole("table", { name: "2026 months" });
    const urls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/monthly") && u.includes("fill_gaps=true"))).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Yearly" }));
    expect((await screen.findAllByText("Total growth")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("XIRR (period)").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Growth (TWR)").length).toBeGreaterThan(0);
    expect(window.localStorage.getItem("iv.periods.view")).toBe('"yearly"');
  });
});
