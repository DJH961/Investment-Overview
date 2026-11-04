import { render as rtlRender, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toNum } from "../../lib/queries/portfolio";

const empty = {
  as_of: "2026-10-30",
  ccy: "EUR",
  generated_at: "2026-10-30T20:00:00Z",
  is_live: false,
  position_count: 0,
  warnings: { zero_value: [], bad_history: [], missing_fx: [] },
};
const populated = {
  ...empty,
  position_count: 3,
  fx_eur_usd: "1.0800",
  kpis: { total_value: "1234567.89", daily_move: "-12.5" },
  currency: { return_split: { currency_effect_pp: "0.01" }, today: { rate_move_pct: "0.001" } },
  movers: { basis_date: "2026-10-30", winners: [], losers: [] },
};
let overview: Record<string, unknown> | undefined = empty;
let overviewError = false;
const idle = { data: undefined, isPending: true, isError: false, isFetching: false, refetch: vi.fn() };

vi.mock("../../lib/queries/portfolio", async (orig) => ({
  ...(await orig<typeof import("../../lib/queries/portfolio")>()),
  useOverview: () => ({
    ...idle,
    data: overview,
    isPending: false,
    isError: overviewError,
    error: overviewError ? new Error("Can't reach the server.") : null,
  }),
  useHoldings: () => idle,
  useAllocations: () => idle,
  useGraph: () => idle,
}));
vi.mock("../../lib/prefs", () => ({ usePrefs: () => ({ currency: "EUR" }) }));
vi.mock("../../lib/shell", () => ({ useShellStatus: () => undefined, useShellSummary: () => undefined }));
vi.mock("../../lib/timezone", () => ({ useTimeZone: () => "UTC" }));

import { ToastProvider } from "../../components/Toast";
import { HideAmountsProvider } from "../../lib/hideAmounts";
import { Overview } from "./Overview";

const render = (ui: ReactElement) =>
  rtlRender(
    <MemoryRouter>
      <ToastProvider>{ui}</ToastProvider>
    </MemoryRouter>,
  );

afterEach(() => {
  overview = empty;
  overviewError = false;
  localStorage.clear();
});

describe("Overview page", () => {
  it("keeps the cached overview on screen when a refetch fails (offline)", () => {
    overview = empty;
    overviewError = true;
    render(<Overview />);
    expect(screen.getByText("No positions yet")).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).toBeNull();
  });
  it("shows the error when there is nothing cached", () => {
    overview = undefined;
    overviewError = true;
    render(<Overview />);
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });
  it("shows the empty state without positions", () => {
    render(<Overview />);
    expect(screen.getByText("No positions yet")).toBeInTheDocument();
  });
  it("parses decimal strings for display", () => {
    expect(toNum("1.5")).toBe(1.5);
    expect(toNum(null)).toBeNull();
  });
  it("renders every section as a collapsible card that remembers its state", async () => {
    overview = populated;
    const { unmount } = render(<Overview />);
    for (const name of ["Currency · EUR ↔ USD", "Holdings", "Currency effect (lifetime)", "Value", "Top movers", "Allocation", "Asset classes"]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute("aria-expanded", "true");
    }
    expect(screen.getByText("Portfolio value")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Top movers" }));
    expect(localStorage.getItem("iv.fold.overview.movers")).toBe("false");
    unmount();
    render(<Overview />);
    expect(screen.getByRole("button", { name: "Top movers" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Value" })).toHaveAttribute("aria-expanded", "true");
  });

  it("hide mode masks the total and the day move", () => {
    overview = populated;
    localStorage.setItem("iv.privacy.hideAmounts", "true");
    const { container } = render(
      <HideAmountsProvider>
        <Overview />
      </HideAmountsProvider>,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("••,•••");
    expect(text).not.toMatch(/1,234,567|1\.2M|1234567|12\.50/);
  });
});
