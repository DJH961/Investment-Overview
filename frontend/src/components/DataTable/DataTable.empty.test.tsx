import { describe, expect, it } from "vitest";
import { Money } from "../Money";
import { Percent } from "../Percent";
import { isEmptyCell } from "./DataTable";

describe("isEmptyCell", () => {
  it("treats blank and dash strings as empty", () => {
    expect(isEmptyCell(null)).toBe(true);
    expect(isEmptyCell(" – ")).toBe(true);
    expect(isEmptyCell("Fee")).toBe(false);
  });

  it("treats Money and Percent with no value as empty (they render the dash)", () => {
    expect(isEmptyCell(<Money amount={null} currency="EUR" />)).toBe(true);
    expect(isEmptyCell(<Percent ratio={undefined} />)).toBe(true);
    expect(isEmptyCell(<Money amount={0} currency="EUR" />)).toBe(false);
    expect(isEmptyCell(<Percent ratio={0.01} />)).toBe(false);
  });
});
