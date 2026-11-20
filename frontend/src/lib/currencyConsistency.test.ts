/**
 * Consistency guard: the same currency figure is shown by the Overview's CurrencyBox, the
 * Currency page (strip, Today block, "buys" row) and the Brief's rate line, in EUR and USD
 * mode. Whatever sequence of ticks / fx events arrives, every consumer that shows the rate
 * must show the same one, and no tick may blank a value the server already sent.
 */
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { applyTick } from "./tickPatch";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Ccy = "EUR" | "USD";
const SIDES: Ccy[] = ["EUR", "USD"];

const FX0 = "1.2000";

function today(side: Ccy): any {
  return {
    pair: side === "USD" ? "EUR/USD" : "USD/EUR",
    spot: FX0,
    spot_display: side === "USD" ? FX0 : String(1 / Number(FX0)),
    prev: "1.2500",
    regime: { market_open: true, forex_open: true, holiday: false, forex_frozen: false, single_overnight: false },
    effect_eur: { net: "-400", market_hours: "-150", overnight: "-250" },
    investing_power_usd: { amount_eur: "500", amount_usd: "600", net: "-25", market_hours: "-10", overnight: "-15" },
  };
}

function seed(): QueryClient {
  const qc = new QueryClient();
  const overview = (side: Ccy) => ({
    ccy: side,
    fx_eur_usd: FX0,
    kpis: { total_value: side === "EUR" ? "9000" : "10800" },
    kpis_secondary: { total_value: side === "EUR" ? "10800" : "9000" },
    currency: { today: today(side) },
  });
  qc.setQueryData(["overview", "both"], { EUR: overview("EUR"), USD: overview("USD") });
  const currency = (side: Ccy) => ({
    ccy: side,
    today: today(side),
    buys: { amount_eur: "500", usd_now: "600", change_usd: "-25", market_hours_usd: "-10", overnight_usd: "-15" },
    stats: [
      { key: "rate_now", value: FX0, unit: "rate" },
      { key: "effect_today", value: "-400", unit: "money" },
    ],
  });
  qc.setQueryData(["currency", "both"], { EUR: currency("EUR"), USD: currency("USD") });
  return qc;
}

/** What each consumer reads for the rate, per mode. */
function rates(qc: QueryClient, side: Ccy) {
  const o = qc.getQueryData<any>(["overview", "both"])[side];
  const c = qc.getQueryData<any>(["currency", "both"])[side];
  return {
    overviewBox: o.currency.today.spot,
    overviewDisplay: o.currency.today.spot_display,
    overviewFx: o.fx_eur_usd,
    pageBox: c.today.spot,
    pageDisplay: c.today.spot_display,
    strip: c.stats.find((s: any) => s.key === "rate_now").value,
    buysUsd: c.buys.usd_now,
    cardUsd: o.currency.today.investing_power_usd.amount_usd,
    cardUsdPage: c.today.investing_power_usd.amount_usd,
  };
}

const tick = (fx: string, extra: Record<string, unknown> = {}) => ({
  type: "tick",
  seq: 1,
  total_value_eur: "9100",
  total_value_usd: "10920",
  fx_eur_usd: fx,
  ...extra,
});

describe("currency consumers agree after any tick sequence", () => {
  const sequence: Array<[string, Record<string, unknown>]> = [
    ["1.2100", tick("1.2100")],
    ["1.2100", { type: "fx", fx_eur_usd: "1.2100" }],
    ["1.1900", tick("1.1900", { prices: null, point: null })],
    ["1.1950", { type: "fx", fx_eur_usd: "1.1950", last_update_at: "2026-11-04T14:02:00Z" }],
    ["1.1950", tick("1.1950", { total_value_eur: null, total_value_usd: null })],
  ];

  for (const side of SIDES) {
    it(`${side} mode: box, page, strip and buys show one rate`, () => {
      const qc = seed();
      for (const [fx, ev] of sequence) {
        applyTick(qc, ev as any);
        const r = rates(qc, side);
        expect(r.overviewBox).toBe(fx);
        expect(r.overviewFx).toBe(fx);
        expect(r.pageBox).toBe(fx);
        expect(r.strip).toBe(fx);
        expect(r.overviewDisplay).toBe(r.pageDisplay);
        expect(Number(r.overviewDisplay)).toBeCloseTo(side === "USD" ? Number(fx) : 1 / Number(fx), 8);
        expect(Number(r.buysUsd)).toBeCloseTo(500 * Number(fx), 8);
        expect(Number(r.cardUsd)).toBeCloseTo(500 * Number(fx), 8);
        expect(r.cardUsdPage).toBe(r.cardUsd);
      }
    });
  }

  it("a tick without a rate, or with empty fields, never blanks what the server sent", () => {
    const qc = seed();
    const before = JSON.stringify(qc.getQueryData(["currency", "both"]));
    applyTick(qc, { type: "tick", seq: 2, fx_eur_usd: null, total_value_eur: "", prices: null } as any);
    expect(JSON.stringify(qc.getQueryData(["currency", "both"]))).toBe(before);
    for (const side of SIDES) {
      const c = qc.getQueryData<any>(["currency", "both"])[side];
      expect(c.today.effect_eur.market_hours).toBe("-150");
      expect(c.buys.market_hours_usd).toBe("-10");
    }
  });

  it("the server's legs and nets stay as sent until the refetch brings the new ones", () => {
    const qc = seed();
    applyTick(qc, tick("1.2100") as any);
    for (const side of SIDES) {
      const o = qc.getQueryData<any>(["overview", "both"])[side].currency.today;
      const c = qc.getQueryData<any>(["currency", "both"])[side];
      expect(o.effect_eur).toEqual({ net: "-400", market_hours: "-150", overnight: "-250" });
      expect(o.investing_power_usd.net).toBe("-25");
      expect(c.buys.change_usd).toBe("-25");
      expect(c.buys.market_hours_usd).toBe("-10");
    }
  });
});
