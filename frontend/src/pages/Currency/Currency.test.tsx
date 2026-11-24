import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import full from "../../fixtures/data/full.json";
import type { CurrencyDto } from "../../lib/queries/currency";
import type { OverviewDto } from "../../lib/queries/portfolio";

const state = vi.hoisted(() => ({
  ccy: "EUR" as "EUR" | "USD",
  both: null as null | { EUR: unknown; USD: unknown },
  overview: null as null | { EUR: unknown; USD: unknown },
}));

vi.mock("../../lib/shell", () => ({ useShellStatus: () => undefined }));
// The rate chart has its own tests and query; the page tests cover the strip and Today.
vi.mock("../../components/RateChart", () => ({ RateChart: () => <div data-testid="rate-chart" /> }));
vi.mock("../../lib/timezone", () => ({ useTimeZone: () => "UTC" }));
vi.mock("../../lib/prefs", async (orig) => ({
  ...(await orig<typeof import("../../lib/prefs")>()),
  usePrefs: () => ({ currency: state.ccy }),
}));
vi.mock("../../lib/queries/currency", () => ({
  useCurrency: (c: "EUR" | "USD") => ({
    data: state.both?.[c],
    isPending: !state.both,
    isError: false,
    isFetching: false,
    refetch: () => undefined,
  }),
}));
vi.mock("../../lib/queries/portfolio", async (orig) => ({
  ...(await orig<typeof import("../../lib/queries/portfolio")>()),
  useOverview: (c: "EUR" | "USD") => ({ data: state.overview?.[c] }),
}));

import { HideAmountsProvider } from "../../lib/hideAmounts";
import { Currency } from "./Currency";

const fx = full as unknown as Record<string, { EUR: CurrencyDto & OverviewDto; USD: CurrencyDto & OverviewDto }>;
const cur = fx["GET /api/currency/both"];
const ov = fx["GET /api/overview/both"];

function mount(route = "/currency") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <HideAmountsProvider>
        <MemoryRouter initialEntries={[route]}>
          <Currency />
        </MemoryRouter>
      </HideAmountsProvider>
    </QueryClientProvider>,
  );
}

const tiles = () => document.querySelectorAll(".stat-strip__item");

beforeEach(() => {
  state.ccy = "EUR";
  state.both = cur;
  state.overview = ov;
});
afterEach(() => localStorage.clear());

describe("Currency page", () => {
  it("renders one tile per sent stat, with a tip each, except what the chart or What if shows", () => {
    mount();
    const elsewhere = ["rate_now", "avg_rate_vs_now", "lifetime_effect", "dollar_trend", "one_cent", "investing_power_today"];
    expect(tiles()).toHaveLength(cur.EUR.stats!.filter((s) => !elsewhere.includes(s.key)).length);
    expect(screen.queryByText("EUR/USD now")).not.toBeInTheDocument();
    expect(screen.getByText("Effect today")).toBeInTheDocument();
    expect(screen.queryByText("Investing power today")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "About Effect today" })).toBeInTheDocument();
  });

  it("shows the tailwind or headwind word, not only color", () => {
    // The fixture: EUR today and lifetime are headwinds (a weaker dollar); in the USD
    // view (investing) the euro's strength since the start is a tailwind.
    const eur = mount();
    expect(screen.getAllByText("Headwind").length).toBeGreaterThan(0);
    eur.unmount();
    state.ccy = "USD";
    mount();
    expect(screen.getAllByText("Tailwind").length).toBeGreaterThan(0);
  });

  it("leaves the strip out when no stats are sent, keeping the chart", () => {
    state.both = { EUR: { ...cur.EUR, stats: [] }, USD: { ...cur.USD, stats: [] } };
    mount();
    expect(tiles()).toHaveLength(0);
    expect(screen.getByTestId("rate-chart")).toBeInTheDocument();
  });

  it("EUR and USD have one shape: same tiles", () => {
    const eur = mount();
    const nEur = tiles().length;
    eur.unmount();
    state.ccy = "USD";
    mount();
    expect(tiles().length).toBe(nEur);
    expect(nEur).toBeGreaterThan(0);
  });

  it("USD view: the tiles read the investing side in dollars, the return gap beside", () => {
    state.ccy = "USD";
    mount();
    const strip = document.querySelector(".stat-strip")!;
    expect(strip.textContent).toMatch(/\$/);
    expect(strip.textContent).toMatch(/pp/);
    const usd = cur.USD.stats!.filter((s) => s.key.startsWith("effect_"));
    expect(usd.every((s) => s.unit === "money" && s.currency === "USD")).toBe(true);
    // The fraction beside the dollars is the euro lens, labelled as such (never a bare gap).
    const withLens = usd.filter((s) => s.secondary_unit === "fraction");
    expect(withLens.length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^Seen from euros/)).toHaveLength(withLens.length);
  });

  it("EUR view: the gap beside the euros is a signed one-digit pp, no lens label", () => {
    mount();
    const strip = document.querySelector(".stat-strip")!;
    expect(strip.textContent).not.toMatch(/Seen from euros/);
    for (const m of strip.textContent!.matchAll(/([+\-−]?\d+[.,]\d+) pp/g)) {
      expect(m[1]).toMatch(/^([+\-−]\d+[.,]\d|0[.,]0)$/);
    }
  });

  it("leads with the rate chart, then the strip", () => {
    mount();
    const chart = screen.getByTestId("rate-chart");
    const strip = document.querySelector(".stat-strip")!;
    expect(chart.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does not repeat the Overview's Currency card", () => {
    // Today's split lives on the Overview; this page shows only views the Overview has not.
    mount();
    expect(document.querySelector(".currency-box")).toBeNull();
  });
});

describe("fixtures", () => {
  it("overview currency.today equals currency/both today", () => {
    for (const c of ["EUR", "USD"] as const) {
      expect(cur[c].today).toEqual(ov[c].currency.today);
    }
  });
});
