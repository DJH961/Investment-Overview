import { describe, expect, it } from "vitest";
import { parseDecimal, toApiDecimal } from "./parseDecimal";

describe("parseDecimal", () => {
  it.each([
    ["12.5", 12.5],
    ["12,5", 12.5],
    [" 7 ", 7],
    ["1.234,56", 1234.56],
    ["1,234.56", 1234.56],
    ["1 234,5", 1234.5],
    ["1.234.567", 1234567],
    ["-3,25", -3.25],
    ["0", 0],
    [".5", 0.5],
  ])("parses %s", (input, expected) => {
    expect(parseDecimal(input)).toBe(expected);
  });

  it.each(["", "  ", "abc", "1.2.3,4", "12a", ",", ".", "-", "1,2,3"])(
    "returns null for %j",
    (input) => {
      expect(parseDecimal(input)).toBeNull();
    },
  );
});

describe("toApiDecimal", () => {
  it("keeps full precision with a dot", () => {
    expect(toApiDecimal("0,123456789012")).toBe("0.123456789012");
    expect(toApiDecimal("1.234,56")).toBe("1234.56");
    expect(toApiDecimal("x")).toBeNull();
  });
});
