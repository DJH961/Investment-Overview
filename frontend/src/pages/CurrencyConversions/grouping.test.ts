import { describe, expect, it } from "vitest";
import { buildSections, groupByMonth, inPeriod, newestMonths, periodOptions, validPeriod } from "./grouping";

const dates = ["2026-06-20", "2026-06-02", "2026-05-11", "2025-12-30", "2025-03-01", "2024-07-07"];
const items = dates.map((date, i) => ({ id: i, date }));

describe("groupByMonth", () => {
  it("groups by month, newest first, keeping the order inside a month", () => {
    const g = groupByMonth(items, (i) => i.date);
    expect(g.map((x) => x.key)).toEqual(["2026-06", "2026-05", "2025-12", "2025-03", "2024-07"]);
    expect(g[0].items.map((i) => i.id)).toEqual([0, 1]);
  });
});

describe("buildSections", () => {
  it("keeps this year's months on their own and folds older years", () => {
    const s = buildSections(groupByMonth(items, (i) => i.date), "2026");
    expect(s.map((x) => (x.kind === "month" ? x.group.key : `y${x.block.year}`))).toEqual([
      "2026-06",
      "2026-05",
      "y2025",
      "y2024",
    ]);
    const y2025 = s[2];
    expect(y2025.kind === "year" && y2025.block.count).toBe(2);
    expect(y2025.kind === "year" && y2025.block.months.map((m) => m.key)).toEqual(["2025-12", "2025-03"]);
  });
});

describe("newestMonths", () => {
  it("opens the two newest months that have entries", () => {
    expect([...newestMonths(["2025-03", "2026-06", "2026-05", "2024-07"])].sort()).toEqual(["2026-05", "2026-06"]);
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
