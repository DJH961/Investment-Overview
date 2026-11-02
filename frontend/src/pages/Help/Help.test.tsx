import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { NAV_ITEMS } from "../../lib/nav";
import { Help } from "./Help";

describe("Help", () => {
  it("replays the tour by flagging and going to the overview", async () => {
    render(
      <MemoryRouter initialEntries={["/help"]}>
        <Routes>
          <Route path="/help" element={<Help />} />
          <Route path="/overview" element={<div>overview page</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("Your portfolio at a glance")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /replay tour/i }));
    expect(await screen.findByText("overview page")).toBeInTheDocument();
    expect(localStorage.getItem("iv.tour.replay")).toBe("1");
  });

  it("has a guide entry for every nav item and a glossary", () => {
    render(
      <MemoryRouter>
        <Help />
      </MemoryRouter>,
    );
    expect(screen.getAllByTestId("guide-entry")).toHaveLength(NAV_ITEMS.length);
    for (const i of NAV_ITEMS) expect(screen.getAllByText(i.label).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /glossary/i }));
    expect(screen.getByText("Sharpe ratio")).toBeInTheDocument();
  });
});
