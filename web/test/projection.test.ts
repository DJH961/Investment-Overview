/**
 * Projection engine tests — mirror of tests/ui/test_projection_model.py.
 *
 * Tests are deterministic: a fixed `start` date is always passed so behaviour
 * does not depend on today's date.
 */
import { describe, expect, it } from "vitest";

import { Decimal } from "../src/decimal-config";
import {
  FALLBACK_EXPECTED_RATE,
  SCENARIO_EXPECTED,
  SCENARIO_OPTIMISTIC,
  SCENARIO_PESSIMISTIC,
  bandRates,
  defaultExpectedRate,
  finalNominal,
  finalPoint,
  requiredContribution,
  sanitizeRate,
  simulate,
  timeToTarget,
  totalContributed,
  type ProjectionParams,
} from "../src/projection";

// Fixed reference date used in all tests (mirrors Python's `date(2025, 1, 1)`).
const START = new Date(Date.UTC(2025, 0, 1));

/** Build a base ProjectionParams, overrideable per test. */
function makeParams(overrides: Partial<ProjectionParams> = {}): ProjectionParams {
  return {
    startingValue: new Decimal("1000"),
    baseContribution: new Decimal("100"),
    periods: 12,
    periodsPerYear: 1,
    annualRates: bandRates(new Decimal("0.07"), new Decimal("0.03")),
    start: START,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// sanitizeRate / defaultExpectedRate
// ---------------------------------------------------------------------------

describe("defaultExpectedRate", () => {
  it("uses the XIRR when present", () => {
    expect(defaultExpectedRate(new Decimal("0.085")).toString()).toBe("0.085");
  });

  it("falls back to FALLBACK_EXPECTED_RATE when null", () => {
    expect(defaultExpectedRate(null).equals(FALLBACK_EXPECTED_RATE)).toBe(true);
  });
});

describe("sanitizeRate", () => {
  it("clamps values above the ceiling to 0.40", () => {
    expect(sanitizeRate(new Decimal("9.0")).toNumber()).toBe(0.40);
  });

  it("clamps values below the floor to -0.50", () => {
    expect(sanitizeRate(new Decimal("-2.0")).toNumber()).toBe(-0.50);
  });

  it("leaves in-range values unchanged", () => {
    expect(sanitizeRate(new Decimal("0.10")).toNumber()).toBe(0.10);
  });

  it("returns FALLBACK_EXPECTED_RATE for null", () => {
    expect(sanitizeRate(null).equals(FALLBACK_EXPECTED_RATE)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// bandRates
// ---------------------------------------------------------------------------

describe("bandRates", () => {
  it("fans out symmetrically", () => {
    const rates = bandRates(new Decimal("0.07"), new Decimal("0.03"));
    expect(rates[SCENARIO_PESSIMISTIC].toNumber()).toBe(0.04);
    expect(rates[SCENARIO_EXPECTED].toNumber()).toBe(0.07);
    expect(rates[SCENARIO_OPTIMISTIC].toNumber()).toBeCloseTo(0.10, 10);
  });

  it("floors the pessimistic scenario at -0.99", () => {
    const rates = bandRates(new Decimal("0.05"), new Decimal("2.0"));
    expect(rates[SCENARIO_PESSIMISTIC].toString()).toBe("-0.99");
  });
});

// ---------------------------------------------------------------------------
// simulate
// ---------------------------------------------------------------------------

describe("simulate", () => {
  it("zero growth yearly: just sums contributions", () => {
    const result = simulate(
      makeParams({
        annualRates: { [SCENARIO_EXPECTED]: new Decimal("0") },
        periods: 3,
      }),
    );
    const finals = result.points.map((p) => p.nominalByScenario[SCENARIO_EXPECTED]);
    expect(finals[0].toString()).toBe("1100");
    expect(finals[1].toString()).toBe("1200");
    expect(finals[2].toString()).toBe("1300");
    expect(result.points.map((p) => p.label)).toEqual(["2026", "2027", "2028"]);
    expect(totalContributed(result).toString()).toBe("300");
  });

  it("optimistic > expected > pessimistic band ordering", () => {
    const result = simulate(makeParams());
    const last = finalPoint(result)!;
    expect(
      last.nominalByScenario[SCENARIO_PESSIMISTIC].lessThan(
        last.nominalByScenario[SCENARIO_EXPECTED],
      ),
    ).toBe(true);
    expect(
      last.nominalByScenario[SCENARIO_EXPECTED].lessThan(
        last.nominalByScenario[SCENARIO_OPTIMISTIC],
      ),
    ).toBe(true);
  });

  it("monthly mode compounds at the monthly rate", () => {
    const result = simulate(
      makeParams({
        startingValue: new Decimal("1000"),
        baseContribution: new Decimal("0"),
        periods: 12,
        periodsPerYear: 12,
        annualRates: { [SCENARIO_EXPECTED]: new Decimal("0.12") },
      }),
    );
    // 12 months of 12% annual compounding ≈ 1120.
    const last = finalPoint(result)!.nominalByScenario[SCENARIO_EXPECTED];
    expect(last.greaterThan(new Decimal("1119"))).toBe(true);
    expect(last.lessThan(new Decimal("1121"))).toBe(true);
    // First monthly period label.
    expect(result.points[0].label).toBe("2025-02");
  });

  it("annual step-up increases later contributions", () => {
    const flat = simulate(
      makeParams({
        annualContributionGrowth: new Decimal("0"),
        periods: 3,
        annualRates: { [SCENARIO_EXPECTED]: new Decimal("0") },
      }),
    );
    const grown = simulate(
      makeParams({
        annualContributionGrowth: new Decimal("0.10"),
        periods: 3,
        annualRates: { [SCENARIO_EXPECTED]: new Decimal("0") },
      }),
    );
    // Year 1 same (contribution of 100); later years larger with step-up.
    expect(grown.points[0].contributed.equals(flat.points[0].contributed)).toBe(true);
    expect(
      grown.points[grown.points.length - 1].contributed.greaterThan(
        flat.points[flat.points.length - 1].contributed,
      ),
    ).toBe(true);
  });

  it("real value is below nominal when inflation > 0", () => {
    const result = simulate(makeParams({ inflationRate: new Decimal("0.03") }));
    const last = finalPoint(result)!;
    expect(
      last.realByScenario[SCENARIO_EXPECTED].lessThan(
        last.nominalByScenario[SCENARIO_EXPECTED],
      ),
    ).toBe(true);
  });

  it("zero inflation: real equals nominal", () => {
    const result = simulate(makeParams({ inflationRate: new Decimal("0") }));
    const last = finalPoint(result)!;
    expect(
      last.realByScenario[SCENARIO_EXPECTED].equals(
        last.nominalByScenario[SCENARIO_EXPECTED],
      ),
    ).toBe(true);
  });

  it("throws on negative periods", () => {
    expect(() => simulate(makeParams({ periods: -1 }))).toThrow("non-negative");
  });

  it("throws when periodsPerYear < 1", () => {
    expect(() => simulate(makeParams({ periodsPerYear: 0 }))).toThrow(">= 1");
  });

  it("zero periods produces empty points array", () => {
    const result = simulate(makeParams({ periods: 0 }));
    expect(result.points).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// timeToTarget
// ---------------------------------------------------------------------------

describe("timeToTarget", () => {
  it("optimistic reaches target no later than pessimistic", () => {
    const result = simulate(makeParams({ periods: 40 }));
    const hits = timeToTarget(result, new Decimal("3000"));
    expect(hits[SCENARIO_OPTIMISTIC]).not.toBeNull();
    expect(hits[SCENARIO_PESSIMISTIC]).not.toBeNull();
    expect(hits[SCENARIO_OPTIMISTIC]!.index).toBeLessThanOrEqual(
      hits[SCENARIO_PESSIMISTIC]!.index,
    );
  });

  it("returns null when target is not reached within the horizon", () => {
    const result = simulate(makeParams({ periods: 1 }));
    expect(timeToTarget(result, new Decimal("10000000"))[SCENARIO_EXPECTED]).toBeNull();
  });

  it("returns all nulls when target ≤ 0", () => {
    const result = simulate(makeParams({ periods: 10 }));
    const hits = timeToTarget(result, new Decimal("0"));
    for (const hit of Object.values(hits)) {
      expect(hit).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// requiredContribution
// ---------------------------------------------------------------------------

describe("requiredContribution", () => {
  it("bisection finds a contribution that hits the target", () => {
    const params = makeParams({
      periods: 10,
      annualRates: bandRates(new Decimal("0.07"), new Decimal("0.03")),
    });
    const target = new Decimal("50000");
    const needed = requiredContribution(params, target);
    expect(needed).not.toBeNull();

    // Plug the solved contribution back in and verify it reaches (≈) the target.
    const solved = finalNominal(
      simulate({
        startingValue: params.startingValue,
        baseContribution: needed!,
        periods: params.periods,
        periodsPerYear: params.periodsPerYear,
        annualRates: { [SCENARIO_EXPECTED]: params.annualRates[SCENARIO_EXPECTED] },
        start: params.start,
      }),
      SCENARIO_EXPECTED,
    );
    expect(solved.greaterThanOrEqualTo(target.times("0.999"))).toBe(true);
  });

  it("returns ZERO when the target is already met with no contributions", () => {
    const params = makeParams({ startingValue: new Decimal("100000"), periods: 10 });
    expect(requiredContribution(params, new Decimal("1000"))!.toString()).toBe("0");
  });

  it("returns null for a zero-period horizon", () => {
    expect(requiredContribution(makeParams({ periods: 0 }), new Decimal("50000"))).toBeNull();
  });

  it("returns null for a non-positive target", () => {
    expect(requiredContribution(makeParams(), new Decimal("0"))).toBeNull();
    expect(requiredContribution(makeParams(), new Decimal("-1"))).toBeNull();
  });
});
