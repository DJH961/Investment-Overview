/**
 * The value/equity charts overlay the *other* currency as a second line, rebased
 * to share the primary line's start so EUR and USD diverge by the FX move rather
 * than sitting a flat ~1.08× apart on the shared y-axis. The overlay is opt-in:
 * it appears only when a live FX rate is known and the other currency genuinely
 * has data, keeping the mobile-first chart uncluttered.
 */
import Decimal from "decimal.js";
import { afterEach, describe, expect, it } from "vitest";

import { setDisplayCurrency, setEurUsdRate } from "../src/currency";
import { rebaseToAnchor, secondaryCurrencyLine } from "../src/ui";

type Disp = Parameters<typeof secondaryCurrencyLine>[0];

/** A throwaway CurveDisplay — secondaryCurrencyLine only reads `.code`. */
function disp(code: "EUR" | "USD"): Disp {
  return { code } as unknown as Disp;
}

function nums(values: Array<Decimal | null>): Array<number | null> {
  return values.map((v) => (v === null ? null : v.toNumber()));
}

afterEach(() => {
  setDisplayCurrency("EUR");
  setEurUsdRate(null);
});

describe("rebaseToAnchor", () => {
  it("rescales values so both lines start at the reference's anchor", () => {
    const reference = [new Decimal("30000"), new Decimal("31000"), new Decimal("33000")];
    const other = [new Decimal("32400"), new Decimal("33480"), new Decimal("34000")];
    const out = rebaseToAnchor(other, reference);
    expect(out).not.toBeNull();
    // Anchored: index 0 coincides exactly with the reference anchor.
    expect(out![0]!.toNumber()).toBeCloseTo(30000, 6);
    // The shape is preserved (other[1]/other[0] × anchor).
    expect(out![1]!.toNumber()).toBeCloseTo(30000 * (33480 / 32400), 6);
  });

  it("anchors on the first usable positive reference, preserving gaps", () => {
    const reference = [null, new Decimal("0"), new Decimal("40000"), new Decimal("42000")];
    const other = [new Decimal("1"), new Decimal("2"), new Decimal("43200"), null];
    const out = rebaseToAnchor(other, reference);
    expect(out).not.toBeNull();
    // Anchor index is 2 (first positive reference); that point matches exactly.
    expect(out![2]!.toNumber()).toBeCloseTo(40000, 6);
    expect(out![3]).toBeNull();
  });

  it("returns null when there is no usable anchor pair", () => {
    expect(rebaseToAnchor([new Decimal("1")], [null])).toBeNull();
    expect(rebaseToAnchor([null], [new Decimal("100")])).toBeNull();
  });
});

describe("secondaryCurrencyLine", () => {
  const primary = [new Decimal("30000"), new Decimal("31000")];

  it("overlays the rebased USD companion when EUR is shown and FX is known", () => {
    setDisplayCurrency("EUR");
    setEurUsdRate(new Decimal("1.08"));
    const usd = [new Decimal("32400"), new Decimal("34000")];
    const line = secondaryCurrencyLine(disp("EUR"), usd, primary);
    expect(line).not.toBeNull();
    expect(line!.code).toBe("USD");
    // Rebased to the EUR primary's start, then diverges by the FX/return move.
    expect(nums(line!.values)[0]).toBeCloseTo(30000, 6);
    expect(line!.values[1]!.toNumber()).toBeCloseTo(30000 * (34000 / 32400), 6);
  });

  it("overlays the EUR pivot when USD is the display currency", () => {
    setDisplayCurrency("USD");
    setEurUsdRate(new Decimal("1.08"));
    const eurPivot = [new Decimal("27000"), new Decimal("28000")];
    const line = secondaryCurrencyLine(disp("USD"), eurPivot, primary);
    expect(line).not.toBeNull();
    expect(line!.code).toBe("EUR");
    expect(nums(line!.values)[0]).toBeCloseTo(30000, 6);
  });

  it("is omitted when no live FX rate is known", () => {
    setEurUsdRate(null);
    const usd = [new Decimal("32400"), new Decimal("34000")];
    expect(secondaryCurrencyLine(disp("EUR"), usd, primary)).toBeNull();
  });

  it("is omitted when the other currency has no data (EUR-only export)", () => {
    setEurUsdRate(new Decimal("1.08"));
    expect(secondaryCurrencyLine(disp("EUR"), [null, null], primary)).toBeNull();
  });
});
