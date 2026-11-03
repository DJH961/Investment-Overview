import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { HideAmountsProvider, useHideAmounts } from "../../lib/hideAmounts";
import { setHideAmounts } from "../../lib/format";
import { Money } from "./Money";

function Toggle() {
  const { toggle } = useHideAmounts();
  return (
    <button type="button" onClick={toggle}>
      flip
    </button>
  );
}

afterEach(() => {
  setHideAmounts(false);
  localStorage.clear();
});

describe("Money in hide mode", () => {
  it("shows the amount by default and masks it after the toggle, persisting per device", async () => {
    render(
      <HideAmountsProvider>
        <Toggle />
        <Money amount={1234.5} currency="EUR" />
      </HideAmountsProvider>,
    );
    expect(screen.getByText(/1,234\.50/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "flip" }));
    expect(screen.queryByText(/1,234/)).toBeNull();
    expect(screen.getByLabelText("hidden amount")).toHaveTextContent("€••,•••.••");
    expect(localStorage.getItem("iv.privacy.hideAmounts")).toBe("true");
  });
});
