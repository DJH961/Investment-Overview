import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecapDto, RecapSideDto } from "../../lib/queries/recap";
import { RecapCard, recapFacts, recapTitle } from "./RecapCard";

afterEach(() => vi.unstubAllGlobals());

const eur: RecapSideDto = {
  contributed: "1300",
  cashed_out: "0",
  market: "68.4",
  currency: "34.1",
  dividends: "0",
  interest: "0",
  conversion_cost: "5.46",
  conversions: 1,
  opening_value: "47460",
  closing_value: "48862",
  nominal_return: "0.0023",
  real_return: "0.0003",
  real_to: "2026-05",
};
const usd: RecapSideDto = {
  ...eur,
  contributed: "1487",
  market: "726",
  currency: "0",
  conversion_cost: "5.9",
  real_return: null,
  real_to: null,
  closing_value: "56685",
  nominal_return: "0.0132",
};
const recap: RecapDto = {
  period: "2026-05",
  granularity: "month",
  start: "2026-05-01",
  end: "2026-05-31",
  is_complete: true,
  has_data: true,
  due: true,
  default_period: "2026-05",
  last_ack: null,
  EUR: eur,
  USD: usd,
};

const keys = (side: RecapSideDto, ccy: "EUR" | "USD") => recapFacts(side, ccy).map((f) => f.key);

describe("recapFacts", () => {
  it("shows the euro story in euros, an even count", () => {
    expect(keys(eur, "EUR")).toEqual(["return", "real", "contributed", "market", "currency", "cost"]);
  });

  it("shows dollars only in the dollar view, padded to an even count with the value", () => {
    expect(keys(usd, "USD")).toEqual(["return", "value", "contributed", "market"]);
  });

  it("hides cashed out while 0 and conversion cost without conversions", () => {
    const k = keys({ ...eur, conversion_cost: null, conversions: 0 }, "EUR");
    expect(k).not.toContain("cost");
    expect(k).not.toContain("cashed-out");
    expect(k.length % 2).toBe(0);
    expect(keys({ ...eur, cashed_out: "900" }, "EUR")).toContain("cashed-out");
  });

  it("labels the real return with the last index month, or says the index is not out", () => {
    const real = (side: RecapSideDto) => recapFacts(side, "EUR").find((f) => f.key === "real")?.label;
    expect(real(eur)).toBe("Real · to May 2026");
    expect(real({ ...eur, real_return: null, real_to: null })).toBe("Real · index not out");
  });

  it("names dividends when there were some", () => {
    expect(keys({ ...eur, dividends: "12" }, "EUR")).toContain("dividends");
  });
});

describe("recapTitle", () => {
  it("names the month or the year", () => {
    expect(recapTitle("2026-10")).toBe("October 2026 in review");
    expect(recapTitle("2025")).toBe("2025 in review");
  });
});

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("RecapCard", () => {
  it("on the Overview: shown when due, dismiss posts the ack and hides it", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body });
        const body = url.includes("/ack") ? { last_ack: "2026-05" } : recap;
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
    wrap(<RecapCard currency="EUR" place="overview" />);
    expect(await screen.findByTestId("recap-title")).toHaveTextContent("May 2026 in review");
    expect(screen.getByTestId("recap-cost")).toHaveTextContent("-€5.46");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss the recap" }));
    await waitFor(() => expect(screen.queryByTestId("recap-card")).toBeNull());
    const ack = calls.find((c) => c.url.includes("/api/recap/ack"));
    expect(String(ack?.body)).toContain("2026-05");
  });

  it("on the Overview: nothing when not due", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ...recap, due: false }), { status: 200, headers: { "Content-Type": "application/json" } })),
    );
    const { container } = wrap(<RecapCard currency="EUR" place="overview" />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(container.querySelector(".recap-card")).toBeNull();
  });

  it("on Periods: always shown, without a dismiss, with a stepper", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ...recap, due: false }), { status: 200, headers: { "Content-Type": "application/json" } })),
    );
    const onPeriod = vi.fn();
    wrap(
      <RecapCard currency="USD" place="periods" periods={{ month: ["2026-04", "2026-05"], year: [] }} onPeriod={onPeriod} />,
    );
    await screen.findByTestId("recap-card");
    expect(screen.queryByRole("button", { name: "Dismiss the recap" })).toBeNull();
    expect(screen.queryByTestId("recap-real")).toBeNull();
    expect(screen.getByRole("button", { name: "Next period" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Previous period" }));
    expect(onPeriod).toHaveBeenCalledWith("2026-04");
  });
});
