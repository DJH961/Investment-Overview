import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToastProvider, useToast } from "./Toast";

function Fire({ tone }: { tone: "success" | "error" | "neutral" }) {
  const { toast } = useToast();
  return (
    <button type="button" onClick={() => toast({ title: "Saved", description: "All good", tone })}>
      fire
    </button>
  );
}

describe("Toast", () => {
  it("carries a tone icon (not colour alone) and can be dismissed", () => {
    const { container } = render(
      <ToastProvider>
        <Fire tone="error" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("fire"));
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(container.ownerDocument.querySelector(".toast__icon")).not.toBeNull();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    });
    expect(container.ownerDocument.querySelector(".toast--error[data-state='open']")).toBeNull();
  });
});
