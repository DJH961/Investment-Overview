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

function show(months: PeriodRowOut[], years: PeriodRowOut[]) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PrefsProvider>
        <PhoneYears groups={groupByYear(months, years)} currency="EUR" monthsOther={new Map()} yearOther={new Map()} />
      </PrefsProvider>
    </QueryClientProvider>,
  );
}

const showDefault = () =>
  show(
    [row("2025-11"), row("2025-12", { dividends: "4" }), row("2026-01", { is_current: true, closing_value: "1234" })],
    [row("2025", { closing_value: "1000", net_flow: "15", contributions: "20" }), row("2026", { is_current: true, closing_value: "1234" })],
  );

describe("Periods on a phone", () => {
  it("shows each year's total top-right and its growth figures, current year open", () => {
    showDefault();
    const y2026 = document.querySelector('[data-year="2026"]') as HTMLElement;
    expect(within(y2026).getByText("Now")).toBeInTheDocument();
    expect(within(y2026).getByText("Growth (TWR)")).toBeInTheDocument();
    expect(within(y2026).getByText("XIRR")).toBeInTheDocument();
    // The current year starts open with its month; past years start folded.
    expect(within(y2026).getByText("January")).toBeInTheDocument();
    const y2025 = document.querySelector('[data-year="2025"]') as HTMLElement;
    expect(within(y2025).getByText("Year end")).toBeInTheDocument();
    expect(within(y2025).queryByText("December")).toBeNull();
    // Folded: no flow figures.
    expect(within(y2025).queryByText("Dividends")).toBeNull();
  });

  it("unfolds a year and discloses a month's four figures on tap, one at a time", () => {
    showDefault();
    const y2025 = document.querySelector('[data-year="2025"]') as HTMLElement;
    fireEvent.click(within(y2025).getByRole("button", { name: /2025, unfold/ }));
    // The year itself shows its four flow figures once expanded.
    for (const l of ["In", "Net flow", "Cashed out", "Dividends"]) expect(within(y2025).getAllByText(l)).toHaveLength(1);
    const dec = y2025.querySelector('[data-period="2025-12"]') as HTMLElement;
    expect(within(dec).queryByText("Dividends")).toBeNull();
    fireEvent.click(within(dec).getByRole("button"));
    expect(within(dec).getByText("Dividends")).toBeInTheDocument();
    expect(within(dec).getByText("Cashed out")).toBeInTheDocument();
    const nov = y2025.querySelector('[data-period="2025-11"]') as HTMLElement;
    fireEvent.click(within(nov).getByRole("button"));
    expect(within(nov).getByText("Net flow")).toBeInTheDocument();
    expect(within(dec).queryByText("Net flow")).toBeNull();
  });

  it("shows a cashed-out amount in the expanded month", () => {
    show(
      [row("2026-01", { is_current: true }), row("2026-03", { cashed_out_eur: "2201.30", cashed_out: "2201.30" } as Partial<PeriodRowOut>)],
      [row("2026", { is_current: true })],
    );
    const mar = document.querySelector('[data-period="2026-03"]') as HTMLElement;
    fireEvent.click(within(mar).getByRole("button"));
    expect(within(mar).getByText(/2,201/)).toBeInTheDocument();
  });
});
