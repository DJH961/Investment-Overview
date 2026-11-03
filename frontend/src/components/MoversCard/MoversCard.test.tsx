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
    expect(screen.getByText("last close · Fri 26/06")).toBeInTheDocument();
    expect(screen.getByText("biggest move")).toBeInTheDocument();
    expect(screen.getByText("top %")).toBeInTheDocument();
    const leads = [...container.querySelectorAll(".movers-card__lead")].map((n) => n.textContent);
    expect(leads[0]).toBe("+€1.2k");
    expect(leads[1]).toBe("-5.00%");
    expect(screen.getByRole("button", { name: "Top movers" })).toHaveAttribute("aria-expanded", "true");
  });
});
