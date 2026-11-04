import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { prefetchPlan, quiet } from "./prefetch";

describe("quiet", () => {
  it("waits until the page's own requests are done", async () => {
    const qc = new QueryClient();
    let release: (v: number) => void = () => undefined;
    void qc.fetchQuery({ queryKey: ["page"], queryFn: () => new Promise<number>((r) => (release = r)) });
    let done = false;
    const waiting = quiet(qc).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    release(1);
    await waiting;
    expect(done).toBe(true);
  });
});

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
