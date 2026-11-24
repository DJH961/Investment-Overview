import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import full from "../../../../fixtures/data/full.json";
import { HideAmountsProvider } from "../../../../lib/hideAmounts";
import { type CurrencyEffectDto } from "../../../../lib/queries/currencyEffect";
import { Impact } from "./Impact";
import { ImpactHero } from "./ImpactPanels";

vi.mock("../../../../lib/timezone", () => ({ useTimeZone: () => "UTC" }));
vi.mock("../../../../components/Chart", () => ({
  Chart: (p: { className?: string }) => <div className={p.className} data-testid="chart" />,
}));
const effect = vi.hoisted(() => ({ data: null as unknown }));
vi.mock("../../../../lib/queries/currencyEffect", async (orig) => ({
  ...(await orig<typeof import("../../../../lib/queries/currencyEffect")>()),
  useCurrencyEffect: (_r: string, c: "EUR" | "USD") => ({
    data: (effect.data as Record<string, unknown>)[c],
    isError: false,
    isFetching: false,
    isPending: false,
    isPlaceholderData: false,
    refetch: () => undefined,
  }),
}));

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

describe("Impact, USD view: the investing perspective", () => {
  const usd = all.USD;

  it("leads with what the euro did to your deposits, in dollars, the tag from that figure", () => {
    const inv = usd.investing!;
    expect(usd.headline.lead).toBe("deposits");
    expect(usd.headline.kind).toBe(inv.kind);
    mount(<ImpactHero data={usd} range="all" />);
    expect(screen.getByText(/What the euro did to your deposits/)).toBeInTheDocument();
    const value = Number(inv.effect);
    expect(screen.getByText(value < 0 ? "Headwind" : "Tailwind")).toBeInTheDocument();
    expect(screen.queryByText(/Euros against dollars/)).not.toBeInTheDocument();
    // The euro lens: a labelled line of its own with its own sign, and one lens sentence.
    const lens = usd.headline.other_lens!;
    expect(lens.label).toBe("Seen from euros");
    expect(screen.getByText("Seen from euros:")).toBeInTheDocument();
    expect(screen.getByText(usd.headline.lens_note!)).toBeInTheDocument();
  });

  it("says so in one line when there were no deposits, with the rate alone", () => {
    const inv = usd.investing!;
    const none = { ...usd, investing: { ...inv, deposit_count: 0, deposits: [], series: [] } };
    mount(<ImpactHero data={none} range="1m" />);
    expect(screen.getByText(/No deposits in this range/)).toBeInTheDocument();
  });
});

describe("Impact, both views have the same cards", () => {
  const cards = [".impact__hero", ".impact__bridge", ".impact__records", ".impact__months", ".impact__rolling", ".impact__holdings"];

  for (const rng of ["all", "1y"]) {
    it(`${rng}: every card is there in EUR and in USD, none empty`, () => {
      effect.data = fx[`GET /api/currency/effect/both?range=${rng}`];
      const seen: Record<string, boolean[]> = {};
      for (const ccy of ["EUR", "USD"] as const) {
        const { container, unmount } = mount(<Impact id="impact" label="Impact" currency={ccy} range={rng as "1y"} />);
        seen[ccy] = cards.map((c) => container.querySelector(c) !== null);
        if (ccy === "USD") {
          expect(screen.getByText("Per deposit")).toBeInTheDocument();
          expect(screen.getByText("From euros to dollars")).toBeInTheDocument();
          expect(container.querySelector('[data-part="currency"]')).not.toBeNull();
          expect(screen.queryByText(/All your holdings are in dollars/)).not.toBeInTheDocument();
        }
        unmount();
      }
      expect(seen.USD).toEqual(seen.EUR);
      expect(seen.USD.filter(Boolean).length).toBeGreaterThanOrEqual(5);
    });
  }
});
