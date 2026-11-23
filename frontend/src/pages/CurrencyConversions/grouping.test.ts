import { describe, expect, it } from "vitest";
import { groupByYear, inPeriod, periodOptions, validPeriod } from "./grouping";

const dates = ["2026-06-20", "2026-06-02", "2026-05-11", "2025-12-30", "2025-03-01", "2024-07-07"];
const items = dates.map((date, i) => ({ id: i, date }));

describe("groupByYear", () => {
  it("groups by year, newest first, keeping the order inside a year", () => {
    const g = groupByYear(items, (i) => i.date);
    expect(g.map((x) => x.year)).toEqual(["2026", "2025", "2024"]);
    expect(g[0].items.map((i) => i.id)).toEqual([0, 1, 2]);
    expect(g[1].items.map((i) => i.id)).toEqual([3, 4]);
  });
});

describe("period filter", () => {
  const today = "2026-11-22";
  it("matches this year, the last 12 months, a year or all", () => {
    expect(inPeriod("2026-01-02", "ytd", today)).toBe(true);
    expect(inPeriod("2025-12-31", "ytd", today)).toBe(false);
    expect(inPeriod("2025-11-23", "12m", today)).toBe(true);
    expect(inPeriod("2025-11-21", "12m", today)).toBe(false);
    expect(inPeriod("2024-07-07", "2024", today)).toBe(true);
    expect(inPeriod("2023-07-07", "2024", today)).toBe(false);
    expect(inPeriod("2001-01-01", "all", today)).toBe(true);
  });
  it("offers each earlier year once, and ignores a stale link", () => {
    const options = periodOptions(dates, "2026-11-22");
    expect(options.map((o) => o.value)).toEqual(["all", "ytd", "12m", "2025", "2024"]);
    expect(validPeriod("2019", options)).toBe("all");
    expect(validPeriod("2025", options)).toBe("2025");
    expect(validPeriod(null, options)).toBe("all");
  });
});
