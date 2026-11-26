import { describe, expect, it } from "vitest";
import { pageByMonth, pageBySize } from "./paging";

const rows = (month: string, n: number) => Array.from({ length: n }, (_, i) => ({ date: `${month}-${String(i + 1).padStart(2, "0")}` }));

describe("pageByMonth", () => {
  it("is empty for no rows", () => {
    expect(pageByMonth([], 50)).toEqual([]);
  });

  it("keeps whole months together and starts the next page when one would overflow", () => {
    const all = [...rows("2026-03", 30), ...rows("2026-02", 15), ...rows("2026-01", 20)];
    const pages = pageByMonth(all, 50);
    expect(pages.map((p) => p.length)).toEqual([45, 20]);
    expect(pages[1][0].date.slice(0, 7)).toBe("2026-01");
  });

  it("puts a month larger than the page size on its own page, whole", () => {
    const all = [...rows("2026-03", 5), ...rows("2026-02", 12), ...rows("2026-01", 3)];
    const pages = pageByMonth(all, 10);
    expect(pages.map((p) => p.length)).toEqual([5, 12, 3]);
  });

  it("closes a page that is exactly full", () => {
    const pages = pageByMonth([...rows("2026-02", 10), ...rows("2026-01", 2)], 10);
    expect(pages.map((p) => p.length)).toEqual([10, 2]);
  });
});

describe("pageBySize", () => {
  it("slices plainly", () => {
    expect(pageBySize([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
