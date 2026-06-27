import { describe, expect, it } from "vitest";
import type { HoldingView } from "../src/compute";
import { holdingPriceLabel } from "../src/ui";

describe("holdingPriceLabel", () => {
  it("uses CASH for money-market holdings that price by NAV", () => {
    const holding = { priceType: "nav", isMoneyMarket: true } as Pick<HoldingView, "priceType" | "isMoneyMarket">;
    expect(holdingPriceLabel(holding)).toBe("CASH");
  });

  it("keeps NAV for non-money-market holdings that price by NAV", () => {
    const holding = { priceType: "nav", isMoneyMarket: false } as Pick<HoldingView, "priceType" | "isMoneyMarket">;
    expect(holdingPriceLabel(holding)).toBe("NAV");
  });

  it("returns null for market-priced holdings", () => {
    const holding = { priceType: "market", isMoneyMarket: false } as Pick<HoldingView, "priceType" | "isMoneyMarket">;
    expect(holdingPriceLabel(holding)).toBeNull();
  });
});
