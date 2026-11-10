import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { useLeaveGuard } from "./useLeaveGuard";

function Dirty({ when, onLeave }: { when: boolean; onLeave?: () => void }) {
  const guard = useLeaveGuard({
    when,
    title: "Leave this page?",
    description: "Unsaved work will be lost.",
    leaveLabel: "Discard and leave",
    onLeave,
  });
  return (
    <div>
      <Link to="/other">go</Link>
      {guard}
    </div>
  );
}

function setup(when: boolean, onLeave?: () => void) {
  const router = createMemoryRouter(
    [
      { path: "/", element: <Dirty when={when} onLeave={onLeave} /> },
      { path: "/other", element: <p>other page</p> },
    ],
    { initialEntries: ["/"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("useLeaveGuard", () => {
  it("lets navigation through when nothing is unsaved", async () => {
    setup(false);
    await userEvent.click(screen.getByText("go"));
    expect(screen.getByText("other page")).toBeTruthy();
  });

  it("asks first, and Stay keeps the page", async () => {
    const router = setup(true);
    await userEvent.click(screen.getByText("go"));
    expect(await screen.findByText("Leave this page?")).toBeTruthy();
    await userEvent.click(screen.getByText("Stay here"));
    expect(router.state.location.pathname).toBe("/");
  });

  it("Leave runs the cleanup and navigates", async () => {
    const onLeave = vi.fn();
    const router = setup(true, onLeave);
    await userEvent.click(screen.getByText("go"));
    await userEvent.click(await screen.findByText("Discard and leave"));
    expect(onLeave).toHaveBeenCalledOnce();
    expect(router.state.location.pathname).toBe("/other");
  });
});
