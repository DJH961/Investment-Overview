import { afterEach, describe, expect, it } from "vitest";
import { prefetchPlan } from "./prefetch";

afterEach(() => localStorage.clear());

const keyOf = (o: { queryKey: readonly unknown[] }) =>
  o.queryKey.map((k) => (typeof k === "object" ? JSON.stringify(k) : String(k))).join("/");

describe("prefetchPlan", () => {
  it("loads Overview first, then the remembered range, then the rest", () => {
    localStorage.setItem("iv.chart.overview.range", JSON.stringify("1y"));
    const keys = prefetchPlan("EUR").map(keyOf);
    expect(keys[0]).toBe("overview/EUR");
    expect(keys[1]).toBe("graphs/1y/EUR");
    expect(keys).toContain("holdings/EUR/none");
    expect(keys.filter((k) => k.startsWith("graphs/") && k.endsWith("/EUR"))).toHaveLength(8);
    expect(keys.filter((k) => k === "graphs/1y/EUR")).toHaveLength(1);
  });

  it("warms every nav page for both currencies, current currency first", () => {
    const keys = prefetchPlan("USD").map(keyOf);
    expect(keys[0]).toBe("overview/USD");
    const firstEur = keys.findIndex((k) => k.includes("EUR"));
    const lastUsd = keys.map((k, i) => (k.includes("USD") ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    expect(lastUsd).toBeLessThan(firstEur);
    for (const ccy of ["EUR", "USD"]) {
      for (const needle of [
        `overview/${ccy}`,
        `holdings/${ccy}/none`,
        `periods/monthly/${ccy}`,
        `allocations/${ccy}`,
        `analytics/${ccy}/365`,
        `calculator/inputs/${ccy}`,
        `deposits/dividends/${ccy}`,
      ]) {
        expect(keys, needle).toContain(needle);
      }
      expect(keys.some((k) => k.startsWith(`deposits/${ccy}/`))).toBe(true);
    }
    // Currency-free pages are fetched once.
    for (const needle of ["instruments", "accounts", "settings/schema", "settings/values"]) {
      expect(keys.filter((k) => k === needle)).toHaveLength(1);
    }
    expect(keys.filter((k) => k.startsWith("transactions/"))).toHaveLength(1);
  });

  it("uses the remembered risk lookback", () => {
    localStorage.setItem("iv.risk.lookback", JSON.stringify("90"));
    expect(prefetchPlan("EUR").map(keyOf)).toContain("analytics/EUR/90");
  });
});
