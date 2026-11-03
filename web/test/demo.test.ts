/**
 * Demo / preview mode builds a complete, internally consistent, live-looking
 * dashboard from generated sample data — no network, no key, no passphrase. This
 * guards the preview path that the setup screen, `?demo` and the demo-only site use.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildDemoRender,
  buildDemoModel,
  parseDemoParams,
  getPersona,
  DEMO_PERSONAS,
  DEFAULT_PERSONA_ID,
  DEMO_TAB_IDS,
} from "../src/demo";
import { demoTradingDay, installDemoClock, uninstallDemoClock } from "../src/demo-clock";
import { isUsMarketOpen, lastSessionDate } from "../src/market-hours";

/** 11:42 ET on a normal Tuesday (EST). */
const NOW = new Date("2026-11-03T16:42:00Z");

afterEach(() => {
  uninstallDemoClock();
  vi.unstubAllGlobals();
});

describe("generated demo data", () => {
  it("is deterministic for a given (persona, day, instant)", () => {
    const a = buildDemoRender({ persona: "tech", now: NOW });
    const b = buildDemoRender({ persona: "tech", now: NOW });
    expect(a.model.overview.totalValueEur.toString()).toBe(b.model.overview.totalValueEur.toString());
    expect(JSON.stringify(a.scene.data)).toBe(JSON.stringify(b.scene.data));
  });

  it("differs per persona and per demo day", () => {
    const a = buildDemoModel({ persona: "global", now: NOW });
    const b = buildDemoModel({ persona: "tech", now: NOW });
    const c = buildDemoModel({ persona: "global", now: new Date("2026-11-04T16:42:00Z") });
    expect(a.overview.totalValueEur.equals(b.overview.totalValueEur)).toBe(false);
    expect(a.overview.totalValueEur.equals(c.overview.totalValueEur)).toBe(false);
  });

  it("moves forward as the live clock advances", () => {
    const a = buildDemoModel({ persona: "global", now: NOW });
    const b = buildDemoModel({ persona: "global", now: new Date(NOW.getTime() + 20 * 60_000) });
    expect(a.overview.totalValueEur.equals(b.overview.totalValueEur)).toBe(false);
  });

  for (const persona of DEMO_PERSONAS) {
    describe(persona.id, () => {
      const { model, scene, hooks } = buildDemoRender({ persona: persona.id, now: NOW });
      const o = model.overview;
      const data = scene.data;

      it("total value = holdings + cash, and nothing is missing", () => {
        const holdingsSum = model.holdings.reduce((acc, h) => acc + (h.valueEur?.toNumber() ?? 0), 0);
        expect(Math.abs(holdingsSum + o.cashValueEur.toNumber() - o.totalValueEur.toNumber())).toBeLessThan(0.01);
        expect(o.totalValueIsComplete).toBe(true);
        expect(o.fxMissingCurrencies).toEqual([]);
        expect(o.pricesAreLive).toBe(true);
        expect(o.totalValueUsd).not.toBeNull();
      });

      it("reads as a live session with a today's move, last pull and FX anchors", () => {
        expect(o.lastDataPullAt).not.toBeNull();
        expect(o.fxRateEurUsdSessionOpen).not.toBeNull();
        expect(o.fxObservedAt).not.toBeNull();
        expect(o.liveCoverage).toContain("live");
        expect(o.todayMovePct).not.toBeNull();
        expect(model.holdings.filter((h) => h.priceIsLive).length).toBeGreaterThanOrEqual(3);
        expect(o.asOf).toBe(scene.history.day);
      });

      it("the 1D curve ends exactly on the headline, in both currencies", async () => {
        const session = await hooks.session();
        const pts = session!.points;
        expect(pts.length).toBeGreaterThan(100);
        const tip = pts[pts.length - 1];
        expect(tip.valueEur.equals(o.totalValueEur)).toBe(true);
        expect(tip.valueUsd.equals(o.totalValueUsd!)).toBe(true);
        // Starts near the previous close (the dashed reference) and is time-ordered.
        const open = pts[0].valueEur.toNumber();
        const prev = o.prevCloseAnchorEur.toNumber();
        expect(Math.abs(open / prev - 1)).toBeLessThan(0.03);
        for (let i = 1; i < pts.length; i += 1) expect(pts[i].t).toBeGreaterThanOrEqual(pts[i - 1].t);
      });

      it("the 1W curve spans five sessions and ends on the headline", async () => {
        const week = (await hooks.week())!;
        const days = new Set(week.map((p) => new Date(p.t).toISOString().slice(0, 10)));
        expect(days.size).toBeGreaterThanOrEqual(5);
        expect(week[week.length - 1].valueEur.equals(o.totalValueEur)).toBe(true);
      });

      it("the equity curve runs to the previous close and is benchmarked to VT", () => {
        const curve = data.analytics!.curve;
        expect(curve[curve.length - 1].date).toBe(scene.history.prevDay);
        expect(curve.every((p) => p.portfolio_value !== null && p.portfolio_value_usd != null && p.benchmark_value !== null)).toBe(true);
        expect(model.analytics!.benchmarkSymbol).toBe("VT");
      });

      it("attribution sums to total gain and ~100% of return", () => {
        const rows = data.analytics!.attribution;
        const sum = rows.reduce((acc, r) => acc + Number(r.absolute_pnl), 0);
        expect(Math.abs(sum - o.totalGainEur.toNumber())).toBeLessThan(0.02);
        const pct = rows.reduce((acc, r) => acc + Number(r.pct_of_total_return), 0);
        expect(Math.abs(pct - 1)).toBeLessThan(0.01);
      });

      it("periods and contributions add up", () => {
        const deposits = model.deposits!;
        const total = deposits.rows.reduce((acc, r) => acc + Number(r.amountEur ?? 0), 0);
        expect(Math.abs(total - Number(deposits.totalEur))).toBeLessThan(0.01);
        const year = scene.history.day.slice(0, 4);
        const ytd = deposits.rows.filter((r) => r.date.startsWith(year)).reduce((acc, r) => acc + Number(r.amountEur ?? 0), 0);
        expect(Math.abs(ytd - Number(deposits.ytdEur))).toBeLessThan(0.01);
        const yearly = data.yearly!.rows.reduce((acc, r) => acc + Number(r.contributions_eur), 0);
        expect(Math.abs(yearly - total)).toBeLessThan(0.01);
        const monthly = data.monthly!.rows.reduce((acc, r) => acc + Number(r.contributions_eur), 0);
        expect(Math.abs(monthly - total)).toBeLessThan(0.01);
        // The current month/year rows are live-overlaid and no period is absurd.
        expect(model.periods.monthly[0].isCurrent).toBe(true);
        for (const row of model.periods.monthly) {
          expect(Math.abs(row.growthPct?.toNumber() ?? 0)).toBeLessThan(0.2);
        }
      });

      it("risk scalars are finite in both currencies and benchmarked to VT", () => {
        const a = data.analytics!;
        const rec = a as unknown as Record<string, string>;
        const keys = ["cagr", "twr", "xirr", "volatility", "sharpe", "sortino", "max_drawdown", "calmar", "ulcer", "var_95", "cvar_95", "skew", "kurtosis", "beta", "alpha"];
        for (const k of keys) {
          expect(Number.isFinite(Number(rec[k])), k).toBe(true);
          expect(Number.isFinite(Number(rec[`${k}_usd`])), `${k}_usd`).toBe(true);
        }
        expect(a.benchmark_symbol).toBe("VT");
      });

      it("renders no null in the fields the UI shows", () => {
        for (const h of model.holdings) {
          expect(h.valueEur, h.symbol).not.toBeNull();
          expect(h.valueUsd, h.symbol).not.toBeNull();
          expect(h.xirr, h.symbol).not.toBeNull();
          expect(h.totalGrowthPct, h.symbol).not.toBeNull();
          // Only a par-NAV money-market fund legitimately has no daily move.
          if (!h.isMoneyMarket) expect(h.todayMovePct, h.symbol).not.toBeNull();
        }
        expect(o.portfolioXirr).not.toBeNull();
        expect(o.portfolioXirrUsd).not.toBeNull();
        expect(o.mtdGrowthPct).not.toBeNull();
        expect(o.ytdGrowthPct).not.toBeNull();
        expect(o.totalGrowthCompoundedPct).not.toBeNull();
        expect(model.transactions.available).toBe(true);
        expect(model.transactions.rows.length).toBeGreaterThan(20);
        expect(model.calculator.savedTargets.length).toBeGreaterThan(0);
      });
    });
  }

  it("the global persona has a NAV fund with yesterday's NAV and a money-market fund", () => {
    const model = buildDemoModel({ persona: "global", now: NOW });
    const fund = model.holdings.find((h) => h.symbol === "FCNTX")!;
    expect(fund.priceType).toBe("nav");
    expect(fund.todayMovePct).not.toBeNull();
    const mm = model.holdings.find((h) => h.symbol === "VMFXX")!;
    expect(mm.isMoneyMarket).toBe(true);
    expect(mm.priceIsLive).toBe(false);
  });

  it("the tech persona has a winner and a loser today", () => {
    const model = buildDemoModel({ persona: "tech", now: NOW });
    expect(model.holdings.some((h) => h.todayMovePct?.isNegative() ?? false)).toBe(true);
    expect(model.holdings.some((h) => h.todayMovePct?.isPositive() ?? false)).toBe(true);
  });
});

