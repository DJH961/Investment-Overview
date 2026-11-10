import { afterEach, describe, expect, it } from "vitest";
import { chartMoneyFormat, formatDate, formatMonth, formatMoney, formatNumber, formatPercent, formatQuantity, setHideAmounts, signOf } from "./format";

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

describe("hide mode", () => {
  afterEach(() => setHideAmounts(false));
  it("masks money (symbol kept), quantities and the chart formatters; keeps percentages", () => {
    setHideAmounts(true);
    // Number-shaped (fixed five-digit shape), so hidden figures lay out like real ones.
    expect(formatMoney(1234.5, "EUR")).toBe("€••,•••.••");
    expect(formatMoney(-1234.5, "EUR", { signed: true })).toBe("-€••,•••.••");
    expect(formatMoney(null, "EUR")).toBe("–");
    expect(formatQuantity(12.5, 4)).toBe("•••••");
    expect(chartMoneyFormat("USD", "axis")(5000)).toBe("$••,•••");
    expect(formatPercent(0.05)).toContain("5");
    setHideAmounts(false);
    expect(formatMoney(1234.5, "EUR")).toContain("1,234.50");
  });
});

describe("signOf with display digits", () => {
  it("treats a value that rounds to zero as flat", () => {
    expect(signOf(-0.003, 2)).toBe("flat");
    expect(signOf(-0.006, 2)).toBe("neg");
    expect(signOf(-0.003)).toBe("neg");
  });
});

describe("formatMonth", () => {
  it("follows the regional locale and passes other labels through", () => {
    expect(formatMonth("2026-10", "short")).toMatch(/Oct/);
    expect(formatMonth("2026", "short")).toBe("2026");
  });
});
