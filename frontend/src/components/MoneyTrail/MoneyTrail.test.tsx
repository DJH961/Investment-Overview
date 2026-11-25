import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrailOut, TrailStep } from "../../lib/journey-types";
import { MoneyTrail, TrailPanel, TrailView } from "./index";

vi.mock("../../lib/prefs", () => ({ usePrefs: () => ({ currency: "EUR" }) }));

afterEach(() => vi.unstubAllGlobals());

const STEPS: TrailStep[] = [
  { key: "sent", date: "2026-03-01", label: "Euros sent", figure: "1000.00", figure_ccy: "EUR", detail: "Revolut", link: "/conversions#conversion-1", change: null },
  { key: "converted", date: "2026-03-01", label: "Dollars received", figure: "1100.00", figure_ccy: "USD", detail: "at 1.1000", link: null, change: null },
  { key: "waited", date: null, label: "Waited", figure: "12 days", figure_ccy: null, detail: "in the USD account", link: null, change: null },
  { key: "deposited", date: "2026-03-13", label: "Deposited", figure: "1100.00", figure_ccy: "USD", detail: "to the broker", link: "/conversions#deposit-2", change: null },
  { key: "bought", date: "2026-03-14", label: "Bought", figure: "1100.00", figure_ccy: "USD", detail: "FAKEB", link: "/holding/2", change: null },
  { key: "worth_now", date: null, label: "Worth now", figure: "1050.00", figure_ccy: "EUR", detail: "at 1.1641 today", link: null, change: "50.00" },
];

function mount(node: React.ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MoneyTrail", () => {
  it("renders full steps with labels, links, and signed change", () => {
    mount(<MoneyTrail steps={STEPS} label="Where these dollars came from" />);
    expect(screen.getByRole("list", { name: "Where these dollars came from" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Euros sent" })).toHaveAttribute("href", "/conversions#conversion-1");
    expect(screen.getByRole("link", { name: "Bought" })).toHaveAttribute("href", "/holding/2");
    expect(screen.getByText("12 days")).toBeInTheDocument();
    expect(screen.getByText(/gain/)).toBeInTheDocument();
  });

  it("renders compact trail collapsing middle steps", () => {
    const { container } = mount(<MoneyTrail steps={STEPS} label="Buy trail" variant="compact" />);
    expect(screen.getByRole("img", { name: /Buy trail: Euros sent/ })).toBeInTheDocument();
    expect(container.querySelector(".money-trail-compact__more")).toHaveTextContent("+3");
  });
});

describe("TrailView and TrailPanel", () => {
  const trail: TrailOut = {
    kind: "buy",
    id: 42,
    paths: [
      { usd_share: "0.62", steps: STEPS },
      { usd_share: "0.38", steps: STEPS.slice(0, 3) },
    ],
    more_paths: 2,
    split: { market_eur: "80.00", currency_eur: "-20.00", conversion_cost_eur: "-10.00", total_eur: "50.00" },
    your_rate: "1.1000",
    ecb_rate: "1.1050",
    flagged: true,
  };

  it("shows shares for multi-path trails and extra path count", () => {
    mount(<TrailView trail={trail} label="Where these dollars came from" />);
    expect(screen.getByText("62% of the dollars")).toBeInTheDocument();
    expect(screen.getByText("38% of the dollars")).toBeInTheDocument();
    expect(screen.getByText("and 2 more parts, from older deposits")).toBeInTheDocument();
  });

  it("renders TrailPanel with rate chips, flagged chip, and euro split", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(trail), { status: 200 })));
    mount(<TrailPanel kind="buy" id={42} label="Where these dollars came from" />);
    expect(await screen.findByText("Your rate 1.1000")).toBeInTheDocument();
    expect(screen.getByText("ECB 1.1050")).toBeInTheDocument();
    expect(screen.getByText("Part at the ECB rate")).toBeInTheDocument();
    expect(screen.getByText("Your gain in euros")).toBeInTheDocument();
    expect(screen.getByText("Conversion cost")).toBeInTheDocument();
  });
});
