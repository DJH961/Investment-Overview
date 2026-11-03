import { afterEach, describe, expect, it } from "vitest";
import { prefetchPlan } from "./prefetch";

afterEach(() => localStorage.clear());

describe("prefetchPlan", () => {
  it("loads Overview first, then the remembered range, then the rest", () => {
    localStorage.setItem("iv.chart.overview.range", JSON.stringify("1y"));
    const keys = prefetchPlan("EUR").map((o) => o.queryKey.join("/"));
    expect(keys[0]).toBe("overview/EUR");
    expect(keys[1]).toBe("graphs/1y/EUR");
    expect(keys).toContain("holdings/EUR/none");
    expect(keys.filter((k) => k.startsWith("graphs/"))).toHaveLength(8);
    expect(keys.filter((k) => k === "graphs/1y/EUR")).toHaveLength(1);
  });
});
