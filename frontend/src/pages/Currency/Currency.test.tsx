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
  it("renders one tile per sent stat, with a tip each, except the rate (the chart's headline)", () => {
    mount();
    expect(tiles()).toHaveLength(
      cur.EUR.stats!.filter((s) => !["rate_now", "avg_rate_vs_now", "lifetime_effect"].includes(s.key)).length,
    );
    expect(screen.queryByText("EUR/USD now")).not.toBeInTheDocument();
    expect(screen.getByText("Effect today")).toBeInTheDocument();
    expect(screen.queryByText("Investing power today")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "About Effect today" })).toBeInTheDocument();
  });

  it("shows the tailwind or headwind word, not only colour", () => {
    // The fixture's EUR view is all headwinds; its USD view carries the tailwind.
    const eur = mount();
    expect(screen.getAllByText("Headwind").length).toBeGreaterThan(0);
    eur.unmount();
    state.ccy = "USD";
    mount();
    expect(screen.getByText("Tailwind")).toBeInTheDocument();
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
