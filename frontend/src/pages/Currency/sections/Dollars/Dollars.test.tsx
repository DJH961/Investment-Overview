import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JourneyBoth, JourneyView } from "../../../../lib/journey-types";
import { Dollars } from "./Dollars";

afterEach(() => vi.unstubAllGlobals());

const EUR_VIEW: JourneyView = {
  stats: {
    usd_account: { usd: "412.30", eur_cost: "356.95", eur_now: "354.18", currency_eur: "-2.77" },
    broker_cash: { usd: "1889.34", eur_cost: "1642.90", eur_now: "1623.02", currency_eur: "-19.88" },
    invested: { usd: "56857.83", eur_cost: "37100.00", eur_now: "48843.40", market_eur: "13873.41", currency_eur: "-2130.01" },
    your_rate: { rate: "1.1131", ecb_avg: "1.1167", now: "1.1641" },
  },
  bridge: {
    lines: [
      { key: "conversion_cost", eur: "-144.76" },
      { key: "waiting", eur: "-38.40" },
      { key: "cash", eur: "-19.88" },
      { key: "holdings", eur: "-2130.01" },
      { key: "realised", eur: "23.13" },
    ],
    total_eur: "-2309.92",
  },
  idle: [{ conversion_id: 29, date: "2026-05-04", usd: "412.30", days: 57 }],
  back_in_euros: { count: 1, eur_received: "2201.30", orig_eur: "1850.00", realised_eur: "351.30" },
  cash_outs: [],
  flagged: { uncovered_buys: 0, ecb_fallback_deposits: 0 },
};

const USD_VIEW: JourneyView = {
  ...EUR_VIEW,
  stats: {
    usd_account: { usd: "412.30", eur_cost: null, eur_now: null, currency_eur: null, usd_cost: "419.40" },
    broker_cash: { usd: "1889.34", eur_cost: null, eur_now: null, currency_eur: null, usd_cost: "1842.10" },
    invested: { usd: "56857.83", eur_cost: null, eur_now: null, currency_eur: null, market_eur: null, usd_cost: "44410.00", market_usd: "12447.83" },
    your_rate: EUR_VIEW.stats.your_rate,
  },
  bridge: null,
};

function mount(currency: "EUR" | "USD", both: JourneyBoth) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(both), { status: 200 })));
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <Dollars id="dollars" label="Your dollars" currency={currency} range="all" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Currency › Your dollars", () => {
  it("renders the four stats, stage bridge, back-in-euros summary, and idle callout in EUR view", async () => {
    mount("EUR", { eur: EUR_VIEW, usd: USD_VIEW });
    expect(await screen.findByText("USD account")).toBeInTheDocument();
    expect(screen.getAllByText("Broker cash").length).toBeGreaterThan(0);
    expect(screen.getByText("Invested")).toBeInTheDocument();
    expect(screen.getByText("Your rate")).toBeInTheDocument();
    expect(screen.getByText("1.1131")).toBeInTheDocument();
    expect(screen.getByText("Where your currency effect came from")).toBeInTheDocument();
    expect(screen.getByText("Currency effect, lifetime")).toBeInTheDocument();
    expect(screen.getByText(/One cash-out:/)).toBeInTheDocument();
    expect(screen.getByText(/waited over 30 days/)).toBeInTheDocument();
  });

  it("hides the EUR bridge and shows native USD lines in USD view", async () => {
    mount("USD", { eur: EUR_VIEW, usd: USD_VIEW });
    expect(await screen.findByText("not at the broker")).toBeInTheDocument();
    expect(screen.getByText("oldest 57 days")).toBeInTheDocument();
    expect(screen.queryByText("Where your currency effect came from")).not.toBeInTheDocument();
  });

  it("shows empty state when all dollar buckets are zero", async () => {
    const z = { usd: "0.00", eur_cost: "0.00", eur_now: "0.00", currency_eur: "0.00" };
    const empty: JourneyView = {
      stats: { usd_account: z, broker_cash: z, invested: { ...z, market_eur: "0.00" }, your_rate: { rate: null, ecb_avg: null, now: "1.16" } },
      bridge: null,
      idle: [],
      back_in_euros: null,
      cash_outs: [],
      flagged: { uncovered_buys: 0, ecb_fallback_deposits: 0 },
    };
    mount("EUR", { eur: empty, usd: empty });
    expect(await screen.findByText("No dollars yet")).toBeInTheDocument();
  });
});
