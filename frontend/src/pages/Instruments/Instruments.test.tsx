import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/Toast";
import type { Instrument } from "../../lib/queries/instruments";
import { buildPatch, fractionToPercent, Instruments, percentToFraction } from "./Instruments";

vi.mock("../../lib/shell", () => ({ useShellStatus: () => undefined }));

const vt: Instrument = {
  id: 3,
  symbol: "VT",
  name: "Total World",
  ledger_name: "Total World",
  name_override: null,
  asset_class: "etf",
  ledger_asset_class: "etf",
  asset_class_override: null,
  native_currency: "USD",
  expense_ratio: "0.0006",
  expense_ratio_override: null,
  category: null,
  active: true,
  provider_symbol: null,
  fetch_symbol: "VT",
  pricing_mode: "auto",
  transaction_count: 4,
  latest_price_date: "2026-01-05",
};

function renderAt(path: string) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Instruments />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("percent helpers", () => {
  it("converts without float noise", () => {
    expect(percentToFraction("0.07")).toBe("0.0007");
    expect(percentToFraction("1.5")).toBe("0.015");
    expect(percentToFraction("12")).toBe("0.12");
    expect(fractionToPercent("0.0003")).toBe("0.03");
    expect(fractionToPercent("0.015")).toBe("1.5");
    expect(fractionToPercent(null)).toBe("");
  });

  it("patches only changed fields and clears emptied ones", () => {
    const base = { name: "Total World", asset_class: "etf", expense_ratio: "0.06", category: "", active: true, provider_symbol: "", pricing_mode: "auto" as const };
    expect(buildPatch(vt, base)).toEqual({});
    expect(buildPatch(vt, { ...base, name: "", expense_ratio: "0.07", provider_symbol: "vt.de" })).toEqual({
      name: null,
      expense_ratio: "0.0007",
      provider_symbol: "VT.DE",
    });
  });
});

describe("Instruments", () => {
  it("opens the editor from ?id= and offers the price re-download", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH")
        return new Response(
          JSON.stringify({ instrument: { ...vt, provider_symbol: "VT.L" }, changed: ["provider_symbol"], redownload_suggested: true }),
          { status: 200 },
        );
      if (String(url).includes("/api/maintenance/jobs/prices.redownload")) return new Response(JSON.stringify({ id: "r1" }), { status: 202 });
      return new Response(JSON.stringify([vt]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAt("/instruments?id=3");
    expect(await screen.findByRole("dialog", { name: "Edit VT" })).toBeInTheDocument();
    expect(screen.getByLabelText("Expense ratio (% per year)")).toHaveValue("0.06");
    await userEvent.type(screen.getByLabelText("Provider symbol"), "VT.L");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const patch = fetchMock.mock.calls.find(([, i]) => i?.method === "PATCH");
    expect(JSON.parse(String(patch![1]!.body))).toEqual({ provider_symbol: "VT.L" });
    await userEvent.click(await screen.findByRole("button", { name: "Re-download prices" }));
    const job = fetchMock.mock.calls.find(([u]) => String(u).includes("prices.redownload"));
    expect(JSON.parse(String(job![1]!.body))).toEqual({ params: { instrument_id: 3 }, confirm: "yes" });
  });
});
