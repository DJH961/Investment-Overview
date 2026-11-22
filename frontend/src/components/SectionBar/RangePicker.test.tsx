import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const media = vi.hoisted(() => ({ phone: false }));
vi.mock("../../lib/useMediaQuery", () => ({ useIsPhone: () => media.phone }));

import { RangePicker } from "./RangePicker";

const options = [
  { value: "1y", label: "1Y" },
  { value: "all", label: "All", hint: "All, since you started" },
  { value: "max", label: "Max" },
];

beforeEach(() => {
  media.phone = false;
});

describe("RangePicker", () => {
  it("tablet and up: every range is one button, the current one pressed", async () => {
    const onChange = vi.fn();
    render(<RangePicker label="Range" options={options} value="all" emphasis="all" onChange={onChange} />);
    expect(screen.getByRole("radiogroup", { name: "Range" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "All, since you started" })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: "1Y" }));
    expect(onChange).toHaveBeenCalledWith("1y");
  });

  it("phone: one chip names the current range and opens a menu of every range", async () => {
    media.phone = true;
    const onChange = vi.fn();
    render(<RangePicker label="Range" options={options} value="all" onChange={onChange} />);
    const chip = screen.getByRole("button", { name: "Range: All, since you started" });
    expect(chip).toHaveTextContent("All");
    await userEvent.click(chip);
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "1Y" }));
    expect(onChange).toHaveBeenCalledWith("1y");
  });
});
