import { describe, expect, it } from "vitest";
import type { RateHistoryDto } from "../../lib/queries/currencyRate";
import { conversionMarks } from "./RateChart";

const history = (markers: object[]) =>
  ({
    points: [
      { t: "2026-03-01", rate: "1.0800", inverse: "0.9259" },
      { t: "2026-03-31", rate: "1.0900", inverse: "0.9174" },
    ],
    markers,
  }) as unknown as RateHistoryDto;

const marker = (over: object) => ({
  date: "2026-03-12",
  rate: "1.0830",
  amount_from: "2770",
  amount_to: "3000",
  from_ccy: "EUR",
  to_ccy: "USD",
  kind: "below_reference",
  off_pct: "-0.002",
  conversion_id: 1,
  ...over,
});

describe("conversionMarks", () => {
  it("draws a mark at the conversion's own rate, with the shape of its side of the ECB", () => {
    const m = conversionMarks(history([marker({}), marker({ kind: "above_reference", off_pct: "0.003", conversion_id: 2 })]), "rate");
    expect(m.map((x) => x.shape)).toEqual(["below", "above"]);
    expect(m[0].v).toBeCloseTo(1.083, 6);
    expect(m[0].label).toContain("0.2 % under ECB");
    expect(m[0].label).toContain("1.0830");
    expect(m[1].label).toContain("0.3 % over ECB");
  });

  it("uses the dollar's quote in the EUR view and a plain ring without a fixing", () => {
    const [m] = conversionMarks(history([marker({ kind: null, off_pct: null })]), "dollar");
    expect(m.shape).toBe("conversion");
    expect(m.v).toBeCloseTo(1 / 1.083, 6);
    expect(m.label).not.toContain("ECB");
  });

  it("sizes by the EUR amount and skips conversions outside the plotted span", () => {
    const m = conversionMarks(
      history([marker({ amount_from: "100" }), marker({ amount_from: "10000", conversion_id: 2 }), marker({ date: "2025-01-01", conversion_id: 3 })]),
      "rate",
    );
    expect(m).toHaveLength(2);
    expect(m[1].r).toBeGreaterThan(m[0].r ?? 0);
  });
});
