import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { squarify, Treemap } from "./Treemap";

describe("squarify", () => {
  const items = [
    { id: "a", value: 50 },
    { id: "b", value: 25 },
    { id: "c", value: 15 },
    { id: "d", value: 10 },
    { id: "z", value: 0 },
  ];

  it("tiles exactly the whole area, proportionally", () => {
    const rects = squarify(items, 400, 200);
    expect(rects).toHaveLength(4);
    const area = rects.reduce((a, r) => a + r.w * r.h, 0);
    expect(area).toBeCloseTo(400 * 200, 6);
    const a = rects.find((r) => r.id === "a")!;
    expect(a.w * a.h).toBeCloseTo(0.5 * 400 * 200, 6);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(-1e-9);
      expect(r.y).toBeGreaterThanOrEqual(-1e-9);
      expect(r.x + r.w).toBeLessThanOrEqual(400 + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(200 + 1e-6);
    }
  });

  it("returns nothing for empty input", () => {
    expect(squarify([], 100, 100)).toEqual([]);
  });
});

describe("Treemap", () => {
  it("renders a cell per positive item", () => {
    render(
      <Treemap
        items={[
          { id: "a", label: "Alpha", value: 70 },
          { id: "b", label: "Beta", value: 30, tone: "neg" },
        ]}
      />,
    );
    expect(screen.getByTestId("cell-a")).toBeInTheDocument();
    expect(screen.getByTestId("cell-b")).toHaveClass("treemap__cell--neg");
  });
});
