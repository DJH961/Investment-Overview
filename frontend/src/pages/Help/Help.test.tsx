import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
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
});
