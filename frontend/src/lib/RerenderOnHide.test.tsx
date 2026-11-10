import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { formatQuantity } from "./format";
import { HideAmountsProvider, useHideAmounts } from "./hideAmounts";
import { RerenderOnHide } from "./RerenderOnHide";

function Page() {
  const [draft, setDraft] = useState("");
  return (
    <div>
      <input aria-label="draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
      <output>{formatQuantity(1234)}</output>
    </div>
  );
}

function Toggle() {
  const { toggle } = useHideAmounts();
  return <button onClick={toggle}>flip</button>;
}

describe("RerenderOnHide", () => {
  it("re-formats the page on a flip but keeps its state", () => {
    window.localStorage.clear();
    render(
      <HideAmountsProvider>
        <Toggle />
        <RerenderOnHide>
          <Page />
        </RerenderOnHide>
      </HideAmountsProvider>,
    );
    const input = screen.getByLabelText("draft") as HTMLInputElement;
    act(() => {
      input.focus();
    });
    // type through React's value setter
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "half-typed");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(screen.getByRole("status", { hidden: true }).textContent).not.toContain("•");
    act(() => screen.getByText("flip").click());
    expect(screen.getByRole("status", { hidden: true }).textContent).toContain("•");
    expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe("half-typed");
    expect(screen.getByLabelText("draft")).toBe(input);
  });
});
