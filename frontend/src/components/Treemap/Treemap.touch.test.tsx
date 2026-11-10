import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Treemap } from "./Treemap";

const items = [
  { id: "a", label: "Alpha", value: 75 },
  { id: "b", label: "Beta", value: 25 },
];

describe("Treemap tiles and tooltip", () => {
  it("does not make dead tab stops of the tiles unless they do something", () => {
    render(<Treemap items={items} />);
    expect(screen.getByTestId("cell-a")).toHaveAttribute("tabindex", "-1");
  });

  it("makes the tiles real buttons when given a select action", () => {
    const onSelect = vi.fn();
    render(<Treemap items={items} onSelect={onSelect} />);
    const cell = screen.getByTestId("cell-a");
    expect(cell).not.toHaveAttribute("tabindex");
    fireEvent.click(cell);
    expect(onSelect).toHaveBeenCalledWith("a");
  });

  it("keeps the tooltip open after a touch tap until the next tap elsewhere", () => {
    render(<Treemap items={items} />);
    const cell = screen.getByTestId("cell-a");
    fireEvent.pointerDown(cell, { pointerType: "touch" });
    fireEvent.pointerLeave(cell, { pointerType: "touch" });
    expect(document.querySelector(".treemap__tooltip")).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(document.querySelector(".treemap__tooltip")).toBeNull();
  });

  it("still closes the tooltip when a mouse leaves the tile", () => {
    render(<Treemap items={items} />);
    const cell = screen.getByTestId("cell-a");
    fireEvent.pointerEnter(cell);
    expect(document.querySelector(".treemap__tooltip")).not.toBeNull();
    fireEvent.pointerLeave(cell, { pointerType: "mouse" });
    expect(document.querySelector(".treemap__tooltip")).toBeNull();
  });
});
