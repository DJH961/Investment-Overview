import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AllocationBar } from "./AllocationBar";

const slices = [
  { id: "a", label: "Stocks", actual: 0.6 },
  { id: "b", label: "Bonds", actual: 0.3 },
  { id: "c", label: "Cash", actual: 0.1 },
];

describe("AllocationBar non-colour cues", () => {
  it("prints the share in wide segments, hatches every second one", () => {
    const { container } = render(<AllocationBar slices={slices} />);
    expect(screen.getByTestId("segment-a")).toHaveTextContent("60%");
    expect(screen.getByTestId("segment-b")).toHaveTextContent("30%");
    expect(screen.getByTestId("segment-b")).toHaveClass("allocation-bar__segment--hatched");
    expect(screen.getByTestId("segment-a")).not.toHaveClass("allocation-bar__segment--hatched");
    expect(container.querySelectorAll(".allocation-bar__swatch--hatched")).toHaveLength(1);
  });

  it("leaves tiny segments unlabelled and links a hovered segment to the others", () => {
    render(<AllocationBar slices={[...slices.slice(0, 2), { id: "d", label: "Gold", actual: 0.02 }]} />);
    expect(screen.getByTestId("segment-d")).toBeEmptyDOMElement();
    fireEvent.pointerEnter(screen.getByTestId("segment-a"));
    expect(screen.getByTestId("segment-b")).toHaveClass("allocation-bar__segment--dim");
    expect(screen.getByTestId("segment-a")).not.toHaveClass("allocation-bar__segment--dim");
    fireEvent.pointerLeave(screen.getByTestId("segment-a"));
    expect(screen.getByTestId("segment-b")).not.toHaveClass("allocation-bar__segment--dim");
  });
});
