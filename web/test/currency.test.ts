import { describe, expect, it, beforeEach } from "vitest";
import { Decimal } from "../src/decimal-config";
import {
  canConvertToUsd,
  convertFromEur,
  convertToEur,
  displayAmount,
  getDisplayCurrency,
  setDisplayCurrency,
  setEurUsdRate,
  toggleDisplayCurrency,
} from "../src/currency";
import {
  formatCurrency,
  formatCurrencyShort,
  formatDualCurrency,
  formatDualCurrencyParts,
  formatSignedDualCurrency,
} from "../src/format";

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

  it("convertToEur round-trips convertFromEur for USD display", () => {
    setDisplayCurrency("USD");
    // A USD amount the user typed converts back to its EUR equivalent.
    expect(convertToEur(new Decimal("110")).toString()).toBe("100");
    // Round-trip: EUR -> display -> EUR is the identity.
    const display = convertFromEur(new Decimal("250")).value;
    expect(convertToEur(display).toString()).toBe("250");
  });

  it("convertToEur leaves amounts untouched in EUR display or without a rate", () => {
    expect(convertToEur(new Decimal("100")).toString()).toBe("100");
    setDisplayCurrency("USD");
    setEurUsdRate(null);
    expect(convertToEur(new Decimal("100")).toString()).toBe("100");
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

describe("displayAmount (historical-flow figures)", () => {
  beforeEach(() => {
    setDisplayCurrency("EUR");
    setEurUsdRate(new Decimal("1.10"));
  });

  it("uses the EUR figure in EUR mode (ignores the USD figure)", () => {
    const picked = displayAmount(new Decimal("100"), new Decimal("130"));
    expect(picked).not.toBeNull();
    expect(picked?.code).toBe("EUR");
    expect(picked?.value.toString()).toBe("100");
  });

  it("prefers the pre-computed USD figure over rescaling EUR by today's spot", () => {
    setDisplayCurrency("USD");
    // The exported USD figure (booked at trade-date FX) is 130, which must win
    // over 100 EUR * 1.10 spot = 110.
    const picked = displayAmount(new Decimal("100"), new Decimal("130"));
    expect(picked?.code).toBe("USD");
    expect(picked?.value.toString()).toBe("130");
  });

  it("falls back to spot-converting EUR when no USD figure is available", () => {
    setDisplayCurrency("USD");
    const picked = displayAmount(new Decimal("100"), null);
    expect(picked?.code).toBe("USD");
    expect(picked?.value.toString()).toBe("110");
  });

  it("stays in EUR when USD is selected but no rate is known", () => {
    setEurUsdRate(null);
    setDisplayCurrency("USD");
    const picked = displayAmount(new Decimal("100"), new Decimal("130"));
    expect(picked?.code).toBe("EUR");
    expect(picked?.value.toString()).toBe("100");
  });
});

describe("formatDualCurrency", () => {
  beforeEach(() => {
    setDisplayCurrency("EUR");
    setEurUsdRate(new Decimal("1.10"));
  });

  it("renders the per-date USD figure verbatim in USD mode", () => {
    setDisplayCurrency("USD");
    const out = formatDualCurrency(new Decimal("1000"), new Decimal("1300"));
    expect(out).toContain("1,300.00");
    expect(out).not.toContain("1,100.00");
  });

  it("signs the dual figure from the chosen currency value", () => {
    setDisplayCurrency("USD");
    expect(formatSignedDualCurrency(new Decimal("-1000"), new Decimal("-1300"))).toContain("−");
    expect(formatSignedDualCurrency(new Decimal("1000"), new Decimal("1300"))).toContain("+");
  });

  it("renders an em dash for missing figures", () => {
    expect(formatDualCurrency(null, null)).toBe("—");
  });
});

describe("formatDualCurrencyParts", () => {
  beforeEach(() => {
    setDisplayCurrency("EUR");
    setEurUsdRate(new Decimal("1.10"));
  });

  it("shows EUR primary and the per-date USD secondary in EUR mode", () => {
    const parts = formatDualCurrencyParts(new Decimal("1000"), new Decimal("1300"));
    expect(parts).not.toBeNull();
    expect(parts?.primary).toContain("1,000.00");
    expect(parts?.primary).toContain("€");
    expect(parts?.secondary).toContain("1,300.00");
    // The secondary USD leg is the verbatim per-date figure, not 1000*1.10.
    expect(parts?.secondary).not.toContain("1,100.00");
  });

  it("flips primary/secondary in USD mode, keeping both legs verbatim", () => {
    setDisplayCurrency("USD");
    const parts = formatDualCurrencyParts(new Decimal("1000"), new Decimal("1300"));
    expect(parts?.primary).toContain("1,300.00");
    expect(parts?.secondary).toContain("1,000.00");
    expect(parts?.secondary).toContain("€");
  });

  it("shows only the available leg when the other currency is missing", () => {
    const parts = formatDualCurrencyParts(new Decimal("1000"), null);
    expect(parts?.primary).toContain("1,000.00");
    expect(parts?.secondary).toBeNull();
  });

  it("falls back to the EUR leg alone when USD is selected without a rate", () => {
    setEurUsdRate(null);
    setDisplayCurrency("USD");
    const parts = formatDualCurrencyParts(new Decimal("1000"), null);
    expect(parts?.primary).toContain("€");
    expect(parts?.secondary).toBeNull();
  });

  it("returns null when neither currency can be shown", () => {
    expect(formatDualCurrencyParts(null, null)).toBeNull();
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
