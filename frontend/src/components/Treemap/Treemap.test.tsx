import { fireEvent, render, screen } from "@testing-library/react";
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

  it("names the tile's percentage in the tooltip next to the share", () => {
    render(
      <Treemap
        detailLabel="Today"
        valueFormat={(v) => `€${v}`}
        items={[
          { id: "a", label: "Alpha", value: 75, detail: "+1.20%" },
          { id: "b", label: "Beta", value: 25 },
        ]}
      />,
    );
    const cell = screen.getByTestId("cell-a");
    expect(cell).toHaveAccessibleName("Alpha, €75, 75.0% of total, Today +1.20%");
    fireEvent.pointerEnter(cell);
    const tip = document.querySelector(".treemap__tooltip") as HTMLElement;
    expect(tip).toHaveTextContent("75.0% of total");
    expect(tip).toHaveTextContent("Today +1.20%");
  });

  it("labels small tiles too, in the compact size", () => {
    render(
      <Treemap
        height={100}
        items={[
          { id: "big", label: "Big", value: 95 },
          { id: "small", label: "Small", value: 5 },
        ]}
      />,
    );
    const small = screen.getByTestId("cell-small");
    expect(small).toHaveClass("treemap__cell--compact");
    expect(small).toHaveTextContent("Small");
  });
});
