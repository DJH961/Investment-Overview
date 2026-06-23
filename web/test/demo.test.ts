/**
 * Demo / preview mode builds a complete, sensible dashboard from the baked-in
 * sample data — no network, no key, no passphrase. This guards the preview path
 * that the setup screen and the `?demo` URL expose.
 */
import { describe, expect, it } from "vitest";

import {
  buildDemoModel,
  parseDemoParams,
  tickQuotes,
  getPersona,
  DEMO_PERSONAS,
  DEFAULT_PERSONA_ID,
  DEMO_TAB_IDS,
} from "../src/demo";

describe("buildDemoModel", () => {
  const model = buildDemoModel();

  it("produces a positive total value across several holdings", () => {
    expect(model.holdings.length).toBeGreaterThanOrEqual(5);
    expect(model.overview.totalValueEur.greaterThan(0)).toBe(true);
    expect(model.overview.holdingsCount).toBe(model.holdings.length);
  });

  it("computes a portfolio XIRR from the sample cashflows", () => {
    expect(model.overview.portfolioXirr).not.toBeNull();
  });

  it("flags the money-market NAV holding as a non-live (fallback) price", () => {
    const navRow = model.holdings.find((holding) => holding.symbol === "VMFXX");
    expect(navRow).toBeDefined();
    expect(navRow?.priceType).toBe("nav");
    expect(navRow?.priceIsLive).toBe(false);
  });

  it("shows a today's move for the live mutual fund (NAV) holding", () => {
    const fund = model.holdings.find((holding) => holding.symbol === "FCNTX");
    expect(fund).toBeDefined();
    expect(fund?.priceType).toBe("nav");
    // A mutual fund priced from a daily bar carries a move from its prior close,
    // just like a stock — not a blank dash.
    expect(fund?.todayMoveEur).not.toBeNull();
    expect(fund?.todayMovePct?.greaterThan(0)).toBe(true);
  });

  it("has no missing FX legs (USD rate is provided)", () => {
    expect(model.overview.fxMissingCurrencies).toEqual([]);
  });

  it("includes a cash balance in the total", () => {
    expect(model.overview.cashValueEur.greaterThan(0)).toBe(true);
  });

  it("builds the Phase 4 periods, analytics, deposits and plan blocks", () => {
    expect(model.periods.monthly.length).toBeGreaterThan(0);
    expect(model.periods.yearly.length).toBeGreaterThan(0);
    // The newest month/year is overlaid with the live recompute.
    expect(model.periods.monthly[0].isCurrent).toBe(true);
    expect(model.analytics).not.toBeNull();
    expect(model.deposits).not.toBeNull();
    expect(model.plan.startingValueEur.greaterThan(0)).toBe(true);
    expect(model.plan.defaultAnnualContributionEur.greaterThan(0)).toBe(true);
  });
});

