import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PrefsProvider } from "../../lib/prefs";
import type { PeriodRowOut } from "../../lib/queries/reports";
import { groupByYear } from "./groupByYear";
import { PhoneYears } from "./PhoneYears";

const row = (label: string, over: Partial<PeriodRowOut> = {}) =>
  ({
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
  }) as PeriodRowOut;

afterEach(() => window.localStorage.clear());

function show() {
  const months = [row("2025-11"), row("2025-12", { dividends: "4" }), row("2026-01", { is_current: true, closing_value: "1234" })];
  const years = [row("2025", { closing_value: "1000", net_flow: "15", contributions: "20" }), row("2026", { is_current: true, closing_value: "1234" })];
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PrefsProvider>
        <PhoneYears groups={groupByYear(months, years)} currency="EUR" monthsOther={new Map()} yearOther={new Map()} />
      </PrefsProvider>
    </QueryClientProvider>,
  );
}

describe("Periods on a phone", () => {
  it("shows each year's total top-right and its growth figures, current year open", () => {
    show();
    const y2026 = document.querySelector('[data-year="2026"]') as HTMLElement;
    expect(within(y2026).getByText("Now")).toBeInTheDocument();
    expect(within(y2026).getByText("Growth (TWR)")).toBeInTheDocument();
    expect(within(y2026).getByText("XIRR")).toBeInTheDocument();
    // The current year starts open with its month; past years start folded.
    expect(within(y2026).getByText("January")).toBeInTheDocument();
    const y2025 = document.querySelector('[data-year="2025"]') as HTMLElement;
    expect(within(y2025).getByText("Year end")).toBeInTheDocument();
    expect(within(y2025).queryByText("December")).toBeNull();
  });

  it("unfolds a year and lists its months with only the non-zero chips", () => {
    show();
    const y2025 = document.querySelector('[data-year="2025"]') as HTMLElement;
    fireEvent.click(within(y2025).getByRole("button", { name: /2025, unfold/ }));
    const dec = y2025.querySelector('[data-period="2025-12"]') as HTMLElement;
    expect(within(dec).getByText("Div.")).toBeInTheDocument();
    // Net flow equals the contributions there, so it is not repeated.
    expect(within(dec).queryByText("Net flow")).toBeNull();
    const nov = y2025.querySelector('[data-period="2025-11"]') as HTMLElement;
    expect(within(nov).queryByText("Div.")).toBeNull();
    // The year itself had a withdrawal: its net flow differs, so it shows.
    expect(within(y2025).getByText("Net flow")).toBeInTheDocument();
  });
});
