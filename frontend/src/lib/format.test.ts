import { describe, expect, it } from "vitest";
import { formatDate, formatMoney, formatNumber, formatPercent, signOf } from "./format";

describe("format", () => {
  it("formats money in the given currency", () => {
    expect(formatMoney(1234.5, "EUR")).toContain("1,234.50");
    expect(formatMoney(1234.5, "EUR")).toContain("€");
    expect(formatMoney(10, "USD")).toContain("US$");
  });
  it("signs money when asked", () => {
    expect(formatMoney(5, "EUR", { signed: true })).toContain("+");
    expect(formatMoney(-5, "EUR", { signed: true })).toContain("-");
  });
  it("renders missing values as a dash", () => {
    expect(formatMoney(null, "EUR")).toBe("–");
    expect(formatPercent(undefined)).toBe("–");
    expect(formatNumber(NaN)).toBe("–");
  });
  it("formats ratios as percent", () => {
    expect(formatPercent(0.0525)).toBe("5.25%");
    expect(formatPercent(0.1, { signed: true, digits: 1 })).toBe("+10.0%");
  });
  it("formats dates in UTC", () => {
    expect(formatDate("2026-03-05")).toContain("2026");
    expect(formatDate("garbage")).toBe("–");
  });
  it("classifies sign", () => {
    expect(signOf(1)).toBe("pos");
    expect(signOf(-1)).toBe("neg");
    expect(signOf(0)).toBe("flat");
    expect(signOf(null)).toBe("flat");
  });
});
