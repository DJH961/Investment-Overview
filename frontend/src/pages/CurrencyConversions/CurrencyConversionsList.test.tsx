import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/Toast";
import { CurrencyConversions } from "./CurrencyConversions";

const conv = (id: number, date: string, provider: string, remaining = "0") => ({
  id,
  date,
  eur_sent: "900.00",
  usd_received: "1000.00",
  fees_eur: null,
  note: null,
  effective_rate: "1.1111",
  from_ccy: "EUR",
  to_ccy: "USD",
  provider,
  rate: "1.1111",
  all_in_rate: "1.1111",
  ecb_rate: "1.1200",
  ecb_rate_date: date,
  off_pct: "-0.0080",
  used_by: remaining === "0" ? [{ deposit_id: id, date, usd: "1000.00", eur: "900.00", pinned: false }] : [],
  remaining_usd: remaining,
});

const CONVERSIONS = [
  conv(1, "2026-06-20", "wise"),
  conv(2, "2026-05-11", "revolut"),
  conv(3, "2026-03-04", "wise", "1000.00"),
  conv(4, "2024-07-07", "wise"),
];
const dep = (id: number, date: string, status: string) => ({
  transaction_id: id,
  date,
  usd: "1000.00",
  status,
  slices: [],
  pinned: false,
  fallback_usd: status === "matched" ? null : "1000.00",
  fallback_eur: null,
  fallback_rate: null,
  fallback_rate_date: null,
  effective_rate: "1.1",
});
const POOL = {
  balance_eur: "900",
  balance_usd: "1000",
  deposits: [dep(1, "2026-06-21", "matched"), dep(2, "2026-05-12", "ecb_only"), dep(4, "2024-07-08", "partial")],
  fallbacks: [],
  remaining: [],
};

function renderAt(url: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string) => new Response(JSON.stringify(u.includes("pool") ? POOL : CONVERSIONS), { status: 200 })),
  );
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter initialEntries={[url]}>
          <CurrencyConversions />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-01T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("CurrencyConversions folds and filters", () => {
  it("opens the two newest months, folds the rest and renders only open groups", async () => {
    renderAt("/conversions");
    // One list per open month.
    expect(await screen.findAllByRole("list", { name: "Currency conversions" })).toHaveLength(2);
    // June and May are open (their rows are there); March and the 2024 year are folded.
    expect(screen.getAllByRole("button", { name: /June 2026/ })[0]).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("button", { name: /May 2026/ })[0]).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("button", { name: /March 2026/ })[0]).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("conversion-1")).not.toBeNull();
    expect(document.getElementById("conversion-3")).toBeNull();
    expect(document.getElementById("conversion-4")).toBeNull();
    // Opening a month renders its rows, and the choice is remembered.
    fireEvent.click(screen.getAllByRole("button", { name: /March 2026/ })[0]);
    expect(document.getElementById("conversion-3")).not.toBeNull();
    expect(localStorage.getItem("iv.conversions.folds") ?? localStorage.getItem("conversions.folds")).toContain("true");
  });

  it("opens the folds of a row a link points at", async () => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    renderAt("/conversions#conversion-4");
    // The 2024 row sits in a folded year: the link opens the year and the month.
    expect(document.getElementById("conversion-4")).toBeNull();
    await vi.waitFor(() => expect(document.getElementById("conversion-4")).not.toBeNull());
  });

  it("filters by provider from the address and says how many it shows", async () => {
    renderAt("/conversions?provider=revolut");
    expect(await screen.findByText(/Showing 1 of 4/)).toBeInTheDocument();
    expect(document.getElementById("conversion-2")).not.toBeNull();
    expect(document.getElementById("conversion-1")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0]);
    expect(await screen.findByText(/4 conversions/)).toBeInTheDocument();
  });

  it("filters the deposits to those that need attention, with every group open", async () => {
    renderAt("/conversions?needs=1");
    expect(await screen.findByText(/Showing 2 of 3/)).toBeInTheDocument();
    expect(document.getElementById("deposit-1")).toBeNull();
    expect(document.getElementById("deposit-2")).not.toBeNull();
    expect(document.getElementById("deposit-4")).not.toBeNull();
    // A folded deposit row opens to its detail.
    const row = document.getElementById("deposit-2") as HTMLElement;
    fireEvent.click(within(row).getByRole("button"));
    expect(within(row).getByText(/ECB rate/)).toBeInTheDocument();
  });
});
