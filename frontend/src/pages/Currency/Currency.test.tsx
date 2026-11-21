import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
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
vi.mock("../../components/RateChart", () => ({ RateChart: () => null }));
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

import { CurrencyBox } from "../../components/CurrencyBox";
import { HideAmountsProvider } from "../../lib/hideAmounts";
import { Currency } from "./Currency";

const fx = full as unknown as Record<string, { EUR: CurrencyDto & OverviewDto; USD: CurrencyDto & OverviewDto }>;
const cur = fx["GET /api/currency/both"];
const ov = fx["GET /api/overview/both"];

function mount(route = "/currency") {
  return render(
    <HideAmountsProvider>
      <MemoryRouter initialEntries={[route]}>
        <Currency />
      </MemoryRouter>
    </HideAmountsProvider>,
  );
}

const tiles = () => document.querySelectorAll(".stat-strip__item");
const rows = () => document.querySelectorAll(".currency-page__row");

beforeEach(() => {
  state.ccy = "EUR";
  state.both = cur;
  state.overview = ov;
});
afterEach(() => localStorage.clear());

describe("Currency page", () => {
  it("renders one tile per sent stat, with a tip each, except the rate (the chart's headline)", () => {
    mount();
    expect(tiles()).toHaveLength(cur.EUR.stats!.filter((s) => s.key !== "rate_now" && s.key !== "avg_rate_vs_now").length);
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

  it("leaves the strip out when no stats are sent", () => {
    state.both = { EUR: { ...cur.EUR, stats: [] }, USD: { ...cur.USD, stats: [] } };
    mount();
    expect(tiles()).toHaveLength(0);
    expect(screen.getByTestId("today-buys")).toBeInTheDocument();
  });

  it("EUR and USD have one shape: same tiles and same Today rows", () => {
    const eur = mount();
    const nEur = tiles().length;
    const rEur = rows().length;
    eur.unmount();
    state.ccy = "USD";
    mount();
    expect(tiles().length).toBe(nEur);
    expect(rows().length).toBe(rEur);
    expect(rEur).toBeGreaterThan(0);
  });

  it("prints the regular amount and what it buys", () => {
    mount();
    const buys = screen.getByTestId("today-buys");
    expect(within(buys).getByText(/100 euros buy/)).toBeInTheDocument();
    expect(buys.textContent).toContain("yesterday");
  });

  it("unknown ?view= falls back to Today", () => {
    mount("/currency?view=nonsense");
    // One view only: no view switch is shown (it returns with a second view).
    expect(screen.queryByLabelText("Currency views")).toBeNull();
    expect(screen.getByTestId("today-buys")).toBeInTheDocument();
  });

  it("shows the same box as the Overview card for the same today block", () => {
    for (const c of ["EUR", "USD"] as const) {
      state.ccy = c;
      const page = mount();
      const pageBox = page.container.querySelector(".currency-box")?.textContent;
      page.unmount();
      const ovBox = render(
        <HideAmountsProvider>
          <CurrencyBox data={ov[c]} />
        </HideAmountsProvider>,
      );
      expect(pageBox).toBeTruthy();
      expect(pageBox).toBe(ovBox.container.querySelector(".currency-box")?.textContent);
      ovBox.unmount();
    }
  });
});

describe("fixtures", () => {
  it("overview currency.today equals currency/both today", () => {
    for (const c of ["EUR", "USD"] as const) {
      expect(cur[c].today).toEqual(ov[c].currency.today);
    }
  });
});
