import { describe, expect, it } from "vitest";

import { Decimal } from "../src/decimal-config";
import {
  currentWeightsPct,
  expandCategoryWeights,
  planRebalance,
  roundTo100,
  scaleTo100,
} from "../src/allocation";

/**
 * Mirrors tests/domain/test_allocation.py so the browser port of the rebalance
 * math stays faithful to the desktop calculator.
 */
function map(entries: Record<string, number | string>): Map<string, Decimal> {
  return new Map(Object.entries(entries).map(([k, v]) => [k, new Decimal(v)]));
}

describe("planRebalance", () => {
  it("distributes proportionally for a brand-new portfolio", () => {
    const plan = planRebalance(new Decimal(1000), map({ A: 60, B: 40 }), new Map(), {
      currentPrices: map({ A: 10, B: 20 }),
    });
    const byId = new Map(plan.rows.map((r) => [r.symbol, r]));
    expect(byId.get("A")!.addValue.toString()).toBe("600");
    expect(byId.get("B")!.addValue.toString()).toBe("400");
    expect(byId.get("A")!.addShares.toString()).toBe("60");
    expect(byId.get("B")!.addShares.toString()).toBe("20");
    expect(plan.residualCash.toString()).toBe("0");
  });

  it("caps the gaps at the cash available", () => {
    const plan = planRebalance(new Decimal(100), map({ A: 50, B: 50 }), map({ A: 0, B: 0 }), {
      currentPrices: map({ A: 1, B: 1 }),
    });
    const total = plan.rows.reduce((acc, r) => acc.plus(r.addValue), new Decimal(0));
    expect(total.lessThanOrEqualTo(100)).toBe(true);
  });

  it("sends cash only to the under-weight fund when one is already over", () => {
    const plan = planRebalance(new Decimal(100), map({ A: 60, B: 40 }), map({ A: 1000, B: 0 }), {
      currentPrices: map({ A: 50, B: 10 }),
    });
    const byId = new Map(plan.rows.map((r) => [r.symbol, r]));
    expect(byId.get("A")!.addValue.toString()).toBe("0");
    expect(byId.get("B")!.addValue.toString()).toBe("100");
  });

  it("rounds fractional shares when allowed", () => {
    const plan = planRebalance(new Decimal(50), map({ A: 100 }), new Map(), {
      currentPrices: map({ A: 7 }),
      allowFractionalShares: true,
    });
    expect(plan.rows[0].addShares.toString()).toBe("7.1429");
  });

  it("floors whole shares and rolls the residual up", () => {
    const plan = planRebalance(new Decimal(50), map({ A: 100 }), new Map(), {
      currentPrices: map({ A: 7 }),
    });
    expect(plan.rows[0].addShares.toString()).toBe("7");
    expect(plan.rows[0].addValue.toString()).toBe("49");
    expect(plan.residualCash.toString()).toBe("1");
  });

  it("gives zero shares when no price is known", () => {
    const plan = planRebalance(new Decimal(100), map({ A: 100 }), new Map());
    expect(plan.rows[0].addShares.toString()).toBe("0");
    expect(plan.rows[0].addValue.toString()).toBe("100");
  });

  it("rejects weights that do not sum to 100", () => {
    expect(() => planRebalance(new Decimal(100), map({ A: 50, B: 40 }), new Map())).toThrow(
      /sum to 100/,
    );
  });

  it("rejects negative cash", () => {
    expect(() => planRebalance(new Decimal(-1), map({ A: 100 }), new Map())).toThrow(
      /non-negative/,
    );
  });

  it("never buys a no-buy fund but keeps it toward the target", () => {
    const plan = planRebalance(new Decimal(100), map({ A: 50, B: 50 }), map({ A: 0, B: 0 }), {
      currentPrices: map({ A: 1, B: 1 }),
      noBuyIds: new Set(["B"]),
    });
    const byId = new Map(plan.rows.map((r) => [r.symbol, r]));
    expect(byId.get("B")!.addValue.toString()).toBe("0");
    expect(byId.get("B")!.noBuy).toBe(true);
    // The whole 100 goes to the buyable fund A.
    expect(byId.get("A")!.addValue.toString()).toBe("100");
  });

  it("trims an over-weight fund when selling is allowed", () => {
    const plan = planRebalance(new Decimal(0), map({ A: 50, B: 50 }), map({ A: 1000, B: 0 }), {
      currentPrices: map({ A: 10, B: 10 }),
      allowSell: true,
    });
    const byId = new Map(plan.rows.map((r) => [r.symbol, r]));
    expect(byId.get("A")!.addValue.lessThan(0)).toBe(true);
    expect(byId.get("B")!.addValue.greaterThan(0)).toBe(true);
  });

  it("default buy-only mode never sells", () => {
    const plan = planRebalance(new Decimal(100), map({ A: 50, B: 50 }), map({ A: 1000, B: 0 }), {
      currentPrices: map({ A: 10, B: 10 }),
    });
    for (const r of plan.rows) expect(r.addValue.greaterThanOrEqualTo(0)).toBe(true);
  });
});

