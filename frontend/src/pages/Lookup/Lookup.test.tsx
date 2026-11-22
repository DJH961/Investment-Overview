import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/queries/lookup", async (orig) => ({
  ...(await orig<typeof import("../../lib/queries/lookup")>()),
  useLookupQuote: (symbol: string) => ({
    data: {
      symbol,
      name: "Fakequity Holdings Corp.",
      exchange: "NASDAQ",
      type: "Stock",
      currency: "USD",
      price_native: "412.37",
      day_change_native: "3.10",
      day_pct: "0.0076",
      captured_at: "2026-10-30T18:15:00+00:00",
      week52_low: "301.20",
      week52_high: "455.90",
      fx_eur_usd: "1.08",
      last_held_on: symbol === "SOLDQ" ? "2026-03-04" : null,
    },
    isPending: false,
    isError: false,
  }),
  useLookupHistory: () => ({
    data: {
      symbol: "FAKEQ",
      currency: "USD",
      range: "1y",
      x_mode: "date",
      sessions: [],
      points: [
        { t: "2026-10-29", price_native: "400", fx_eur_usd: "1.08" },
        { t: "2026-10-30", price_native: "412.37", fx_eur_usd: "1.10" },
      ],
    },
    isPending: false,
    isFetching: false,
    isError: false,
  }),
}));

vi.mock("../../lib/prefs", () => ({ usePrefs: () => ({ currency: "EUR" }) }));

import { convertAt, Lookup } from "./Lookup";

function renderAt(entry: string | { pathname: string; state?: unknown }) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/lookup/:symbol/:tab?" element={<Lookup />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Lookup (not held)", () => {
  it("a sold instrument says when it was held until and links to its transactions", () => {
    renderAt("/lookup/SOLDQ");
    expect(screen.getByText(/You held this until/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See its transactions" })).toHaveAttribute("href", "/transactions?symbol=SOLDQ");
  });

  it("a never-held instrument shows no sold line", () => {
    renderAt("/lookup/FAKEQ");
    expect(screen.queryByText(/You held this until/)).toBeNull();
  });

  it("says Not held and offers only Performance and Details, no position tabs", () => {
    renderAt("/lookup/FAKEQ");
    expect(screen.getByText("Not held")).toBeInTheDocument();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Performance", "Details"]);
    for (const tab of ["Tranches", "Transactions", "Dividends", "Twin"]) expect(screen.queryByRole("tab", { name: tab })).toBeNull();
    // Follows the app's EUR / USD switch (EUR here): no local currency switch.
    expect(screen.queryByRole("radio", { name: "EUR" })).toBeNull();
    expect(screen.getByText(/Each point in EUR/)).toBeInTheDocument();
    expect(screen.queryByText("Unrealised gain")).toBeNull();
  });

  it("Details shows exchange, currency, type and the 52-week range", () => {
    renderAt("/lookup/FAKEQ/details");
    expect(screen.getByText("NASDAQ", { selector: "dd" })).toBeInTheDocument();
    expect(screen.getByText("52-week range")).toBeInTheDocument();
    expect(screen.getByText(/301\.20.*455\.90/)).toBeInTheDocument();
  });

  it("converts each point at its own rate", () => {
    expect(convertAt(110, "USD", "EUR", 1.1)).toBeCloseTo(100);
    expect(convertAt(100, "EUR", "USD", 1.1)).toBeCloseTo(110);
    expect(convertAt(100, "USD", "USD", null)).toBe(100);
    expect(convertAt(100, "USD", "EUR", null)).toBeNull();
  });

  it("defaults Back link to Holdings and preserves origin state across tabs", () => {
    const direct = renderAt("/lookup/FAKEQ");
    expect(screen.getByRole("link", { name: "Holdings" })).toHaveAttribute("href", "/holdings");
    direct.unmount();

    renderAt({ pathname: "/lookup/FAKEQ", state: { from: { to: "/overview", label: "Overview" } } });
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/overview");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Details" }));
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/overview");
  });
});
