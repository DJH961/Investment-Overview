import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GrowthBars } from "./GrowthBars";

describe("GrowthBars", () => {
  it("draws gains up and losses down around a zero line", () => {
    const { container } = render(
      <GrowthBars
        ariaLabel="growth"
        bars={[
          { id: "a", label: "Jan 2026", value: 0.02 },
          { id: "b", label: "Feb 2026", value: -0.01 },
          { id: "c", label: "Mar 2026", value: null },
        ]}
      />,
    );
    expect(screen.getByRole("figure", { name: "growth" })).toBeInTheDocument();
    expect(container.querySelectorAll(".growth-bars__bar--pos")).toHaveLength(1);
    expect(container.querySelectorAll(".growth-bars__bar--neg")).toHaveLength(1);
    expect(screen.getByText("Jan 2026")).toBeInTheDocument();
    expect(screen.getByText("Mar 2026")).toBeInTheDocument();
  });

  it("renders nothing when every period is flat", () => {
    const { container } = render(<GrowthBars ariaLabel="g" bars={[{ id: "a", label: "x", value: 0 }]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("GrowthBars flat periods", () => {
  it("draws a flat period as a neutral mark, not as a gain, and an empty slot as nothing", () => {
    const { container } = render(
      <GrowthBars
        ariaLabel="g"
        bars={[
          { id: "a", label: "A", value: 0.02 },
          { id: "b", label: "B", value: 0 },
          { id: "c", label: "C", value: null },
        ]}
      />,
    );
    expect(container.querySelectorAll(".growth-bars__bar--pos")).toHaveLength(1);
    expect(container.querySelectorAll(".growth-bars__bar--zero")).toHaveLength(1);
  });
});
