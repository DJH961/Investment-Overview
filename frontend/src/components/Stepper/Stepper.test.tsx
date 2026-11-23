import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Stepper } from "./Stepper";

function Harness({ start, dp }: { start: string; dp: number }) {
  const [value, setValue] = useState(start);
  return <Stepper label="Total" value={value} dp={dp} onChange={setValue} />;
}

afterEach(() => vi.useRealTimers());

describe("Stepper", () => {
  it("minus is exactly one step down: 100.00 -> 99.99", async () => {
    render(<Harness start="100.00" dp={2} />);
    await userEvent.click(screen.getByRole("button", { name: /Total: decrease by 0\.01/ }));
    expect(screen.getByRole("button", { name: /Total: 99\.99\./ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Total: increase by 0\.01/ }));
    expect(screen.getByRole("button", { name: /Total: 100\.00\./ })).toBeInTheDocument();
  });

  it("a quick press steps once; holding repeats and stops on release", () => {
    vi.useFakeTimers();
    render(<Harness start="100.00" dp={2} />);
    const minus = screen.getByRole("button", { name: /decrease/ });
    fireEvent.pointerDown(minus, { button: 0 });
    fireEvent.pointerUp(minus);
    expect(screen.getByRole("button", { name: /Total: 99\.99\./ })).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(2000));
    expect(screen.getByRole("button", { name: /Total: 99\.99\./ })).toBeInTheDocument(); // released: no drift
    fireEvent.pointerDown(minus, { button: 0 });
    act(() => void vi.advanceTimersByTime(800));
    fireEvent.pointerUp(minus);
    const held = screen.getByRole("button", { name: /Total: 99\.\d\d\./ }).getAttribute("aria-label") ?? "";
    const value = Number(/Total: ([\d.]+)\./.exec(held)?.[1]);
    expect(value).toBeLessThan(99.99); // only ever downwards
    expect(value).toBeGreaterThan(99.9);
  });

  it("leaving the button while held stops the repeat", () => {
    vi.useFakeTimers();
    render(<Harness start="50.00" dp={2} />);
    const plus = screen.getByRole("button", { name: /increase/ });
    fireEvent.pointerDown(plus, { button: 0 });
    fireEvent.pointerLeave(plus);
    const after = screen.getByRole("button", { name: /Total: [\d.]+\./ }).getAttribute("aria-label");
    act(() => void vi.advanceTimersByTime(3000));
    expect(screen.getByRole("button", { name: /Total: [\d.]+\./ }).getAttribute("aria-label")).toBe(after);
  });
});
