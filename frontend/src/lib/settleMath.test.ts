import { describe, expect, it } from "vitest";
import {
  allInRate,
  effectiveDp,
  sigDecimals,
  formatDec,
  holdDelay,
  parseDec,
  relinkBuy,
  relinkConversion,
  splitAtStep,
  stepDecimal,
  toDp,
} from "./settleMath";

const P = { priceDp: 4, quantityDp: 4, moneyDp: 2 };

describe("decimal text", () => {
  it("parses and formats without floats", () => {
    expect(parseDec("0.1")).toEqual({ n: 1n, s: 1 });
    expect(formatDec(parseDec("249.9")!, 4)).toBe("249.9000");
    expect(toDp("0.1", 2)).toBe("0.10");
    expect(toDp("2.675", 2)).toBe("2.68"); // half away from zero, exact (a float gives 2.67)
    expect(parseDec("abc")).toBeNull();
    expect(parseDec("1,5")).toEqual({ n: 15n, s: 1 });
  });
});

describe("stepDecimal", () => {
  it("moves the last stored decimal", () => {
    expect(stepDecimal("249.9000", 4, 1)).toBe("249.9001");
    expect(stepDecimal("249.9000", 4, -1)).toBe("249.8999");
    expect(stepDecimal("499.80", 2, 1)).toBe("499.81");
    expect(stepDecimal("1.234", 3, -1)).toBe("1.233");
  });
  it("carries across the decimal point and the x10 toggle", () => {
    expect(stepDecimal("0.9999", 4, 1)).toBe("1.0000");
    expect(stepDecimal("1.0000", 4, -1)).toBe("0.9999");
    expect(stepDecimal("10.00", 2, 1, 10)).toBe("10.10");
  });
  it("adds exactly and never goes below zero", () => {
    expect(stepDecimal("0.1", 1, 1)).toBe("0.2");
    expect(stepDecimal("0.0000", 4, -1)).toBe("0.0000");
    expect(stepDecimal("", 2, 1)).toBe("0.01");
  });
  it("rounds an over-precise value to the stored precision before stepping", () => {
    expect(stepDecimal("1.23456", 4, 1)).toBe("1.2347");
  });
});

describe("splitAtStep", () => {
  it("names the digit a step moves", () => {
    expect(splitAtStep("249.9001")).toEqual({ head: "249.900", digit: "1", tail: "" });
    expect(splitAtStep("249.9001", 10)).toEqual({ head: "249.90", digit: "0", tail: "1" });
    expect(splitAtStep("10.0", 10)).toEqual({ head: "1", digit: "0", tail: ".0" });
  });
});

describe("relinkBuy (golden: $500 at 250.00, settled at 249.90 for $499.80)", () => {
  const draft = { price: "250.0000", quantity: "2.0000", total: "500.00" };
  it("keeps the plan's fixed amount and moves the quantity with the price", () => {
    expect(relinkBuy("price", { ...draft, price: "249.9000" }, "total", P)).toEqual({
      price: "249.9000",
      quantity: "2.0008",
      total: "500.00",
    });
  });
  it("a typed total follows at the same price", () => {
    expect(relinkBuy("total", { ...draft, price: "249.9000", total: "499.80" }, "total", P)).toEqual({
      price: "249.9000",
      quantity: "2.0000",
      total: "499.80",
    });
  });
  it("an edited quantity re-derives the price from the fixed amount", () => {
    expect(relinkBuy("quantity", { ...draft, quantity: "2.0008" }, "total", P).price).toBe("249.9000");
  });
  it("a shares plan keeps the quantity and moves the total", () => {
    expect(relinkBuy("price", { price: "249.9000", quantity: "2.0000", total: "500.00" }, "quantity", P)).toEqual({
      price: "249.9000",
      quantity: "2.0000",
      total: "499.80",
    });
  });
  it("leaves things alone while a field is not a number", () => {
    expect(relinkBuy("price", { ...draft, price: "" }, "total", P)).toEqual({ ...draft, price: "" });
  });
});

describe("relinkConversion (EUR sent fixed from the plan)", () => {
  it("received -> rate and rate -> received", () => {
    expect(relinkConversion("received", { received: "598.50", rate: "" }, "500").rate).toBe("1.1970");
    expect(relinkConversion("rate", { received: "", rate: "1.1971" }, "500").received).toBe("598.55");
  });
  it("shows the all-in rate with the fee", () => {
    expect(allInRate("500", "2.50", "598.50")).toBe("1.1910");
    expect(allInRate("500", "", "")).toBe("");
  });
});

describe("the precision a stepper moves", () => {
  it("drops padding zeros so the moving digit is the last one shown", () => {
    expect(sigDecimals("259.903400")).toBe(4);
    expect(sigDecimals("250.000000")).toBe(0);
    expect(effectiveDp("259.903400", 6)).toBe(4);
    expect(effectiveDp("250.000000", 6)).toBe(2);
    expect(effectiveDp("259.9034567", 4)).toBe(4);
    expect(effectiveDp("2.5", 6)).toBe(2);
  });
});

describe("holdDelay", () => {
  it("speeds up gently while held", () => {
    const delays = [0, 3, 8, 20].map(holdDelay);
    expect(delays).toEqual([380, 160, 80, 45]);
  });
});