describe("demo clock", () => {
  it("anchors on the latest trading day and reads as an open session at 11:42 ET", () => {
    // Juneteenth 2026 (a Friday market holiday) walks back to Thursday.
    expect(demoTradingDay(Date.parse("2026-06-19T12:00:00Z"))).toBe("2026-06-18");
    // A Saturday walks back to Friday.
    expect(demoTradingDay(Date.parse("2026-11-07T15:00:00Z"))).toBe("2026-11-06");
    const day = installDemoClock();
    const now = new Date();
    expect(isUsMarketOpen(now)).toBe(true);
    expect(lastSessionDate(now)).toBe(day);
    expect(new Date(0).getTime()).toBe(0);
    expect(new Date("2026-01-02T00:00:00Z") instanceof Date).toBe(true);
  });

  it("restores the real Date", () => {
    const Real = Date;
    installDemoClock();
    expect(Date).not.toBe(Real);
    uninstallDemoClock();
    expect(Date).toBe(Real);
  });
});

describe("demo-only path", () => {
  it("makes no network request while building and driving the demo", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("network is off")));
    vi.stubGlobal("fetch", fetchSpy);
    for (const persona of DEMO_PERSONAS) {
      const { hooks } = buildDemoRender({ persona: persona.id, now: NOW });
      await hooks.session({ forceFetch: true });
      await hooks.week({ forceFetch: true });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
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
    expect(parseDemoParams("?demo&tab=activity").tab).toBe("transactions");
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
