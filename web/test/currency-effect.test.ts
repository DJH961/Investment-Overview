import { describe, expect, it } from "vitest";

import { Decimal } from "../src/decimal-config";
import { computeCurrencyEffect } from "../src/currency-effect";

/**
 * Mirrors tests/domain/test_currency_effect.py so the browser port stays
 * faithful to the desktop's EUR/USD currency-effect math.
 */
describe("computeCurrencyEffect", () => {
  it("treats a weaker euro as a tailwind for a euro investor", () => {
    const effect = computeCurrencyEffect({
      contributionsEur: new Decimal("1000"),
      contributionsUsd: new Decimal("1200"), // avg invest rate 1.20
      valueEur: new Decimal("1200"),
      valueUsd: new Decimal("1200"), // current rate 1.00 (euro weaker)
      growthEur: new Decimal("0.20"),
      growthUsd: new Decimal("0.00"),
    });
    expect(effect.avgInvestRate!.toString()).toBe("1.2");
    expect(effect.currentRate!.toString()).toBe("1");
    expect(effect.rateChangePct!.isNegative()).toBe(true);
    expect(effect.currencyEffectPp!.toString()).toBe("0.2");
    expect(effect.fxPnlEur!.toString()).toBe("200");
    expect(effect.repatriationValueEur!.toString()).toBe("1200");
    expect(effect.breakevenRate!.toString()).toBe("1.2");
  });

  it("degrades to null when there is no USD value", () => {
    const effect = computeCurrencyEffect({
      contributionsEur: new Decimal("1000"),
      contributionsUsd: new Decimal("1100"),
      valueEur: new Decimal("1200"),
      valueUsd: null,
      growthEur: null,
      growthUsd: null,
    });
    expect(effect.currentRate).toBeNull();
    expect(effect.fxPnlEur).toBeNull();
    expect(effect.currencyEffectPp).toBeNull();
    expect(effect.avgInvestRate!.toString()).toBe("1.1");
    expect(effect.repatriationValueEur!.toString()).toBe("1200");
  });

  it("yields no average rate when there are zero contributions", () => {
    const effect = computeCurrencyEffect({
      contributionsEur: new Decimal("0"),
      contributionsUsd: new Decimal("0"),
      valueEur: new Decimal("100"),
      valueUsd: new Decimal("108"),
      growthEur: new Decimal("0.05"),
      growthUsd: new Decimal("0.04"),
    });
    expect(effect.avgInvestRate).toBeNull();
    expect(effect.rateChangePct).toBeNull();
    expect(effect.fxPnlEur).toBeNull();
    expect(effect.currentRate!.toString()).toBe("1.08");
    expect(effect.currencyEffectPp!.toString()).toBe("0.01");
  });

  it("treats a stronger euro as a headwind", () => {
    const effect = computeCurrencyEffect({
      contributionsEur: new Decimal("1000"),
      contributionsUsd: new Decimal("1000"), // avg 1.00
      valueEur: new Decimal("1000"),
      valueUsd: new Decimal("1200"), // current 1.20 (euro stronger)
      growthEur: new Decimal("0.00"),
      growthUsd: new Decimal("0.20"),
    });
    expect(effect.rateChangePct!.toString()).toBe("0.2");
    expect(effect.currencyEffectPp!.toString()).toBe("-0.2");
    expect(effect.fxPnlEur!.toString()).toBe("-200");
  });
});
