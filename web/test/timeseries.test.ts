/**
 * Tests for the anchored session-reconstruction maths (port of the desktop
 * `_reconstruct_session`). Pure functions, no network/DOM.
 */
import { describe, expect, it } from "vitest";

import { Decimal } from "../src/decimal-config";
import {
  forwardFilled,
  marketComponentEur,
  marketComponentUsd,
  reconstructSessionCurve,
  type Bar,
  type ReconHolding,
} from "../src/timeseries";

function bar(t: number, value: string): Bar {
  return { t, value: new Decimal(value) };
}

describe("forwardFilled", () => {
  const bars = [bar(10, "1"), bar(20, "2"), bar(30, "3")];

  it("returns the latest bar at or before the instant", () => {
    expect(forwardFilled(bars, 25)?.toString()).toBe("2");
    expect(forwardFilled(bars, 30)?.toString()).toBe("3");
  });

  it("returns null when the instant precedes all bars (no future back-fill)", () => {
    // Before the first real print the track is unknown — it must NOT borrow the
    // earliest (future) bar, which would leak a value that had not happened yet.
    expect(forwardFilled(bars, 5)).toBeNull();
    expect(forwardFilled(bars, 9)).toBeNull();
    expect(forwardFilled(bars, 10)?.toString()).toBe("1"); // exactly the first bar is known
  });

  it("returns null for an empty series", () => {
    expect(forwardFilled([], 5)).toBeNull();
  });
});

describe("marketComponent", () => {
  // One USD-booked ETF worth $1000 / €900 at a $50 close.
  const holding: ReconHolding = {
    symbol: "VTI",
    valueEur: new Decimal("900"),
    valueUsd: new Decimal("1000"),
    closeNative: new Decimal("50"),
    isUsdNative: true,
  };
  const barsBySymbol = new Map<string, Bar[]>([["VTI", [bar(100, "50"), bar(200, "55")]]]);

  it("USD scales by price ratio only (FX-free)", () => {
    // At the close, ratio = 1 → $1000; at $55, ratio = 1.1 → $1100.
    expect(marketComponentUsd([holding], barsBySymbol, 100).toString()).toBe("1000");
    expect(marketComponentUsd([holding], barsBySymbol, 200).toString()).toBe("1100");
  });

  it("EUR re-marks a USD holding by the bar's own FX", () => {
    // settled fx 1.1; at a bar where fx weakens to 1.05, EUR pivot grows.
    const baseFx = new Decimal("1.1");
    const flat = marketComponentEur([holding], barsBySymbol, 100, baseFx, baseFx);
    expect(flat.toString()).toBe("900"); // same rate ⇒ unchanged
    const reMarked = marketComponentEur([holding], barsBySymbol, 100, new Decimal("1.05"), baseFx);
    // 900 * (1.1 / 1.05) = 942.857...
    expect(new Decimal(reMarked).toFixed(4)).toBe("942.8571");
  });

  it("carries a symbol with no bar at a flat ratio of 1", () => {
    expect(marketComponentUsd([holding], new Map(), 100).toString()).toBe("1000");
  });
});

