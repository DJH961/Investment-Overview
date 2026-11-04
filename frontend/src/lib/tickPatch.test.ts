import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { applyTick } from "./tickPatch";

/* eslint-disable @typescript-eslint/no-explicit-any */
const fx = "1.25"; // USD per EUR

function seed(): QueryClient {
  const qc = new QueryClient();
  const overview = (primary: "EUR" | "USD") => ({
    fx_eur_usd: fx,
    kpis: { total_value: primary === "EUR" ? "9000" : "11250", day_change: "5" },
    kpis_secondary: { total_value: primary === "EUR" ? "11250" : "9000" },
    freshness: { last_price_update_at: "2026-11-03T15:00:00Z", prices_live: false },
  });
  qc.setQueryData(["overview", "both"], { EUR: overview("EUR"), USD: overview("USD") });
  const row = (id: number, cur: string) => ({
    instrument_id: id,
    shares: "10",
    native_currency: cur,
    price_native: "100",
    value: "0",
  });
  const holdings = { fx_eur_usd: fx, holdings: [row(1, "USD"), row(2, "EUR")] };
  qc.setQueryData(["holdings", "both"], { EUR: holdings, USD: holdings });
  const graph = (ccy: "EUR" | "USD", pts: Array<[string, string]>) => ({
    ccy,
    points: pts.map(([t, v]) => ({ t, v })),
    secondary: { ccy: ccy === "EUR" ? "USD" : "EUR", points: pts.map(([t]) => ({ t, v: "1" })) },
  });
  const intraday: Array<[string, string]> = [["2026-11-04T14:00:00Z", "100"], ["2026-11-04T14:01:00Z", "101"]];
  qc.setQueryData(["graphs", "1d", "both"], { EUR: graph("EUR", intraday), USD: graph("USD", intraday) });
  const daily: Array<[string, string]> = [["2026-11-02", "90"], ["2026-11-03", "95"]];
  qc.setQueryData(["graphs", "1m", "both"], { EUR: graph("EUR", daily), USD: graph("USD", daily) });
  const sameDay: Array<[string, string]> = [["2026-11-03", "95"], ["2026-11-04", "96"]];
  qc.setQueryData(["graphs", "all", "both"], { EUR: graph("EUR", sameDay), USD: graph("USD", sameDay) });
  return qc;
}

const tick = {
  seq: 7,
  total_value_eur: "9600",
  total_value_usd: "12000",
  fx_eur_usd: fx,
  last_update_at: "2026-11-04T14:02:00Z",
  prices_live: true,
  point: { t: "2026-11-04T14:02:00Z", EUR: "9600", USD: "12000" },
  prices: { "1": { px: "120", prev_close: "110" } },
};

describe("applyTick golden", () => {
  it("patches totals on both sides, keeping each side's primary/secondary", () => {
    const qc = seed();
    applyTick(qc, tick);
    const o = qc.getQueryData<any>(["overview", "both"]);
    expect(o.EUR.kpis.total_value).toBe("9600");
    expect(o.EUR.kpis_secondary.total_value).toBe("12000");
    expect(o.USD.kpis.total_value).toBe("12000");
    expect(o.USD.kpis_secondary.total_value).toBe("9600");
    expect(o.EUR.kpis.day_change).toBe("5"); // derived numbers untouched
    expect(o.EUR.freshness).toEqual({ last_price_update_at: "2026-11-04T14:02:00Z", prices_live: true });
  });

  it("holding value = shares x price x rate; other rows untouched", () => {
    const qc = seed();
    applyTick(qc, tick);
    const h = qc.getQueryData<any>(["holdings", "both"]);
    const usd = h.USD.holdings[0];
    expect(usd.price_native).toBe("120");
    expect(Number(usd.value)).toBeCloseTo(1200, 9);
    expect(Number(usd.today_move)).toBeCloseTo(100, 9);
    expect(Number(usd.today_pct)).toBeCloseTo(120 / 110 - 1, 12);
    const eur = h.EUR.holdings[0];
    expect(Number(eur.value)).toBeCloseTo(960, 9); // 1200 / 1.25
    expect(Number(eur.today_move)).toBeCloseTo(80, 9);
    expect(h.EUR.holdings[1].value).toBe("0"); // instrument 2 not in the tick
    expect(h.USD.holdings[1].price_native).toBe("100");
  });

  it("intraday: appends a newer point, replaces the same t", () => {
    const qc = seed();
    applyTick(qc, tick);
    let g = qc.getQueryData<any>(["graphs", "1d", "both"]);
    expect(g.EUR.points.map((p: any) => [p.t, p.v])).toEqual([
      ["2026-11-04T14:00:00Z", "100"],
      ["2026-11-04T14:01:00Z", "101"],
      ["2026-11-04T14:02:00Z", "9600"],
    ]);
    expect(g.EUR.secondary.points.at(-1).v).toBe("12000"); // other currency's value
    expect(g.USD.points.at(-1).v).toBe("12000");
    applyTick(qc, { ...tick, point: { t: "2026-11-04T14:02:00Z", EUR: "9700", USD: "12125" } });
    g = qc.getQueryData<any>(["graphs", "1d", "both"]);
    expect(g.EUR.points).toHaveLength(3);
    expect(g.EUR.points.at(-1).v).toBe("9700");
  });

  it("daily ranges: appends today when newer, replaces when same day, ignores older", () => {
    const qc = seed();
    applyTick(qc, tick);
    const m = qc.getQueryData<any>(["graphs", "1m", "both"]);
    expect(m.EUR.points.map((p: any) => [p.t, p.v])).toEqual([
      ["2026-11-02", "90"],
      ["2026-11-03", "95"],
      ["2026-11-04", "9600"],
    ]);
    const a = qc.getQueryData<any>(["graphs", "all", "both"]);
    expect(a.USD.points.map((p: any) => [p.t, p.v])).toEqual([
      ["2026-11-03", "95"],
      ["2026-11-04", "12000"],
    ]);
    applyTick(qc, { ...tick, point: { t: "2026-11-03T20:00:00Z", EUR: "1", USD: "1" } });
    expect(qc.getQueryData<any>(["graphs", "all", "both"]).USD.points).toHaveLength(2);
    expect(qc.getQueryData<any>(["graphs", "all", "both"]).USD.points.at(-1).v).toBe("12000");
  });

  it("unknown instrument, missing fields and junk never corrupt the cache", () => {
    const qc = seed();
    const before = JSON.stringify([
      qc.getQueryData(["overview", "both"]),
      qc.getQueryData(["holdings", "both"]),
      qc.getQueryData(["graphs", "1d", "both"]),
    ]);
    applyTick(qc, {
      prices: { "999": { px: "5", prev_close: null }, "1": { px: "not-a-number" } },
      point: { EUR: "1" },
      total_value_eur: "",
      total_value_usd: 5,
    });
    applyTick(qc, { prices: null, point: null });
    const after = JSON.stringify([
      qc.getQueryData(["overview", "both"]),
      qc.getQueryData(["holdings", "both"]),
      qc.getQueryData(["graphs", "1d", "both"]),
    ]);
    expect(after).toBe(before);
  });

  it("does nothing when nothing is cached", () => {
    const qc = new QueryClient();
    applyTick(qc, tick);
    expect(qc.getQueryCache().getAll()).toHaveLength(0);
  });
});
