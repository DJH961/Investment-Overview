import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/Toast";
import { PrefsProvider } from "../../lib/prefs";
import { rebalancePath } from "../../lib/queries/manage";
import { Allocations, totalWeight } from "./Allocations";
import {
  effectiveSelection,
  orderTrades,
  presetClear,
  presetCurrent,
  presetEqual,
  fromSavedBuilder,
  presetSaved,
  toSavedBuilder,
  cashIn,
  tradeTotals,
} from "./builderState";
import { freeName, nameError } from "./SaveTargetDialog";

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
  const calls: { url: string; method: string; body?: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = url.includes("/api/allocations/plan")
        ? plan
        : url.includes("/api/allocations")
          ? { EUR: allocations, USD: allocations }
          : url.includes("/api/calculator")
            ? { EUR: inputs, USD: inputs }
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

describe("Invest only in ETFs", () => {
  const etfs = new Set([1, 2]);
  const isEtf = (id: number) => etfs.has(id);
  it("narrows new money to the category's ETFs, keeping the user's ETF ticks", () => {
    // 1, 2 ETFs; 3 a mutual fund; the user ticked 1 and 3.
    expect(effectiveSelection([1, 2, 3], [1, 3], true, isEtf)).toEqual({ ids: [1], etfOnlyApplies: true });
    // No ETF ticked: every ETF of the category gets the money.
    expect(effectiveSelection([1, 2, 3], [3], true, isEtf)).toEqual({ ids: [1, 2], etfOnlyApplies: true });
  });
  it("leaves a category without ETFs (and the option off) alone", () => {
    expect(effectiveSelection([3, 4], [3], true, isEtf)).toEqual({ ids: [3], etfOnlyApplies: false });
    expect(effectiveSelection([1, 3], [1, 3], false, isEtf)).toEqual({ ids: [1, 3], etfOnlyApplies: false });
  });
});

describe("Plan reading order", () => {
  it("lists the biggest buys, then the biggest sells, then the rest", () => {
    const rows = [
      { id: "a", add_value: "-50" },
      { id: "b", add_value: "10" },
      { id: "c", add_value: "0" },
      { id: "d", add_value: "-500" },
      { id: "e", add_value: "300" },
    ];
    expect(orderTrades(rows).map((r) => r.id)).toEqual(["e", "b", "d", "a", "c"]);
    expect(tradeTotals(rows)).toEqual({ buy: 310, sell: 550 });
  });
});

describe("Save target dialog checks", () => {
  const targets = [
    { id: 1, name: "Target", active: true, allow_sell: false, items: [] },
    { id: 2, name: "Growth", active: false, allow_sell: false, items: [] },
  ] as unknown as Parameters<typeof nameError>[1];
  it("needs a name that no other target uses", () => {
    expect(nameError("  ", targets, "new")).toMatch(/name/);
    expect(nameError("growth", targets, "new")).toMatch(/already exists/);
    // Replacing a target may keep its own name.
    expect(nameError("Growth", targets, "2")).toBeNull();
    expect(nameError("Income", targets, "new")).toBeNull();
  });
  it("suggests a free default name", () => {
    expect(freeName(targets)).toBe("Target 2");
    expect(freeName([])).toBe("Target");
  });
});

describe("Saved calculator selection", () => {
  it("round-trips the category mix, split and the deselected funds", () => {
    const ed = { weights: { Stocks: "70", Bonds: "30" }, split: { Stocks: "even" as const }, selected: { Stocks: [1], Bonds: [2] } };
    const saved = toSavedBuilder("category", true, ["Stocks", "Bonds"], ed);
    expect(saved).toEqual({
      mode: "category",
      etf_only: true,
      categories: [
        { name: "Stocks", weight: "70", split: "even", selected: [1] },
        { name: "Bonds", weight: "30", split: "value", selected: [2] },
      ],
    });
    const fresh = { weights: { Stocks: "50", Bonds: "50", Cash: "0" }, split: {}, selected: { Stocks: [1, 3], Bonds: [2], Cash: [9] } };
    const back = fromSavedBuilder(saved, { Stocks: [1, 3], Bonds: [2], Cash: [9] }, fresh);
    expect(back.selected).toEqual({ Stocks: [1], Bonds: [2], Cash: [9] }); // 3 stays deselected
    expect(back.weights).toEqual({ Stocks: "70", Bonds: "30", Cash: "0" });
    expect(back.split).toEqual({ Stocks: "even", Bonds: "value" });
  });
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
    const calls = stub();
    wrap();
    fireEvent.click(await screen.findByRole("radio", { name: "By category" }));
    expect(screen.getByLabelText("Target % for Stocks")).toHaveValue("72.8");
    expect(screen.getAllByRole("group", { name: /Funds in / })).toHaveLength(2);
    // "Invest only in ETFs" is one tap and remembered on this device.
    const etf = screen.getByRole("button", { name: "Invest only in ETFs" });
    expect(etf).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(etf);
    expect(etf).toHaveAttribute("aria-pressed", "true");
    expect(window.localStorage.getItem("iv.calc.etfOnly")).toBe("true");
    // A device choice: it never writes the server settings.
    expect(calls.some((c) => c.url.includes("/api/settings") && c.method !== "GET")).toBe(false);
  });

  it("renders the allocation section while only the calculator inputs are loading", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        // The calculator inputs never answer; the allocations do.
        if (url.includes("/api/calculator")) return new Promise<Response>(() => undefined);
        if (url.includes("/api/allocations")) return new Response(JSON.stringify({ EUR: allocations, USD: allocations }), { status: 200 });
        return new Response(JSON.stringify({ values: {} }), { status: 200 });
      }),
    );
    wrap();
    expect(await screen.findByText("Current allocation")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Compute plan" })).not.toBeInTheDocument();
  });

  it("saves which funds get new money with the target and restores it on load", async () => {
    const savedInputs = { ...inputs };
    const savedAlloc = { ...allocations };
    const savedMode = plan.mode;
    inputs.instruments = [
      ...savedInputs.instruments,
      { instrument_id: 3, symbol: "CCC", name: "C fund", category: "Stocks", current_value: "0", current_pct: "0" },
    ];
    inputs.categories = [{ ...savedInputs.categories[0], members: [1, 3] }, savedInputs.categories[1]];
    const builder = {
      mode: "category",
      etf_only: false,
      categories: [
        { name: "Stocks", weight: "70", split: "even", selected: [1] },
        { name: "Bonds", weight: "30", split: "value", selected: [2] },
      ],
    };
    Object.assign(allocations, {
      targets: [
        {
          id: 7, name: "Mine", active: true, allow_sell: true, builder,
          items: [{ instrument_id: 1, symbol: "AAA", weight_pct: "0.7", no_buy: false }],
        },
      ],
      active_target_id: 7,
    });
    plan.mode = "category";
    try {
      const calls = stub();
      // The dialog's switch measures itself.
      vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
      wrap();
      fireEvent.click(await screen.findByRole("radio", { name: "By category" }));
      // Restored from the saved target: weights and the deselected CCC.
      expect(screen.getByLabelText("Target % for Stocks")).toHaveValue("70");
      expect(screen.getByRole("button", { name: /CCC/ })).toHaveAttribute("aria-pressed", "false");
      expect(screen.getByRole("button", { name: /AAA/ })).toHaveAttribute("aria-pressed", "true");
      // Loading the target also restores its rebalance setting (and the mode, from fund mode).
      fireEvent.click(screen.getByRole("radio", { name: "By fund" }));
      fireEvent.click(screen.getByRole("button", { name: "Load saved target" }));
      expect(screen.getByRole("radio", { name: "By category" })).toBeChecked();
      expect(screen.getByLabelText("Allow selling (rebalance)")).toBeChecked();
      fireEvent.click(screen.getByRole("button", { name: "Compute plan" }));
      await screen.findByText("Plan summary");
      const post = calls.find((c) => c.url.includes("/api/allocations/plan"));
      expect(post?.body).toMatchObject({ allow_sell: true, category_weights: [{ name: "Stocks", selected: [1] }, { name: "Bonds" }] });
      fireEvent.click(screen.getByRole("button", { name: /Save as target/ }));
      fireEvent.click(await screen.findByRole("button", { name: "Replace target" }));
      await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
      const put = calls.find((c) => c.method === "PUT");
      expect(put?.body).toMatchObject({ id: 7, allow_sell: true, builder });
    } finally {
      Object.assign(inputs, savedInputs);
      Object.assign(allocations, savedAlloc);
      plan.mode = savedMode;
    }
  });
});

