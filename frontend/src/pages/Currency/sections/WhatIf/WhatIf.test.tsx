import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import full from "../../../../fixtures/data/full.json";
import type { ScenariosDto } from "../../../../lib/queries/currencyDollar";

const state = vi.hoisted(() => ({ data: null as unknown }));

vi.mock("../../../../lib/queries/currencyDollar", async (orig) => ({
  ...(await orig<typeof import("../../../../lib/queries/currencyDollar")>()),
  useScenarios: () => ({
    data: state.data,
    isError: false,
    isPending: false,
    isFetching: false,
    isPlaceholderData: false,
    refetch: () => undefined,
  }),
}));

import { HideAmountsProvider } from "../../../../lib/hideAmounts";
import { WhatIf } from "./WhatIf";

const fx = full as unknown as Record<string, { EUR: ScenariosDto; USD: ScenariosDto }>;
const both = fx["GET /api/currency/scenarios/both?range=1y"]!;

function titles(): string[] {
  return [...document.querySelectorAll(".card__title")].map((n) => n.textContent ?? "");
}

function mount(side: "EUR" | "USD") {
  state.data = both[side];
  return render(
    <HideAmountsProvider>
      <MemoryRouter>
        <WhatIf id="scenarios" label="Scenarios" currency={side} range="1y" />
      </MemoryRouter>
    </HideAmountsProvider>,
  );
}

beforeEach(() => {
  state.data = null;
});

describe("What if", () => {
  it("the USD view shows the same cards as the EUR view, not fewer", () => {
    const eur = mount("EUR");
    const eurTitles = titles();
    const eurTiles = document.querySelectorAll(".stat-strip__item").length;
    eur.unmount();
    mount("USD");
    expect(eurTitles.length).toBeGreaterThanOrEqual(3);
    // Same cards, in the same order; the mover is named for the quote shown (dollar / euro).
    expect(titles().map((t) => t.replace(/the (dollar|euro) moves/, "the mover moves"))).toEqual(
      eurTitles.map((t) => t.replace(/the (dollar|euro) moves/, "the mover moves")),
    );
    expect(document.querySelectorAll(".stat-strip__item").length).toBe(eurTiles);
  });

  it("the USD view prices the euros you send in, with the holdings in euros as a side line", () => {
    mount("USD");
    expect(screen.getByText(/What you already have/)).toBeInTheDocument();
    expect(screen.getAllByText(/€1,000 buys/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/stays the same/)).not.toBeInTheDocument();
  });

  it("the EUR view values the holdings", () => {
    mount("EUR");
    expect(screen.getByText("Holdings worth")).toBeInTheDocument();
    expect(screen.queryByText(/What you already have/)).not.toBeInTheDocument();
  });
});
