import { describe, expect, it } from "vitest";
import { rebalancePath } from "../../lib/queries/manage";
import { totalWeight } from "./Allocations";

describe("Allocations helpers", () => {
  it("sums typed weights live, ignoring junk", () => {
    expect(totalWeight([{ weight: "60" }, { weight: "25.5" }, { weight: "abc" }])).toBe(85.5);
  });

  it("builds the rebalance query", () => {
    const path = rebalancePath({ amount: "1000", ccy: "EUR", fractional: true, allowSell: false, targetId: 3 });
    expect(path).toBe("/api/allocations/rebalance?amount=1000&ccy=EUR&fractional=true&allow_sell=false&target_id=3");
  });
});
