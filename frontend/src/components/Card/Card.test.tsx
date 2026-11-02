import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Card } from "./Card";

afterEach(() => localStorage.clear());

describe("Card", () => {
  it("renders a plain heading without a toggle by default", () => {
    render(<Card title="Plain">body</Card>);
    expect(screen.getByRole("heading", { name: "Plain" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("body")).toBeVisible();
  });

  it("folds and unfolds with the header button and the keyboard", async () => {
    const user = userEvent.setup();
    render(
      <Card title="Movers" collapsible actions={<span>action</span>}>
        body
      </Card>,
    );
    const toggle = screen.getByRole("button", { name: "Movers" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(toggle.getAttribute("aria-controls") ?? "")).not.toBeNull();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("body")).toBeNull();
    expect(screen.queryByText("action")).toBeNull();
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await user.keyboard(" ");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("honours defaultOpen", () => {
    render(
      <Card title="Closed" collapsible defaultOpen={false}>
        body
      </Card>,
    );
    expect(screen.getByRole("button", { name: "Closed" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("body")).toBeNull();
  });

  it("remembers the fold state per collapsibleId", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Card title="Alloc" collapsibleId="test.alloc">body</Card>);
    await user.click(screen.getByRole("button", { name: "Alloc" }));
    expect(localStorage.getItem("iv.fold.test.alloc")).toBe("false");
    unmount();
    render(<Card title="Alloc" collapsibleId="test.alloc">body</Card>);
    expect(screen.getByRole("button", { name: "Alloc" })).toHaveAttribute("aria-expanded", "false");
  });

  it("ignores a corrupt stored value", () => {
    localStorage.setItem("iv.fold.test.bad", '"yes"');
    render(<Card title="Bad" collapsibleId="test.bad">body</Card>);
    expect(screen.getByRole("button", { name: "Bad" })).toHaveAttribute("aria-expanded", "true");
  });
});
