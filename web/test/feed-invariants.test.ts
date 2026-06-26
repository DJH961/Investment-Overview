import { describe, expect, it } from "vitest";
import { Decimal } from "../src/decimal-config";
import { parsePositivePrice, convert, type FxRates } from "../src/prices";
import { valueInBothCurrencies } from "../src/compute";
import { forwardFilled } from "../src/timeseries";

/**
 * Phase-3 anti-regression / "adversarial feed" guards. These assert the
 * *invariants* the Phase 0/1 correctness fixes established, so a future symptom
 * fix can never silently regress them again (problem statement §Phase 3 / item 11):
 *
 *   - A missing or non-positive provider price ⇒ flagged/omitted, never a `0`
 *     (or any number) that quietly values a holding.
 *   - USD is the booked native leg (FX-free); EUR is derived — never the reverse.
 *   - A holding before its first bar is "unknown" (null), never back-filled from a
 *     future bar.
 *
 * (The Tiingo upper-cased-ticker ⇄ lower-cased export symbol resolution and the
 * Tiingo non-positive-price drop are locked separately in `tiingo.test.ts`.)
 */

const fx: FxRates = { base: "USD", rates: { USD: new Decimal(1), EUR: new Decimal("0.9") } };

describe("invariant — a non-positive / missing price never values a holding", () => {
  it("parsePositivePrice rejects 0, negatives and junk as null", () => {
    expect(parsePositivePrice(0)).toBeNull();
    expect(parsePositivePrice("0")).toBeNull();
    expect(parsePositivePrice("0.00")).toBeNull();
    expect(parsePositivePrice(-5)).toBeNull();
    expect(parsePositivePrice("-1.5")).toBeNull();
    expect(parsePositivePrice("")).toBeNull();
    expect(parsePositivePrice(null)).toBeNull();
    expect(parsePositivePrice("nope")).toBeNull();
  });

  it("parsePositivePrice keeps a genuine positive price", () => {
    expect(parsePositivePrice("12.34")?.toString()).toBe("12.34");
    expect(parsePositivePrice(99)?.toString()).toBe("99");
  });
});

describe("invariant — USD is native (FX-free); EUR is derived, never the reverse", () => {
  it("a USD-native value passes USD through untouched and only EUR picks up FX", () => {
    const { valueEur, valueUsd } = valueInBothCurrencies(new Decimal("1000"), "USD", fx);
    // USD is exactly shares×price — no FX drift whatsoever.
    expect(valueUsd?.toString()).toBe("1000");
    // EUR is the derived leg at the FX rate.
    expect(valueEur?.toString()).toBe("900");
  });

  it("moving the live FX rate never changes the USD leg of a USD-native holding", () => {
    const a = valueInBothCurrencies(new Decimal("1000"), "USD", fx);
    const fx2: FxRates = { base: "USD", rates: { USD: new Decimal(1), EUR: new Decimal("0.8") } };
    const b = valueInBothCurrencies(new Decimal("1000"), "USD", fx2);
    expect(a.valueUsd?.toString()).toBe(b.valueUsd?.toString()); // USD pinned
    expect(a.valueEur?.toString()).not.toBe(b.valueEur?.toString()); // only EUR moves
  });

  it("an unpriced holding is honestly unknown on both legs (no faked 0)", () => {
    const { valueEur, valueUsd } = valueInBothCurrencies(null, "USD", fx);
    expect(valueEur).toBeNull();
    expect(valueUsd).toBeNull();
  });

  it("a missing FX leg nulls only the derived side, never fabricates it", () => {
    const noEur: FxRates = { base: "USD", rates: { USD: new Decimal(1) } };
    const { valueEur, valueUsd } = valueInBothCurrencies(new Decimal("1000"), "USD", noEur);
    expect(valueUsd?.toString()).toBe("1000"); // native still known
    expect(valueEur).toBeNull(); // derived honestly unknown
    // And convert refuses to invent the rate rather than guessing.
    expect(convert(new Decimal("1000"), "USD", "EUR", noEur)).toBeNull();
  });
});

describe("invariant — no look-ahead: a holding before its first bar is unknown", () => {
  it("forwardFilled returns null before the first bar, not the future bar's value", () => {
    const bars = [
      { t: 100, value: new Decimal("10") },
      { t: 200, value: new Decimal("11") },
    ];
    expect(forwardFilled(bars, 50)).toBeNull(); // before first bar ⇒ unknown
    expect(forwardFilled(bars, 100)?.toString()).toBe("10"); // at first bar
    expect(forwardFilled(bars, 150)?.toString()).toBe("10"); // carried forward
    expect(forwardFilled(bars, 999)?.toString()).toBe("11"); // last known
  });
});

