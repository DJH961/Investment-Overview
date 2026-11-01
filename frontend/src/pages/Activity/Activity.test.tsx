import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../lib/prefs", () => ({ usePrefs: () => ({ currency: "EUR" }) }));
vi.mock("../../lib/shell", () => ({ useShellStatus: () => undefined }));

import { Activity } from "./Activity";

afterEach(() => vi.unstubAllGlobals());

const row = (over: Record<string, unknown>) => ({
  id: 1,
  date: "2025-03-10",
  account: "Main",
  kind: "deposit",
  amount_native: "1000",
  currency: "USD",
  amount: "800",
  description: "",
  effective_rate: null,
  rate_source: null,
  conversion_batches: [],
  ...over,
});

describe("Activity", () => {
  it("shows the conversion batch or the ECB rate for each deposit", async () => {
    const body = {
      ccy: "EUR",
      as_of: "2025-05-01",
      summary: { total_contrib: "1300", ytd_contrib: "1300", mtd_contrib: "0", total_contrib_native: "1500" },
      rows: [
        row({
          effective_rate: "1.25",
          rate_source: "conversions",
          conversion_batches: [{ conversion_id: 1, date: "2025-03-01", usd: "1000", eur: "800" }],
        }),
        row({ id: 2, date: "2025-04-10", amount_native: "500", rate_source: "ecb" }),
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <Activity />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/Conversion .*1\.2500 USD\/EUR/)).toBeInTheDocument();
    expect(screen.getByText("ECB rate")).toBeInTheDocument();
  });
});