describe("Use my cash", () => {
  it("restates the server's held cash in the other currency at the same-payload rate", () => {
    const i = { ccy: "EUR", investable_cash: "800", fx_usd_per_eur: "1.25" };
    expect(cashIn(i, "EUR")).toBe(800);
    expect(cashIn(i, "USD")).toBe(1000);
    expect(cashIn({ ...i, ccy: "USD", investable_cash: "1000" }, "EUR")).toBe(800);
    expect(cashIn({ ...i, investable_cash: "0" }, "EUR")).toBe(0);
    expect(cashIn({ ccy: "EUR", investable_cash: "800" }, "USD")).toBe(0);
  });

  it("offers the chip, fills the amount and asks the server to move the cash", async () => {
    const saved = { ...inputs };
    Object.assign(inputs, {
      investable_cash: "800",
      instruments: [
        ...saved.instruments,
        { instrument_id: 9, symbol: "VMFXX", name: "Money market", category: "Cash", current_value: "800", current_pct: "0.14", is_cash: true },
      ],
      categories: [...saved.categories, { name: "Cash", current_value: "800", current_pct: "0.14", members: [9], is_cash: true }],
    });
    try {
      const calls = stub();
      wrap();
      const chip = await screen.findByRole("button", { name: /Use my cash/ });
      expect(chip).toHaveTextContent("800");
      // "Match current mix" never aims at the money-market fund.
      fireEvent.click(screen.getByRole("button", { name: "Match current mix" }));
      expect(screen.getByLabelText("Target % for VMFXX")).toHaveValue("0");
      fireEvent.click(chip);
      expect(screen.getByLabelText("Cash to invest (EUR)")).toHaveValue("800");
      fireEvent.click(screen.getByRole("button", { name: "Compute plan" }));
      await screen.findByText("Plan summary");
      const post = calls.find((c) => c.url.includes("/api/allocations/plan"));
      expect(post?.body).toMatchObject({ amount: "800", use_held_cash: true });
    } finally {
      Object.assign(inputs, saved);
      delete (inputs as Record<string, unknown>).investable_cash;
    }
  });

  it("hides the chip when no cash is held", async () => {
    stub();
    wrap();
    await screen.findByLabelText("Cash to invest (EUR)");
    expect(screen.queryByRole("button", { name: /Use my cash/ })).not.toBeInTheDocument();
  });
});