describe("demo personas", () => {
  it("exposes a non-empty registry with unique ids and the default first", () => {
    expect(DEMO_PERSONAS.length).toBeGreaterThanOrEqual(3);
    const ids = DEMO_PERSONAS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(DEFAULT_PERSONA_ID).toBe(DEMO_PERSONAS[0].id);
  });

  it("getPersona falls back to the default for unknown/empty ids", () => {
    expect(getPersona("does-not-exist").id).toBe(DEFAULT_PERSONA_ID);
    expect(getPersona(null).id).toBe(DEFAULT_PERSONA_ID);
    expect(getPersona("tech").id).toBe("tech");
  });

  it("each persona builds a complete, sensible dashboard across all tabs", () => {
    for (const persona of DEMO_PERSONAS) {
      const model = buildDemoModel({ persona: persona.id });
      expect(model.holdings.length, persona.id).toBeGreaterThanOrEqual(4);
      expect(model.overview.totalValueEur.greaterThan(0), persona.id).toBe(true);
      expect(model.overview.holdingsCount, persona.id).toBe(model.holdings.length);
      expect(model.overview.portfolioXirr, persona.id).not.toBeNull();
      // Currency is fully wired (no missing FX legs), so the EUR/USD toggle works.
      expect(model.overview.fxMissingCurrencies, persona.id).toEqual([]);
      // Every Phase 4 block has content so no tab renders empty.
      expect(model.periods.monthly.length, persona.id).toBeGreaterThan(0);
      expect(model.periods.yearly.length, persona.id).toBeGreaterThan(0);
      expect(model.analytics, persona.id).not.toBeNull();
      expect((model.analytics?.curve.length ?? 0), persona.id).toBeGreaterThanOrEqual(2);
      expect(model.deposits, persona.id).not.toBeNull();
      expect(model.plan.startingValueEur.greaterThan(0), persona.id).toBe(true);
    }
  });

  it("the tech persona carries a deliberate loser (a negative attribution row)", () => {
    const model = buildDemoModel({ persona: "tech" });
    const losers = model.analytics?.attribution.filter(
      (row) => row.absolutePnlEur !== null && row.absolutePnlEur.isNegative(),
    );
    expect(losers?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("live-tick simulator", () => {
  it("tick 0 returns the baked prices unchanged (frozen snapshot)", () => {
    const persona = getPersona("global");
    const frozen = tickQuotes(persona.quotes, 0);
    for (const [symbol, q] of persona.quotes) {
      expect(frozen.get(symbol)?.price?.toString(), symbol).toBe(q.price?.toString());
    }
  });

  it("is deterministic for a given (persona, tick)", () => {
    const a = buildDemoModel({ persona: "tech", tick: 5 });
    const b = buildDemoModel({ persona: "tech", tick: 5 });
    expect(a.overview.totalValueEur.toString()).toBe(b.overview.totalValueEur.toString());
  });

  it("moves the headline value once it starts ticking", () => {
    const frozen = buildDemoModel({ persona: "global", tick: 0 });
    // Some tick within the first few must differ from the frozen snapshot.
    const moved = [1, 2, 3, 4].some(
      (t) => !buildDemoModel({ persona: "global", tick: t }).overview.totalValueEur.equals(frozen.overview.totalValueEur),
    );
    expect(moved).toBe(true);
  });

  it("never moves a market holding's today's move beyond a sane band", () => {
    const persona = getPersona("tech");
    for (let tick = 0; tick < 40; tick += 1) {
      const model = buildDemoModel({ persona: persona.id, tick });
      for (const holding of model.holdings) {
        if (holding.todayMovePct === null) continue;
        // Bounded, "never alarming" — base moves are ~1% and the sim adds <1%.
        expect(Math.abs(holding.todayMovePct.toNumber()), `${holding.symbol}@${tick}`).toBeLessThan(0.05);
      }
    }
  });

  it("leaves once-a-day NAV quotes (money-market / funds) unmoved", () => {
    const persona = getPersona("global");
    const ticked = tickQuotes(persona.quotes, 7);
    // FCNTX is a NAV (mutual fund) bar in the global persona — it must not tick.
    expect(ticked.get("FCNTX")?.price?.toString()).toBe(persona.quotes.get("FCNTX")?.price?.toString());
  });
});

describe("parseDemoParams", () => {
  it("detects neither demo nor preview", () => {
    expect(parseDemoParams("?foo=1").requested).toBe(false);
  });

  it("recognises ?demo and ?preview and resolves the default persona", () => {
    expect(parseDemoParams("?demo").requested).toBe(true);
    expect(parseDemoParams("?demo").persona).toBe(DEFAULT_PERSONA_ID);
    expect(parseDemoParams("?preview").requested).toBe(true);
  });

  it("reads a persona id directly from the flag value", () => {
    expect(parseDemoParams("?demo=tech").persona).toBe("tech");
    expect(parseDemoParams("?demo=fx").persona).toBe("fx");
    // Unknown persona falls back to the default rather than breaking.
    expect(parseDemoParams("?demo=bogus").persona).toBe(DEFAULT_PERSONA_ID);
  });

  it("maps the tab (and friendly aliases) to a valid tab id or null", () => {
    expect(parseDemoParams("?demo&tab=risk").tab).toBe("analytics");
    expect(parseDemoParams("?demo&tab=calculator").tab).toBe("plan");
    expect(parseDemoParams("?demo&tab=periods").tab).toBe("periods");
    expect(parseDemoParams("?demo&tab=nonsense").tab).toBeNull();
    expect(parseDemoParams("?demo").tab).toBeNull();
    // Every resolved tab is one the dashboard actually has.
    for (const id of DEMO_TAB_IDS) {
      expect(parseDemoParams(`?demo&tab=${id}`).tab).toBe(id);
    }
  });

  it("parses the tour and sim boolean-ish flags", () => {
    expect(parseDemoParams("?demo&tour=1&sim=1")).toMatchObject({ tour: true, sim: true });
    expect(parseDemoParams("?demo&tour")).toMatchObject({ tour: true });
    expect(parseDemoParams("?demo&sim=false").sim).toBe(false);
    expect(parseDemoParams("?demo").tour).toBe(false);
  });
});
