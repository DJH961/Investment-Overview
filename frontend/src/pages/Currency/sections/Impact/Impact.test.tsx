import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import full from "../../../../fixtures/data/full.json";
import { HideAmountsProvider } from "../../../../lib/hideAmounts";
import { effectRangeFor, type CurrencyEffectDto } from "../../../../lib/queries/currencyEffect";
import { BridgeCard, HoldingsCard, ImpactHero, RecordsCard } from "./ImpactPanels";

vi.mock("../../../../lib/timezone", () => ({ useTimeZone: () => "UTC" }));

// The fixture ledger is all dollars, like the owner's.
const fx = full as unknown as Record<string, { EUR: CurrencyEffectDto; USD: CurrencyEffectDto }>;
const all = fx["GET /api/currency/effect/both?range=all"];
const noChart = (d: CurrencyEffectDto): CurrencyEffectDto => ({ ...d, series: [] });

function mount(node: React.ReactNode) {
  return render(
    <HideAmountsProvider>
      <MemoryRouter>{node}</MemoryRouter>
    </HideAmountsProvider>,
  );
}

describe("Impact, EUR view", () => {
  it("leads with what the dollar did in euros; the tag and the words agree with the numbers", () => {
    const eur = all.EUR;
    expect(eur.headline.lead).toBe("effect");
    mount(<ImpactHero data={noChart(eur)} range="all" />);
    expect(screen.getByText(/What the dollar did to you, in euros/)).toBeInTheDocument();
    const effect = Number(eur.headline.effect);
    const pp = Number(eur.headline.effect_pp);
    expect(Math.sign(effect)).toBe(Math.sign(pp));
    expect(screen.getByText(effect < 0 ? "Headwind" : "Tailwind")).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`Euro return [\\d.]+ pp ${pp < 0 ? "lower" : "higher"} than the dollar return`))).toBeInTheDocument();
  });
});

describe("Impact, USD view of an all-dollar book", () => {
  const usd = all.USD;

  it("leads with the euro-vs-dollar gap, never with +US$0 or the euro", () => {
    expect(usd.headline.lead).toBe("gap");
    const { container } = mount(<ImpactHero data={usd} range="all" />);
    expect(screen.getByText("Euros against dollars")).toBeInTheDocument();
    const pp = Number(usd.headline.effect_pp);
    expect(screen.getByText(new RegExp(`Your result in euros was [\\d.]+ pp ${pp < 0 ? "lower" : "higher"} than in dollars`))).toBeInTheDocument();
    expect(screen.queryByText(/What the euro did/)).not.toBeInTheDocument();
    expect(screen.getByText(/What the dollar did to you in euros/)).toBeInTheDocument();
    expect(screen.getByText(pp < 0 ? "Headwind" : "Tailwind")).toBeInTheDocument();
    // No chart of two identical lines.
    expect(container.querySelector(".impact__chart")).toBeNull();
  });

  it("drops the zero currency step from the bridge", () => {
    const { container } = mount(<BridgeCard data={usd} />);
    expect(container.querySelector('[data-part="currency"]')).toBeNull();
    expect(container.querySelector('[data-part="market"]')).not.toBeNull();
  });

  it("says in one line that no holding had a currency effect", () => {
    const { container } = mount(<HoldingsCard data={usd} range="all" />);
    expect(screen.getByText(/All your holdings are in dollars/)).toBeInTheDocument();
    expect(container.querySelector(".holding-split__row")).toBeNull();
  });

  it("shows no records of zeros", () => {
    const { container } = mount(<RecordsCard data={usd} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("effectRangeFor", () => {
  it("keeps 5Y and 10Y, maps Max and All to all", () => {
    expect(effectRangeFor("5y")).toBe("5y");
    expect(effectRangeFor("10y")).toBe("10y");
    expect(effectRangeFor("max")).toBe("all");
    expect(effectRangeFor("all")).toBe("all");
    expect(effectRangeFor("1y")).toBe("1y");
  });
});
