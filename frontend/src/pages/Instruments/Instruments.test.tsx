import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/Toast";
import type { Instrument } from "../../lib/queries/instruments";
import { buildPatch, fractionToPercent, Instruments, percentToFraction, twinSuggestionText } from "./Instruments";

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
    const base = { name: "Total World", asset_class: "etf", expense_ratio: "0.06", category: "", active: true, provider_symbol: "", pricing_mode: "auto" as const, intraday_twin: "" };
    expect(buildPatch(vt, base)).toEqual({});
    expect(buildPatch(vt, { ...base, name: "", expense_ratio: "0.07", provider_symbol: "vt.de" })).toEqual({
      name: null,
      expense_ratio: "0.0007",
      provider_symbol: "VT.DE",
    });
  });

  it("patches the ETF twin (uppercased) and clears it when emptied", () => {
    const base = { name: "Total World", asset_class: "etf", expense_ratio: "0.06", category: "", active: true, provider_symbol: "", pricing_mode: "auto" as const };
    expect(buildPatch(vt, { ...base, intraday_twin: "vti" })).toEqual({ intraday_twin: "VTI" });
    expect(buildPatch({ ...vt, intraday_twin: "VTI" }, { ...base, intraday_twin: "" })).toEqual({ intraday_twin: null });
    expect(buildPatch({ ...vt, intraday_twin: "VTI" }, { ...base, intraday_twin: "vti" })).toEqual({});
  });
});

const fskax: Instrument = {
  ...vt,
  id: 7,
  symbol: "FSKAX",
  name: "Fidelity Total Market",
  asset_class: "mutual_fund",
  ledger_asset_class: "mutual_fund",
  twin_suggestion: { etf: "VTI", tier: "close", index: "CRSP US Total Market", typical_daily_gap: "0.0004" },
};

describe("twinSuggestionText", () => {
  it("says whether the index is the same or only close, with the measured gap", () => {
    expect(twinSuggestionText({ etf: "VOO", tier: "same_index", index: "S&P 500" })).toBe("VOO tracks the same index (S&P 500).");
    expect(twinSuggestionText(fskax.twin_suggestion!)).toBe(
      "VTI follows a different index (CRSP US Total Market) but moves with it closely, typically 0.04% apart per day.",
    );
  });
});

describe("Instruments twin editor", () => {
  it("shows the suggestion, fills it on one tap and saves it", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH")
        return new Response(
          JSON.stringify({ instrument: { ...fskax, intraday_twin: "VTI" }, changed: ["intraday_twin"], redownload_suggested: false }),
          { status: 200 },
        );
      return new Response(JSON.stringify([vt, fskax]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAt("/instruments?id=7");
    expect(await screen.findByRole("dialog", { name: "Edit FSKAX" })).toBeInTheDocument();
    expect(screen.getByTestId("twin-suggestion")).toHaveTextContent("VTI follows a different index");
    await userEvent.click(screen.getByRole("button", { name: "Use VTI" }));
    expect(screen.getByLabelText("ETF twin (1D estimate)")).toHaveValue("VTI");
    expect(screen.queryByTestId("twin-suggestion")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const patch = fetchMock.mock.calls.find(([, i]) => i?.method === "PATCH");
    expect(JSON.parse(String(patch![1]!.body))).toEqual({ intraday_twin: "VTI" });
  });

  it("hides the twin field for a plain ETF with no twin", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([vt]), { status: 200 })));
    renderAt("/instruments?id=3");
    await screen.findByRole("dialog", { name: "Edit VT" });
    expect(screen.queryByLabelText("ETF twin (1D estimate)")).toBeNull();
  });

  it("lists a suggestion in the table that opens the editor", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([vt, fskax]), { status: 200 })));
    renderAt("/instruments");
    await userEvent.click(await screen.findByRole("button", { name: "Set a twin for FSKAX (suggested VTI)" }));
    expect(await screen.findByRole("dialog", { name: "Edit FSKAX" })).toBeInTheDocument();
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
