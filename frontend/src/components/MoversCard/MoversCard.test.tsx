import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OverviewDto } from "../../lib/queries/portfolio";

vi.mock("../../lib/timezone", () => ({ useTimeZone: () => "UTC" }));

import { MoversCard } from "./MoversCard";

const movers = {
  basis_date: "2020-06-26",
  eligible_count: 5,
  winners: [{ symbol: "AAA", name: "Alpha", pct: "0.031", move: "1200", reason: "total" }],
  losers: [{ symbol: "BBB", name: "Beta", pct: "-0.05", move: "-90", reason: "pct" }],
} as OverviewDto["movers"];

afterEach(() => localStorage.clear());

describe("MoversCard", () => {
  it("tags the ranking and leads with the figure it ranked on", () => {
    const { container } = render(<MoversCard movers={movers} currency="EUR" loading={false} />);
    // Not today's moves: the last session is named (as in the v5 web app).
    expect(screen.getByText("Last session · Fri")).toBeInTheDocument();
    expect(screen.getByText("biggest move")).toBeInTheDocument();
    expect(screen.getByText("top %")).toBeInTheDocument();
    const leads = [...container.querySelectorAll(".movers-card__lead")].map((n) => n.textContent);
    expect(leads[0]).toBe("+€1.2k");
    expect(leads[1]).toBe("-5.00%");
    expect(screen.getByRole("button", { name: "Top movers" })).toHaveAttribute("aria-expanded", "true");
  });

  it("puts every mover in one aligned list per side and says Today for today's moves", () => {
    const now = new Date("2020-06-26T18:00:00Z");
    const { container } = render(<MoversCard movers={movers} currency="EUR" loading={false} now={now} />);
    expect(screen.getByText("Today")).toBeInTheDocument();
    const lists = container.querySelectorAll(".movers-card__list");
    expect(lists).toHaveLength(2);
    for (const list of lists) {
      for (const row of list.querySelectorAll(".movers-card__row")) {
        // Same four cells in every row, so the subgrid keeps the figures in columns.
        expect(row.children).toHaveLength(4);
      }
    }
  });

  it("shows an empty side as a quiet line", () => {
    render(<MoversCard movers={{ ...movers, losers: [] }} currency="EUR" loading={false} />);
    expect(screen.getByText("No losers")).toBeInTheDocument();
  });
});
