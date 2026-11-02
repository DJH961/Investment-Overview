import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { TabBar } from "./TabBar";

function renderTabs(path = "/overview") {
  render(
    <MemoryRouter initialEntries={[path]}>
      <TabBar />
    </MemoryRouter>,
  );
}

describe("TabBar", () => {
  it("has Overview, Holdings, Periods, Transactions and More", () => {
    renderTabs();
    const nav = screen.getByRole("navigation", { name: "Main tabs" });
    const names = within(nav)
      .getAllByRole("link")
      .map((l) => l.textContent);
    expect(names).toEqual(["Overview", "Holdings", "Periods", "Transactions"]);
    expect(within(nav).getByRole("button", { name: "More" })).toBeInTheDocument();
  });

  it("groups the More sheet and has no duplicate actions", async () => {
    const user = userEvent.setup();
    renderTabs();
    await user.click(screen.getByRole("button", { name: "More" }));
    const sheet = screen.getByRole("dialog", { name: "More" });
    expect(within(sheet).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Portfolio", "Manage", "System"]);
    const portfolio = within(sheet).getByRole("region", { name: "Portfolio" });
    expect(within(portfolio).getAllByRole("link")[0]).toHaveTextContent("Activity");
    expect(within(sheet).getByRole("link", { name: "Data health" })).toBeInTheDocument();
    expect(within(sheet).queryByRole("link", { name: "Transactions" })).not.toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: /Refresh|Sign out/ })).not.toBeInTheDocument();
  });

  it("marks More active on a page that lives in it", () => {
    renderTabs("/risk");
    expect(screen.getByRole("button", { name: "More" })).toHaveClass("tab-bar__tab--active");
  });
});
