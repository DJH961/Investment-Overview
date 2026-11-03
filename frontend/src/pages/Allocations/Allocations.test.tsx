import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/Toast";
import { PrefsProvider } from "../../lib/prefs";
import { rebalancePath } from "../../lib/queries/manage";
import { Allocations, totalWeight } from "./Allocations";
import { presetClear, presetCurrent, presetEqual, presetSaved } from "./builderState";

vi.mock("../../lib/shell", () => ({ useShellStatus: () => undefined }));

const items = [
  { key: "1", current_pct: "0.728" },
  { key: "2", current_pct: "0.272" },
  { key: "3", current_pct: "0" },
];

describe("Allocations helpers", () => {
  it("sums typed weights live, ignoring junk", () => {
    expect(totalWeight([{ weight: "60" }, { weight: "25.5" }, { weight: "abc" }])).toBe(85.5);
    expect(totalWeight({ a: "50", b: "50" })).toBe(100);
  });

  it("builds the rebalance query", () => {
    const path = rebalancePath({ amount: "1000", ccy: "EUR", fractional: true, allowSell: false, targetId: 3 });
    expect(path).toBe("/api/allocations/rebalance?amount=1000&ccy=EUR&fractional=true&allow_sell=false&target_id=3");
  });

  it("presets: current mix, equal, clear, saved", () => {
    expect(presetCurrent(items)).toEqual({ "1": "72.8", "2": "27.2", "3": "0" });
    expect(presetEqual(items)).toEqual({ "1": "33.33", "2": "33.33", "3": "33.33" });
    expect(presetClear(items)).toEqual({ "1": "0", "2": "0", "3": "0" });
    const target = {
      id: 1, name: "T", active: true, allow_sell: false,
      items: [{ instrument_id: 2, symbol: "B", weight_pct: "0.4", no_buy: false }],
    };
    expect(presetSaved(items, target)).toEqual({ "1": "0", "2": "40", "3": "0" });
  });
});

const allocations = {
  ccy: "EUR", as_of: "2026-10-31", total_value: "5000", targets: [], active_target_id: null,
  drift: [], current_by_category: [], current_by_asset_class: [{ label: "etf", value: "5000", pct: "1" }],
};
const inputs = {
  ccy: "EUR", as_of: "2026-10-31", fx_usd_per_eur: "1.2", total_value: "5000",
  instruments: [
    { instrument_id: 1, symbol: "AAA", name: "A fund", category: "Stocks", current_value: "3640", current_pct: "0.728" },
    { instrument_id: 2, symbol: "BBB", name: "B fund", category: "Bonds", current_value: "1360", current_pct: "0.272" },
  ],
  categories: [
    { name: "Stocks", current_value: "3640", current_pct: "0.728", members: [1] },
    { name: "Bonds", current_value: "1360", current_pct: "0.272", members: [2] },
  ],
  projection_defaults: {},
};
const plan = {
  ccy: "EUR", mode: "fund", allow_sell: false, allow_fractional: false, fx_usd_per_eur: "1.2",
  summary: {
    cash: "1000", buying: "990", selling: "0", leftover: "10", other_ccy: "USD",
    other_cash: "1200", other_buying: "1188", other_selling: "0", other_leftover: "12", pct_of_wealth: "0.2",
  },
  rows: [
    {
      instrument_id: 2, symbol: "BBB", name: "B fund", category: "Bonds", target_pct: "0.5", current_pct: "0.272",
      before_pct: "0.227", after_pct: "0.39", current_value: "1360", add_value: "990", current_price: "10",
      add_shares: "99", no_buy: false, held_unticked: false,
    },
  ],
  categories: [
    { name: "Bonds", target_pct: "0.5", current_pct: "0.272", before_pct: "0.227", after_pct: "0.39", add_value: "990" },
  ],
  extras: [],
};

function stub() {
  const calls: { url: string; body?: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = url.includes("/api/allocations/plan")
        ? plan
        : url.includes("/api/allocations")
          ? allocations
          : url.includes("/api/calculator")
            ? inputs
            : url.includes("/api/settings/values")
              ? { values: { "chart_pref.calc.allow_fractional": { value: true } } }
              : {};
      return new Response(JSON.stringify(json), { status: 200 });
    }),
  );
  return calls;
}

function wrap() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PrefsProvider>
        <ToastProvider>
          <Allocations />
        </ToastProvider>
      </PrefsProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("Allocations page", () => {
  it("shows the builder with no target and plans the unsaved mix", async () => {
    const calls = stub();
    wrap();
    expect(await screen.findByLabelText("Target % for AAA")).toHaveValue("72.8");
    fireEvent.click(screen.getByRole("button", { name: "Equal weight" }));
    expect(screen.getByLabelText("Target % for BBB")).toHaveValue("50");
    expect(screen.getByTestId("weight-total")).toHaveTextContent("sums to 100 %");
    await waitFor(() => expect(screen.getByLabelText("Fractional shares")).toBeChecked());
    fireEvent.change(screen.getByLabelText("Cash to invest (EUR)"), { target: { value: "1500" } });
    fireEvent.click(screen.getByRole("button", { name: "Compute plan" }));
    expect(await screen.findByText("Plan summary")).toBeInTheDocument();
    const post = calls.find((c) => c.url.includes("/api/allocations/plan"));
    expect(post?.body).toMatchObject({ amount: "1500", mode: "fund", fractional: true });
    expect(window.localStorage.getItem("iv.calc.amount")).toBe('"1500"');
  });

  it("switches to category mode with member funds", async () => {
    stub();
    wrap();
    fireEvent.click(await screen.findByRole("radio", { name: "By category" }));
    expect(screen.getByLabelText("Target % for Stocks")).toHaveValue("72.8");
    expect(screen.getAllByText(/Funds in this category/)).toHaveLength(2);
  });

  it("renders the allocation section while only the calculator inputs are loading", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        // The calculator inputs never answer; the allocations do.
        if (url.includes("/api/calculator")) return new Promise<Response>(() => undefined);
        if (url.includes("/api/allocations")) return new Response(JSON.stringify(allocations), { status: 200 });
        return new Response(JSON.stringify({ values: {} }), { status: 200 });
      }),
    );
    wrap();
    expect(await screen.findByText("Current allocation")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Compute plan" })).not.toBeInTheDocument();
  });
});
