import { describe, expect, it } from "vitest";

import { Decimal } from "../src/decimal-config";
import type { OverviewView } from "../src/compute";
import { fxAnchorWarning, fxEffectPriorFx } from "../src/ui";

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

describe("fxAnchorWarning", () => {
  // A fixed open-market instant (Thu 2026-06-25 18:00 UTC ≈ 14:00 ET) so the
  // closed-market branch is not triggered for the "settled prev present" cases.
  const openNow = new Date(Date.UTC(2026, 5, 25, 18, 0, 0));
  // A weekday post-close instant (Thu 2026-06-25 22:00 UTC ≈ 18:00 ET): the US
  // session has shut but spot-FX is still trading, so the live tip genuinely
  // drifts from a missing session close — the case the warning is meant for.
  const forexOpenMarketShut = new Date(Date.UTC(2026, 5, 25, 22, 0, 0));
  // A frozen-weekend instant (Sat) so both the US market *and* spot-FX are shut.
  const frozenWeekend = new Date(Date.UTC(2026, 5, 27, 12, 0, 0));

  it("is silent when both anchors are fresh and the market is open", () => {
    const warn = fxAnchorWarning(
      overview({
        fxRateEurUsdPrev: new Decimal("1.1386"),
        fxRateEurUsdSessionClose: new Decimal("1.1400"),
      }),
      openNow,
    );
    expect(warn).toBeNull();
  });

  it("flags a missing settled previous close (running on a fallback baseline)", () => {
    const warn = fxAnchorWarning(
      overview({
        fxRateEurUsdPrev: null,
        fxRateEurUsdSessionClose: new Decimal("1.1386"),
      }),
      openNow,
    );
    expect(warn).not.toBeNull();
  });

  it("flags a forex-open, market-shut round with no session-close anchor pulled", () => {
    const warn = fxAnchorWarning(
      overview({
        fxRateEurUsdPrev: new Decimal("1.1386"),
        fxRateEurUsdSessionClose: null,
      }),
      forexOpenMarketShut,
    );
    expect(warn).not.toBeNull();
  });

  it("stays silent on a frozen weekend even when the session close is missing", () => {
    // The user's reported case: a normal weekend with the market shut must NOT
    // sit on the warning glyph. While forex is frozen the displayed rate *is*
    // Friday's close, so a missing session-close anchor is not an inaccuracy.
    const warn = fxAnchorWarning(
      overview({
        fxRateEurUsdPrev: new Decimal("1.1386"),
        fxRateEurUsdSessionClose: null,
      }),
      frozenWeekend,
    );
    expect(warn).toBeNull();
  });

  it("still flags a missing settled baseline on a frozen weekend", () => {
    // Genuine missing data (no "yesterday" baseline) is flagged regardless of the
    // market regime — it is a data-quality signal, not a market-closed signal.
    const warn = fxAnchorWarning(
      overview({
        fxRateEurUsdPrev: null,
        fxRateEurUsdSessionClose: null,
      }),
      frozenWeekend,
    );
    expect(warn).not.toBeNull();
  });

  it("stays silent on a closed market once the session close is in hand", () => {
    const warn = fxAnchorWarning(
      overview({
        fxRateEurUsdPrev: new Decimal("1.1386"),
        fxRateEurUsdSessionClose: new Decimal("1.1400"),
      }),
      frozenWeekend,
    );
    expect(warn).toBeNull();
  });
});
