import { describe, expect, it } from "vitest";
import type { PeriodRowOut } from "../../lib/queries/reports";
import { groupByYear } from "./groupByYear";

const r = (label: string, is_current = false) => ({ label, is_current }) as PeriodRowOut;

describe("groupByYear", () => {
  it("groups months under years, newest first, flagging the current year", () => {
    const g = groupByYear([r("2025-11"), r("2025-12"), r("2026-01", true)], [r("2025"), r("2026", true)]);
    expect(g.map((x) => x.year)).toEqual(["2026", "2025"]);
    expect(g[1]?.months.map((m) => m.label)).toEqual(["2025-12", "2025-11"]);
    expect(g[0]?.isCurrent).toBe(true);
    expect(g[1]?.isCurrent).toBe(false);
    expect(g[0]?.summary?.label).toBe("2026");
  });
});
