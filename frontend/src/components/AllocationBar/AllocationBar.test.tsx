import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AllocationBar, sliceWidths } from "./AllocationBar";

describe("AllocationBar", () => {
  it("normalises widths to 100%", () => {
    const w = sliceWidths([
      { id: "a", label: "A", actual: 0.3 },
      { id: "b", label: "B", actual: 0.1 },
    ]);
    expect(w[0]).toBeCloseTo(75);
    expect(w[1]).toBeCloseTo(25);
  });

  it("renders segments with widths and drift in the legend", () => {
    render(
      <AllocationBar
        slices={[
          { id: "a", label: "Stocks", actual: 0.6, target: 0.5 },
          { id: "b", label: "Bonds", actual: 0.4, target: 0.5 },
        ]}
      />,
    );
    expect(screen.getByTestId("segment-a")).toHaveStyle({ width: "60%" });
    expect(screen.getByTestId("segment-b")).toHaveStyle({ width: "40%" });
    expect(screen.getByText("+10.0 pp")).toBeInTheDocument();
    expect(screen.getByText("-10.0 pp")).toBeInTheDocument();
  });
});
