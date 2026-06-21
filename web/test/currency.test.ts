import { describe, expect, it, beforeEach } from "vitest";
import { Decimal } from "../src/decimal-config";
import {
  canConvertToUsd,
  convertFromEur,
  getDisplayCurrency,
  setDisplayCurrency,
  setEurUsdRate,
  toggleDisplayCurrency,
} from "../src/currency";
import { formatCurrency, formatCurrencyShort } from "../src/format";

describe("currency", () => {
  beforeEach(() => {
    setDisplayCurrency("EUR");
    setEurUsdRate(new Decimal("1.10"));
  });

  it("defaults to EUR and leaves EUR amounts untouched", () => {
    expect(getDisplayCurrency()).toBe("EUR");
    const { value, code } = convertFromEur(new Decimal("100"));
    expect(code).toBe("EUR");
    expect(value.toString()).toBe("100");
  });

  it("converts to USD with the configured rate when USD is selected", () => {
    setDisplayCurrency("USD");
    const { value, code } = convertFromEur(new Decimal("100"));
    expect(code).toBe("USD");
    expect(value.toString()).toBe("110");
  });

  it("toggles EUR <-> USD", () => {
    expect(toggleDisplayCurrency()).toBe("USD");
    expect(toggleDisplayCurrency()).toBe("EUR");
  });

  it("falls back to EUR when USD is selected but no rate is known", () => {
    setEurUsdRate(null);
    setDisplayCurrency("USD");
    expect(canConvertToUsd()).toBe(false);
    const { value, code } = convertFromEur(new Decimal("100"));
    expect(code).toBe("EUR");
    expect(value.toString()).toBe("100");
  });

  it("ignores a non-positive rate", () => {
    setEurUsdRate(new Decimal("0"));
    expect(canConvertToUsd()).toBe(false);
    setEurUsdRate(new Decimal("-1"));
    expect(canConvertToUsd()).toBe(false);
  });
});

describe("format currency in the active display currency", () => {
  beforeEach(() => {
    setDisplayCurrency("EUR");
    setEurUsdRate(new Decimal("1.10"));
  });

  it("formats EUR amounts with the euro symbol", () => {
    expect(formatCurrency(new Decimal("1234.5"))).toContain("1,234.50");
    expect(formatCurrency(new Decimal("1234.5"))).toContain("€");
  });

  it("formats in USD after switching currency", () => {
    setDisplayCurrency("USD");
    const out = formatCurrency(new Decimal("1000"));
    // 1000 EUR * 1.10 = 1100 USD
    expect(out).toContain("1,100.00");
    expect(out).toMatch(/\$|US\$/);
  });

  it("abbreviates short amounts for axis ticks in the active currency", () => {
    expect(formatCurrencyShort(new Decimal("39000"))).toBe("€39k");
    expect(formatCurrencyShort(new Decimal("1500000"))).toBe("€1.5M");
    expect(formatCurrencyShort(new Decimal("950"))).toBe("€950");
    setDisplayCurrency("USD");
    // 39000 * 1.10 = 42900 -> "$43k"
    expect(formatCurrencyShort(new Decimal("39000"))).toBe("$43k");
  });
});