describe("currentWeightsPct", () => {
  it("returns each holding's share of the total", () => {
    const w = currentWeightsPct(map({ A: 75, B: 25 }));
    expect(w.get("A")!.toString()).toBe("75");
    expect(w.get("B")!.toString()).toBe("25");
  });

  it("is all zeros when the total is zero", () => {
    const w = currentWeightsPct(map({ A: 0, B: 0 }));
    expect(w.get("A")!.toString()).toBe("0");
    expect(w.get("B")!.toString()).toBe("0");
  });
});

describe("expandCategoryWeights", () => {
  it("splits a category's weight by member value", () => {
    const out = expandCategoryWeights(
      map({ Intl: 100 }),
      new Map([["Intl", ["A", "B"]]]),
      map({ A: 75, B: 25 }),
      "value",
    );
    expect(out.get("A")!.toString()).toBe("75");
    expect(out.get("B")!.toString()).toBe("25");
  });

  it("splits a category's weight evenly when asked", () => {
    const out = expandCategoryWeights(
      map({ Intl: 100 }),
      new Map([["Intl", ["A", "B"]]]),
      map({ A: 75, B: 25 }),
      "equal",
    );
    expect(out.get("A")!.toString()).toBe("50");
    expect(out.get("B")!.toString()).toBe("50");
  });

  it("falls back to an equal split when members have no value", () => {
    const out = expandCategoryWeights(
      map({ Intl: 100 }),
      new Map([["Intl", ["A", "B"]]]),
      new Map(),
      "value",
    );
    expect(out.get("A")!.toString()).toBe("50");
    expect(out.get("B")!.toString()).toBe("50");
  });

  it("skips zero-weight categories", () => {
    const out = expandCategoryWeights(
      map({ Intl: 0, US: 100 }),
      new Map([
        ["Intl", ["A"]],
        ["US", ["B"]],
      ]),
      map({ A: 1, B: 1 }),
    );
    expect(out.has("A")).toBe(false);
    expect(out.get("B")!.toString()).toBe("100");
  });

  it("raises when a weighted category has no members selected", () => {
    expect(() =>
      expandCategoryWeights(map({ Intl: 50 }), new Map([["Intl", []]]), new Map()),
    ).toThrow(/no funds selected/);
  });
});

describe("scaleTo100 / roundTo100", () => {
  it("normalises positive weights to sum to 100", () => {
    const out = scaleTo100(map({ A: 30, B: 10 }));
    expect(out.get("A")!.toString()).toBe("75");
    expect(out.get("B")!.toString()).toBe("25");
  });

  it("rounds to one decimal and absorbs the residual into the largest", () => {
    const out = roundTo100(map({ A: 33.33, B: 33.33, C: 33.34 }));
    let sum = new Decimal(0);
    for (const v of out.values()) sum = sum.plus(v);
    expect(sum.toString()).toBe("100");
  });
});
