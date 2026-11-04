import { afterEach, describe, expect, it } from "vitest";
import { prefetchPlan } from "./prefetch";

afterEach(() => localStorage.clear());

const keyOf = (o: { queryKey: readonly unknown[] }) =>
  o.queryKey.map((k) => (typeof k === "object" ? JSON.stringify(k) : String(k))).join("/");

describe("prefetchPlan", () => {
  it("loads Overview first, then the remembered range, then the rest", () => {
    localStorage.setItem("iv.chart.overview.range", JSON.stringify("1y"));
    const keys = prefetchPlan("EUR").map(keyOf);
    expect(keys[0]).toBe("overview/both");
    expect(keys[1]).toBe("graphs/1y/both");
    expect(keys).toContain("holdings/both/none");
    expect(keys.filter((k) => k.startsWith("graphs/"))).toHaveLength(8);
    expect(keys.filter((k) => k === "graphs/1y/both")).toHaveLength(1);
  });

  it("warms every nav page once (each response holds both currencies)", () => {
    const keys = prefetchPlan("USD").map(keyOf);
    expect(keys).toEqual([...new Set(keys)]);
    expect(keys.some((k) => k.includes("EUR") || k.includes("USD"))).toBe(false);
    for (const needle of [
      "overview/both",
      "holdings/both/none",
      "periods/monthly/both",
      "periods/yearly/both",
      "allocations/both",
      "analytics/both/365",
      "calculator/inputs/both",
      "deposits/dividends/both",
      "instruments",
      "accounts",
      "settings/schema",
      "settings/values",
    ]) {
      expect(keys, needle).toContain(needle);
    }
    expect(keys.some((k) => k.startsWith("deposits/both/"))).toBe(true);
    expect(keys.filter((k) => k.startsWith("transactions/"))).toHaveLength(1);
  });

  it("uses the remembered risk lookback", () => {
    localStorage.setItem("iv.risk.lookback", JSON.stringify("90"));
    expect(prefetchPlan("EUR").map(keyOf)).toContain("analytics/both/90");
  });
});
