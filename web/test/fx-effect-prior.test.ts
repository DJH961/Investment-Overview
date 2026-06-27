import { describe, expect, it } from "vitest";

import { Decimal } from "../src/decimal-config";
import type { OverviewView } from "../src/compute";
import { fxEffectPriorFx } from "../src/ui";

/**
 * The "since yesterday" currency-effect panels (EUR currency effect + USD
 * investing-power / "bang for buck") anchor on the prior EUR/USD close. When the
 * FX provider's settled previous close is unavailable — a closed-market /
 * frozen-FX / end-of-day-rate round — they must fall back to the session close
 * (the same anchor the card's "Since close" stat uses) instead of disappearing.
 */
function overview(fields: Partial<OverviewView>): OverviewView {
  return fields as OverviewView;
}

describe("fxEffectPriorFx", () => {
  it("prefers the settled previous close when present", () => {
    const fx = fxEffectPriorFx(
      overview({
        fxRateEurUsdPrev: new Decimal("1.1386"),
        fxRateEurUsdSessionClose: new Decimal("1.1400"),
      }),
    );
    expect(fx?.toString()).toBe("1.1386");
  });

  it("falls back to the session close when the settled prev is missing", () => {
    const fx = fxEffectPriorFx(
      overview({
        fxRateEurUsdPrev: null,
        fxRateEurUsdSessionClose: new Decimal("1.1386"),
      }),
    );
    expect(fx?.toString()).toBe("1.1386");
  });

  it("ignores a non-positive settled prev and uses the session close", () => {
    const fx = fxEffectPriorFx(
      overview({
        fxRateEurUsdPrev: new Decimal("0"),
        fxRateEurUsdSessionClose: new Decimal("1.1386"),
      }),
    );
    expect(fx?.toString()).toBe("1.1386");
  });

  it("returns null when neither anchor is known", () => {
    const fx = fxEffectPriorFx(
      overview({ fxRateEurUsdPrev: null, fxRateEurUsdSessionClose: null }),
    );
    expect(fx).toBeNull();
  });
});