describe("reconstructSessionCurve", () => {
  const holding: ReconHolding = {
    symbol: "VTI",
    valueEur: new Decimal("900"),
    valueUsd: new Decimal("1000"),
    closeNative: new Decimal("50"),
    isUsdNative: true,
  };

  it("adds the constant base and closes on the correct total", () => {
    const curve = reconstructSessionCurve({
      holdings: [holding],
      barsBySymbol: new Map([["VTI", [bar(100, "50"), bar(200, "55")]]]),
      fxBars: [bar(100, "1.1"), bar(200, "1.1")],
      baseFx: new Decimal("1.1"),
      baseEur: new Decimal("100"),
      baseUsd: new Decimal("110"),
    });
    expect(curve).toHaveLength(2);
    // First bar at the close: base + settled value.
    expect(curve[0].valueUsd.toString()).toBe("1110"); // 110 + 1000
    expect(curve[0].valueEur.toString()).toBe("1000"); // 100 + 900
    // Second bar at +10%: USD 110 + 1100 = 1210.
    expect(curve[1].valueUsd.toString()).toBe("1210");
  });

  it("steps the money-market base per day instead of carrying today's balance flat", () => {
    const t1 = Date.UTC(2026, 5, 22, 12, 0); // earlier day: MM was 5000
    const t2 = Date.UTC(2026, 5, 24, 12, 0); // latest day: MM is 9000 (in base)
    const curve = reconstructSessionCurve({
      holdings: [holding],
      barsBySymbol: new Map([["VTI", [bar(t1, "50"), bar(t2, "50")]]]),
      fxBars: [bar(t1, "1.0"), bar(t2, "1.0")],
      baseFx: new Decimal("1.0"),
      baseEur: new Decimal("9000"),
      baseUsd: new Decimal("9000"),
      mmDaysUsd: [
        { date: "2026-06-22", valueNativeUsd: new Decimal("5000") },
        { date: "2026-06-24", valueNativeUsd: new Decimal("9000") },
      ],
    });
    // Earlier day steps the base down by (5000 − 9000): 9000 + 1000 − 4000 = 6000.
    expect(curve[0].valueUsd.toString()).toBe("6000");
    expect(curve[0].valueEur.toString()).toBe("5900"); // 9000 + 900 − 4000 at fx 1.0
    // Latest day uses today's balance (no step): 9000 + 1000 = 10000.
    expect(curve[1].valueUsd.toString()).toBe("10000");
  });

  it("leaves the base flat when no money-market day series is supplied", () => {
    const curve = reconstructSessionCurve({
      holdings: [holding],
      barsBySymbol: new Map([["VTI", [bar(100, "50"), bar(200, "50")]]]),
      baseFx: new Decimal("1.1"),
      baseEur: new Decimal("100"),
      baseUsd: new Decimal("110"),
    });
    expect(curve[0].valueUsd.toString()).toBe(curve[1].valueUsd.toString());
  });

  it("EUR and USD genuinely diverge under per-bar FX (not a uniform rescale)", () => {
    const curve = reconstructSessionCurve({
      holdings: [holding],
      barsBySymbol: new Map([["VTI", [bar(100, "50"), bar(200, "50")]]]),
      // Price flat, but FX moves between the two bars.
      fxBars: [bar(100, "1.10"), bar(200, "1.20")],
      baseFx: new Decimal("1.10"),
      baseEur: new Decimal("0"),
      baseUsd: new Decimal("0"),
    });
    // USD is FX-free → identical at both instants.
    expect(curve[0].valueUsd.toString()).toBe("1000");
    expect(curve[1].valueUsd.toString()).toBe("1000");
    // EUR re-marks: 900 at 1.10, then 900 * 1.10/1.20 at 1.20 → smaller.
    expect(curve[0].valueEur.toString()).toBe("900");
    expect(curve[1].valueEur.lessThan(curve[0].valueEur)).toBe(true);
  });

  it("unions bar instants across symbols and forward-fills the gaps", () => {
    const second: ReconHolding = { ...holding, symbol: "SPY" };
    const curve = reconstructSessionCurve({
      holdings: [holding, second],
      barsBySymbol: new Map([
        ["VTI", [bar(100, "50")]],
        ["SPY", [bar(150, "55")]],
      ]),
      baseFx: null,
      baseEur: new Decimal("0"),
      baseUsd: new Decimal("0"),
    });
    // Two distinct instants (100 and 150).
    expect(curve.map((p) => p.t)).toEqual([100, 150]);
    // At t=150 SPY is at +10% while VTI forward-fills its only bar (flat).
    expect(curve[1].valueUsd.toString()).toBe("2100"); // 1000 + 1100
  });

  it("returns an empty curve when no bars are present", () => {
    const curve = reconstructSessionCurve({
      holdings: [holding],
      barsBySymbol: new Map(),
      baseFx: null,
      baseEur: new Decimal("100"),
      baseUsd: new Decimal("110"),
    });
    expect(curve).toEqual([]);
  });
});
