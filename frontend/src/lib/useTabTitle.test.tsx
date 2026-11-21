import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setHideAmounts } from "./format";
import { tabTitle, useTabTitle } from "./useTabTitle";
import type { OverviewDto } from "./queries/portfolio";

const kpis = (extra: Record<string, unknown> = {}) =>
  ({ total_value: "123400", daily_growth_pct: "0.0042", ...extra }) as unknown as OverviewDto["kpis"];

beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "visibilityState");
  setHideAmounts(false);
});

describe("tabTitle", () => {
  it("official book: compact total, arrow and absolute percent", () => {
    expect(tabTitle(kpis(), "EUR", false, "Investment Overview")).toBe("€123.4k ▲0.42%");
    expect(tabTitle(kpis({ daily_growth_pct: "-0.0042" }), "EUR", false, "x")).toBe("€123.4k ▼0.42%");
  });
  it("estimating: ≈ prefix and the estimated total and move", () => {
    const est = { total_value: "125000", daily_growth_pct: "0.01", daily_move: "1", funds: [], adjustment: "1600" };
    expect(tabTitle(kpis({ estimate: est }), "EUR", false, "x")).toBe("≈€125.0k ▲1.00%");
  });
  it("neutral when amounts are hidden or there is no data", () => {
    expect(tabTitle(kpis(), "EUR", true, "Investment Overview")).toBe("Investment Overview");
    expect(tabTitle(undefined, "EUR", false, "Investment Overview")).toBe("Investment Overview");
  });
});

describe("useTabTitle", () => {
  it("sets the title from the cached overview and restores the original on unmount", () => {
    document.title = "Investment Overview";
    const qc = new QueryClient();
    const one = { kpis: kpis(), secondary_ccy: "USD" };
    qc.setQueryData(["overview", "both"], { EUR: one, USD: one });
    function Probe() {
      useTabTitle("EUR");
      return null;
    }
    const wrap = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { unmount } = render(<Probe />, { wrapper: wrap });
    expect(document.title).toBe("€123.4k ▲0.42%");
    unmount();
    expect(document.title).toBe("Investment Overview");
  });

  it("hides portfolio figures when the page is hidden or loses focus, then restores them", () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.title = "Investment Overview";
    const amountTitle = tabTitle(kpis(), "EUR", false, "Investment Overview");
    const qc = new QueryClient();
    const one = { kpis: kpis(), secondary_ccy: "USD" };
    qc.setQueryData(["overview", "both"], { EUR: one, USD: one });
    function Probe() {
      useTabTitle("EUR");
      return null;
    }
    const wrap = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { unmount } = render(<Probe />, { wrapper: wrap });
    expect(document.title).toBe("Investment Overview");

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(document.title).toBe(amountTitle);

    window.dispatchEvent(new Event("blur"));
    expect(document.title).toBe("Investment Overview");
    window.dispatchEvent(new Event("focus"));
    expect(document.title).toBe(amountTitle);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(document.title).toBe("Investment Overview");
    unmount();
    expect(document.title).toBe("Investment Overview");
  });

  it("a remount never captures figures as the neutral title (sign-out leak)", () => {
    document.title = "€999k ▲1.00%"; // left over from a previous shell mount
    const qc = new QueryClient();
    function Probe() {
      useTabTitle("EUR");
      return null;
    }
    const wrap = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { unmount } = render(<Probe />, { wrapper: wrap });
    expect(document.title).toBe("Investment Overview");
    unmount();
    expect(document.title).toBe("Investment Overview");
  });
});
