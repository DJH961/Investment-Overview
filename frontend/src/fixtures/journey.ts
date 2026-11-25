/**
 * Fixture answers for the 7.4 currency journey (docs/v7_4_contract_api.md §8) until the
 * recorder writes them. Anchored on the recording day like the recorded answers
 * (`installFixtures` shifts every ISO date to this week).
 *
 * Both books get one cash-out: sell → withdrawal from the money-market fund → conversion
 * back to euros. The nice book (about €50k) adds the three rows it needs; the stress book
 * already has a sale and a withdrawal and gets three conversions back (one not covered by
 * dollars, flagged), idle dollars, uncovered buys and trails with several paths.
 *
 * The figures are hand-made: each answer adds up on its own (bridge lines = total = the
 * Overview card's FX gain; a cash-out's realised = market + currency + conversion cost),
 * and the answers agree with each other, but they are not derived from the ledger.
 */

import type {
  CashOutOut,
  CashOutPreviewIn,
  JourneyBoth,
  JourneyView,
  StepKey,
  TrailOut,
  TrailPath,
  TrailStep,
} from "../lib/journey-types";

type Obj = Record<string, unknown>;
type Row = Obj & { id: number; date: string; kind: string; symbol?: string | null; net_native: string; currency: string; instrument_id?: number | null };

const ANCHOR = "2026-06-30";
const DAY = 86_400_000;
const dayNum = (iso: string) => Math.round(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY);
const f2 = (v: number) => v.toFixed(2);
const f4 = (v: number) => v.toFixed(4);

/** Which recorded book this is (the stress book has a withdrawal, the nice one has none). */
function bookOf(data: Obj): "nice" | "stress" {
  return bookOrEmpty(data) === "stress" ? "stress" : "nice";
}

function bookOrEmpty(data: Obj): "nice" | "stress" | "empty" {
  const rows = ((data["GET /api/transactions/all"] as { rows?: Row[] } | undefined)?.rows ?? []) as Row[];
  if (rows.length === 0) return "empty";
  return rows.some((r) => r.kind === "withdrawal" && r.id === 14) ? "stress" : "nice";
}

// ---- the cash-out rows each book adds ---------------------------------------------------

interface CashOutPlan {
  sell: { id: number; date: string; symbol: string; instrument_id: number; qty: number; price: number } | null;
  withdrawal: { id: number; date: string; usd: number } | null;
  backs: { id: number; date: string; usd: number; eur: number; ecb: number; fees: number; provider: string; withdrawal_id: number | null }[];
}

const PLAN: Record<"nice" | "stress", CashOutPlan> = {
  nice: {
    sell: { id: 841, date: "2026-03-10", symbol: "FAKEB", instrument_id: 2, qty: 45, price: 53.3334 },
    withdrawal: { id: 842, date: "2026-03-12", usd: 2400 },
    backs: [{ id: 31, date: "2026-03-16", usd: 2400, eur: 2201.3, ecb: 1.0862, fees: 0, provider: "revolut", withdrawal_id: 842 }],
  },
  stress: {
    sell: null,
    withdrawal: null,
    backs: [
      { id: 52, date: "2025-12-04", usd: 12500, eur: 10742.1, ecb: 1.1589, fees: 4.5, provider: "wise", withdrawal_id: 14 },
      { id: 53, date: "2026-02-18", usd: 640.25, eur: 541.12, ecb: 1.1797, fees: 0, provider: "revolut", withdrawal_id: null },
      { id: 54, date: "2026-05-27", usd: 3000, eur: 2571.4, ecb: 1.1622, fees: 0, provider: "other", withdrawal_id: null },
    ],
  },
};

// ---- the journey answer ------------------------------------------------------------------

function cashOutsFor(book: "nice" | "stress"): CashOutOut[] {
  if (book === "nice") {
    return [
      {
        conversion_id: 31,
        date: "2026-03-16",
        usd_sent: "2400.00",
        eur_received: "2201.30",
        fees_eur: "0.00",
        // 2,400 / 1.0862 = 2,209.54 at the ECB; book 1,850.00 + market 336.41 = 2,186.41.
        eur: { put_in: "1850.00", market: "336.41", currency: "23.13", conversion_cost: "-8.24", realised: "351.30", realised_pct: "0.1899", xirr: "0.1221" },
        usd: { put_in: "2035.00", market: "365.00", realised: "365.00", realised_pct: "0.1794", xirr: "0.1158" },
        note: "In euros you kept 0.6 points a year more than in dollars: the dollar rose while you held.",
        flagged: false,
      },
    ];
  }
  return [
    {
      conversion_id: 54,
      date: "2026-05-27",
      usd_sent: "3000.00",
      eur_received: "2571.40",
      fees_eur: "0.00",
      eur: { put_in: "2790.00", market: "-104.11", currency: "-99.06", conversion_cost: "-15.43", realised: "-218.60", realised_pct: "-0.0784", xirr: "-0.0921" },
      usd: { put_in: "3121.00", market: "-121.00", realised: "-121.00", realised_pct: "-0.0388", xirr: "-0.0455" },
      note: "In euros you kept 4.7 points a year less than in dollars: the dollar fell while you held.",
      flagged: false,
    },
    {
      conversion_id: 53,
      date: "2026-02-18",
      usd_sent: "640.25",
      eur_received: "541.12",
      fees_eur: "0.00",
      eur: { put_in: "512.40", market: "41.27", currency: "-9.12", conversion_cost: "-3.43", realised: "28.72", realised_pct: "0.0561", xirr: null },
      usd: { put_in: "591.51", market: "48.74", realised: "48.74", realised_pct: "0.0824", xirr: null },
      note: "Part of these dollars had no recorded withdrawal behind them; they are valued at the ECB rate.",
      flagged: true,
    },
    {
      conversion_id: 52,
      date: "2025-12-04",
      usd_sent: "12500.00",
      eur_received: "10742.10",
      fees_eur: "4.50",
      eur: { put_in: "9310.00", market: "1638.95", currency: "-181.71", conversion_cost: "-24.54", realised: "1432.10", realised_pct: "0.1538", xirr: "0.0812" },
      usd: { put_in: "10512.54", market: "1987.46", realised: "1987.46", realised_pct: "0.1891", xirr: "0.0998" },
      note: "In euros you kept 1.9 points a year less than in dollars: the dollar fell while you held.",
      flagged: false,
    },
  ];
}

const ZERO = { usd: "0.00", eur_cost: "0.00", eur_now: "0.00", currency_eur: "0.00" };
const EMPTY: JourneyView = {
  stats: { usd_account: ZERO, broker_cash: ZERO, invested: { ...ZERO, market_eur: "0.00" }, your_rate: { rate: null, ecb_avg: null, now: "1.1641" } },
  bridge: null,
  idle: [],
  back_in_euros: null,
  cash_outs: [],
  flagged: { uncovered_buys: 0, ecb_fallback_deposits: 0 },
};

function journeyFor(book: "nice" | "stress" | "empty"): { EUR: JourneyView; USD: JourneyView } {
  if (book === "empty") return { EUR: EMPTY, USD: EMPTY };
  const outs = cashOutsFor(book);
  const sum = (_k: "eur_received" | "realised", side: "top" | "eur" = "top") =>
    f2(outs.reduce((t, c) => t + Number(side === "eur" ? c.eur.realised : c.eur_received), 0));
  if (book === "nice") {
    const eur: JourneyView = {
      stats: {
        usd_account: { usd: "412.30", eur_cost: "356.95", eur_now: "354.18", currency_eur: "-2.77" },
        broker_cash: { usd: "1889.34", eur_cost: "1642.90", eur_now: "1623.02", currency_eur: "-19.88" },
        invested: { usd: "56857.83", eur_cost: "37100.00", eur_now: "48843.40", market_eur: "13873.41", currency_eur: "-2130.01" },
        your_rate: { rate: "1.1131", ecb_avg: "1.1167", now: "1.1641" },
      },
      bridge: {
        lines: [
          { key: "conversion_cost", eur: "-144.76" },
          { key: "waiting", eur: "-38.40" },
          { key: "cash", eur: "-19.88" },
          { key: "holdings", eur: "-2130.01" },
          { key: "realised", eur: "23.13" },
        ],
        total_eur: "-2309.92",
      },
      idle: [{ conversion_id: 29, date: "2026-05-04", usd: "412.30", days: 57 }],
      back_in_euros: { count: 1, eur_received: sum("eur_received"), orig_eur: "1850.00", realised_eur: sum("realised", "eur") },
      cash_outs: outs,
      flagged: { uncovered_buys: 0, ecb_fallback_deposits: 0 },
    };
    return { EUR: eur, USD: usdView(eur, { usd_account: "419.40", broker_cash: "1842.10", invested: "44410.00", market: "12447.83" }) };
  }
  const eur: JourneyView = {
    stats: {
      usd_account: { usd: "18240.77", eur_cost: "16310.52", eur_now: "15669.42", currency_eur: "-641.10" },
      broker_cash: { usd: "4100.00", eur_cost: "3812.44", eur_now: "3522.03", currency_eur: "-290.41" },
      invested: { usd: "1454743.32", eur_cost: "1104328.19", eur_now: "1249672.11", market_eur: "243212.37", currency_eur: "-97868.45" },
      your_rate: { rate: "1.0791", ecb_avg: "1.0834", now: "1.1641" },
    },
    bridge: {
      lines: [
        { key: "conversion_cost", eur: "-1543.13" },
        { key: "waiting", eur: "1325.39" },
        { key: "cash", eur: "-290.41" },
        { key: "holdings", eur: "-97868.45" },
        { key: "realised", eur: "-289.89" },
      ],
      total_eur: "-98666.49",
    },
    idle: [
      { conversion_id: 12, date: "2024-02-14", usd: "15000.00", days: 867 },
      { conversion_id: 41, date: "2026-01-09", usd: "2240.77", days: 172 },
      { conversion_id: 50, date: "2026-05-21", usd: "1000.00", days: 40 },
    ],
    back_in_euros: { count: 3, eur_received: sum("eur_received"), orig_eur: "12612.40", realised_eur: sum("realised", "eur") },
    cash_outs: outs,
    flagged: { uncovered_buys: 2, ecb_fallback_deposits: 5 },
  };
  return { EUR: eur, USD: usdView(eur, { usd_account: "17602.15", broker_cash: "4100.00", invested: "1211608.90", market: "243134.42" }) };
}

/** The USD side: dollars from native USD only, euro-only lines hidden (null). */
function usdView(eur: JourneyView, cost: { usd_account: string; broker_cash: string; invested: string; market: string }): JourneyView {
  const hideEur = { eur_cost: null, eur_now: null, currency_eur: null };
  return {
    ...eur,
    stats: {
      usd_account: { usd: eur.stats.usd_account.usd, ...hideEur, usd_cost: cost.usd_account },
      broker_cash: { usd: eur.stats.broker_cash.usd, ...hideEur, usd_cost: cost.broker_cash },
      invested: { usd: eur.stats.invested.usd, ...hideEur, market_eur: null, usd_cost: cost.invested, market_usd: cost.market },
      your_rate: eur.stats.your_rate,
    },
    bridge: null,
  };
}

// ---- trails ------------------------------------------------------------------------------

interface Slice {
  conversion_id: number;
  conversion_date: string;
  eur: string;
  usd: string;
  rate: string;
}
interface Deposit {
  transaction_id: number;
  date: string;
  usd: string;
  slices: Slice[];
}
interface Conversion {
  id: number;
  date: string;
  provider?: string | null;
  ecb_rate?: string | null;
  eur_sent: string;
  usd_received: string;
}

const PROVIDER: Record<string, string> = { wise: "Wise", revolut: "Revolut", other: "Other" };

function step(key: StepKey, date: string | null, label: string, figure: number | string, ccy: string | null, detail: string | null, link: string | null = null, change: number | null = null): TrailStep {
  return {
    key,
    date,
    label,
    figure: typeof figure === "number" ? f2(figure) : figure,
    figure_ccy: ccy,
    detail: detail && detail.length > 24 ? detail.slice(0, 24) : detail,
    link,
    change: change === null ? null : f2(change),
  };
}

function priceNow(data: Obj, symbol: string | null | undefined): number | null {
  const both = data["GET /api/holdings/both?group_by=none"] as { USD?: { holdings?: { symbol: string; price_native: string | null }[] } } | undefined;
  const h = both?.USD?.holdings?.find((x) => x.symbol === symbol);
  return h?.price_native ? Number(h.price_native) : null;
}

function rateNow(data: Obj): number {
  const life = ((data["GET /api/currency/both"] as Obj | undefined)?.EUR as Obj | undefined)?.lifetime as Obj | undefined;
  return Number(life?.current_rate ?? 1.1641);
}

/** The steps from euros to a deposit (sent → converted → waited when it waited a week or more → deposited). */
function upstream(dep: Deposit, slice: Slice, conv: Conversion | undefined, usdShare: number): TrailStep[] {
  const share = usdShare / Number(slice.usd);
  const eur = Number(slice.eur) * share;
  const waited = dayNum(dep.date) - dayNum(slice.conversion_date);
  const steps = [
    step("sent", slice.conversion_date, "Euros sent", eur, "EUR", PROVIDER[conv?.provider ?? ""] ?? "Your bank", `/conversions#conversion-${slice.conversion_id}`),
    step("converted", slice.conversion_date, "Dollars received", usdShare, "USD", `at ${Number(slice.rate).toFixed(4)}`),
  ];
  if (waited >= 7) steps.push(step("waited", null, "Waited", `${waited} days`, null, "in the USD account"));
  steps.push(step("deposited", dep.date, "Deposited", usdShare, "USD", "to the broker", `/conversions#deposit-${dep.transaction_id}`));
  return steps;
}

function trailFor(kind: string, id: number, data: Obj): TrailOut | { __status: number } {
  const book = bookOf(data);
  const rows = transactions(data);
  const deposits = (((data["GET /api/fx-conversions/pool"] as { deposits?: Deposit[] } | undefined)?.deposits ?? []) as Deposit[])
    .filter((d) => d.slices.length > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const convs = new Map(conversions(data).map((c) => [Number(c.id), c as unknown as Conversion]));
  const now = rateNow(data);
  const row = rows.find((r) => r.id === id);
  const plan = PLAN[book];
  const outs = cashOutsFor(book);

  if (kind === "buy" || kind === "deposit" || kind === "conversion") {
    // A buy draws on the deposits just before it; a deposit (or the conversion behind it) follows on to the next buy.
    let dep: Deposit | undefined;
    let buy: Row | undefined;
    if (kind === "buy") {
      if (!row) return { __status: 404 };
      buy = row;
      dep = [...deposits].reverse().find((d) => d.date <= row.date) ?? deposits[0];
    } else if (kind === "deposit") {
      dep = deposits.find((d) => d.transaction_id === id);
    } else {
      dep = deposits.find((d) => d.slices.some((s) => s.conversion_id === id));
    }
    if (!dep) return { __status: 404 };
    buy ??= rows.filter((r) => r.kind === "buy" && r.symbol && !isSweep(r, data) && r.date >= dep!.date).sort((a, b) => a.date.localeCompare(b.date))[0];
    const usdBuy = buy ? Math.abs(Number(buy.net_native)) : Number(dep.usd);
    // The stress book's larger buys draw on two deposits (and say how many more).
    const two = book === "stress" && kind === "buy";
    const earlier = two ? deposits[Math.max(0, deposits.indexOf(dep) - 1)] : undefined;
    const parts: { d: Deposit; usd: number }[] = two && earlier && earlier !== dep ? [{ d: dep, usd: usdBuy * 0.62 }, { d: earlier, usd: usdBuy * 0.38 }] : [{ d: dep, usd: usdBuy }];
    const price = buy ? priceNow(data, buy.symbol) : null;
    const buyPrice = buy?.price_native ? Number(buy.price_native) : null;
    const valueUsd = price && buyPrice ? usdBuy * (price / buyPrice) : usdBuy * 1.08;
    let eurCost = 0;
    let ecbCost = 0;
    const paths: TrailPath[] = parts.map(({ d, usd }) => {
      const slice = d.slices[0]!;
      const conv = convs.get(slice.conversion_id);
      const ecb = Number(conv?.ecb_rate ?? slice.rate);
      eurCost += (Number(slice.eur) * usd) / Number(slice.usd);
      ecbCost += usd / ecb;
      const steps = upstream(d, slice, conv, usd);
      if (buy) {
        const qty = Math.abs(Number(buy.quantity ?? 0)) * (usd / usdBuy);
        steps.push(step("bought", buy.date, "Bought", usd, "USD", `${buy.symbol} · ${qty.toFixed(2)} sh`, buy.instrument_id ? `/holding/${buy.instrument_id}` : null));
        const worthEur = (valueUsd * (usd / usdBuy)) / now;
        const costEur = (Number(slice.eur) * usd) / Number(slice.usd);
        steps.push(step("worth_now", null, "Worth now", worthEur, "EUR", `at ${now.toFixed(4)} today`, null, worthEur - costEur));
      }
      return { usd_share: f2(usd / usdBuy), steps };
    });
    const valueEur = valueUsd / now;
    const market = (valueUsd - usdBuy) / now;
    const currency = usdBuy / now - ecbCost;
    const cost = ecbCost - eurCost;
    return {
      kind: kind as TrailOut["kind"],
      id,
      paths,
      more_paths: two ? 2 : 0,
      split: buy ? { market_eur: f2(market), currency_eur: f2(currency), conversion_cost_eur: f2(-cost), total_eur: f2(valueEur - eurCost) } : null,
      your_rate: f4(usdBuy / eurCost),
      ecb_rate: f4(usdBuy / ecbCost),
      flagged: book === "stress" && kind === "buy" && id % 9 === 0,
    };
  }

  if (kind === "sell" || kind === "withdrawal") {
    const sell = plan.sell ? rows.find((r) => r.id === plan.sell!.id) : rows.find((r) => r.id === 13);
    const wd = plan.withdrawal ? rows.find((r) => r.id === plan.withdrawal!.id) : rows.find((r) => r.id === 14);
    if (!row) return { __status: 404 };
    const covered = (kind === "sell" && sell && row.id === sell.id) || (kind === "withdrawal" && wd && row.id === wd.id);
    const usd = Math.abs(Number(row.net_native));
    if (!covered || !wd) {
      // Any other sale: the proceeds still sit in dollars at the broker.
      return {
        kind: kind as TrailOut["kind"],
        id,
        paths: [
          {
            usd_share: "1.00",
            steps: [
              step(kind === "sell" ? "sold" : "withdrawn", row.date, kind === "sell" ? "Sold" : "Withdrawn", usd, "USD", row.symbol ? String(row.symbol) : "from the broker"),
              step("worth_now", null, "Still in dollars", usd / now, "EUR", `at ${now.toFixed(4)} today`),
            ],
          },
        ],
        more_paths: 0,
        split: null,
        your_rate: null,
        ecb_rate: null,
        flagged: false,
      };
    }
    const back = plan.backs[0]!;
    const out = outs.find((o) => o.conversion_id === back.id)!;
    const sellUsd = sell ? Math.abs(Number(sell.net_native)) : Number(out.usd_sent);
    const steps: TrailStep[] = [];
    if (sell) steps.push(step("sold", sell.date, "Sold", sellUsd, "USD", `${sell.symbol} · ${Math.abs(Number(sell.quantity ?? 0)).toFixed(0)} sh`));
    steps.push(step("withdrawn", wd.date, "Withdrawn", Math.abs(Number(wd.net_native)), "USD", "to the USD account"));
    steps.push(step("back", back.date, "Back in euros", Number(out.eur_received), "EUR", `at ${(back.usd / back.eur).toFixed(4)}`, `/conversions#conversion-${back.id}`, Number(out.eur.realised)));
    return {
      kind: kind as TrailOut["kind"],
      id,
      paths: [{ usd_share: "1.00", steps }],
      more_paths: 0,
      split: {
        market_eur: out.eur.market,
        currency_eur: out.eur.currency,
        conversion_cost_eur: out.eur.conversion_cost,
        total_eur: out.eur.realised,
      },
      your_rate: f4(back.usd / back.eur),
      ecb_rate: f4(back.ecb),
      flagged: out.flagged,
    };
  }
  return { __status: 404 };
}

// ---- extending recorded answers -----------------------------------------------------------

function transactions(data: Obj): Row[] {
  return ((data["GET /api/transactions/all"] as { rows?: Row[] } | undefined)?.rows ?? []) as Row[];
}

function conversions(data: Obj): Obj[] {
  const c = data["GET /api/fx-conversions"];
  return Array.isArray(c) ? (c as Obj[]) : [];
}

function mmIds(data: Obj): Set<number> {
  const both = data["GET /api/holdings/both?group_by=none"] as { USD?: { holdings?: { instrument_id: number; is_money_market: boolean }[] } } | undefined;
  return new Set((both?.USD?.holdings ?? []).filter((h) => h.is_money_market).map((h) => h.instrument_id));
}

function isSweep(r: Row, data: Obj): boolean {
  return r.instrument_id != null && mmIds(data).has(Number(r.instrument_id));
}

function cashOutRows(data: Obj): Row[] {
  const plan = PLAN[bookOf(data)];
  const base = transactions(data)[0] ?? {};
  const rate = 1.085;
  const out: Row[] = [];
  if (plan.sell) {
    const s = plan.sell;
    const usd = s.qty * s.price;
    out.push({
      ...base,
      id: s.id,
      date: s.date,
      kind: "sell",
      symbol: s.symbol,
      instrument_id: s.instrument_id,
      quantity: f4(-s.qty),
      price_native: s.price.toFixed(6),
      net_native: f2(usd),
      net_usd: f2(usd),
      net_eur: f2(usd / rate),
      cash_usd: f2(usd),
      cash_eur: f2(usd / rate),
      currency: "USD",
      fees_native: null,
      source: "manual",
      is_estimate: false,
    } as Row);
  }
  if (plan.withdrawal) {
    const w = plan.withdrawal;
    out.push({
      ...base,
      id: w.id,
      date: w.date,
      kind: "withdrawal",
      symbol: null,
      instrument_id: null,
      quantity: null,
      price_native: null,
      net_native: f2(-w.usd),
      net_usd: f2(-w.usd),
      net_eur: f2(-w.usd / rate),
      cash_usd: f2(-w.usd),
      cash_eur: f2(-w.usd / rate),
      currency: "USD",
      fees_native: null,
      source: "manual",
      is_estimate: false,
    } as Row);
  }
  return out;
}

function withJourneyRows(body: unknown, data: Obj): unknown {
  const b = body as { rows?: Row[] };
  if (!b?.rows) return body;
  const extra = cashOutRows(data).filter((r) => !b.rows!.some((x) => x.id === r.id));
  const rows = [...extra, ...b.rows].sort((a, z) => z.date.localeCompare(a.date) || z.id - a.id);
  return {
    ...b,
    rows: rows.map((r) => {
      const sweep = isSweep(r, data);
      const usd = r.currency === "USD";
      const trail = !usd || sweep ? null : r.kind === "deposit" || r.kind === "buy" || r.kind === "sell" || r.kind === "withdrawal" ? r.kind : null;
      const basis = !usd ? "native" : r.kind === "deposit" ? "your_rate" : r.kind === "buy" && !sweep ? "pool" : "ecb";
      return { ...r, trail_kind: r.trail_kind ?? trail, eur_basis: r.eur_basis ?? basis };
    }),
  };
}

function withDirection(body: unknown, data: Obj): unknown {
  if (!Array.isArray(body)) return body;
  const book = bookOf(data);
  const backs = PLAN[book].backs
    .filter((p) => !body.some((c: Obj) => c.id === p.id))
    .map((p) => ({
      id: p.id,
      date: p.date,
      from_ccy: "USD",
      to_ccy: "EUR",
      direction: "to_eur",
      provider: p.provider,
      eur_sent: f2(p.eur),
      usd_received: f2(p.usd),
      fees_eur: p.fees ? f2(p.fees) : null,
      fees_usd: "0.00",
      rate: f4(p.usd / p.eur),
      effective_rate: f4(p.usd / p.eur),
      all_in_rate: f4(p.usd / (p.eur - p.fees)),
      ecb_rate: f4(p.ecb),
      ecb_rate_date: p.date,
      // Converting back, a rate above the ECB's costs euros: positive cost, like the other way.
      cost_eur: f2(p.usd / p.ecb - p.eur + p.fees),
      spread_eur: f2(p.usd / p.ecb - p.eur),
      cost_usd: f2((p.usd / p.ecb - p.eur + p.fees) * p.ecb),
      off_pct: f4(-(p.usd / p.eur / p.ecb - 1)),
      kept_usd: "0.00",
      remaining_usd: "0.00",
      used_by: [],
      withdrawal_id: p.withdrawal_id,
      is_estimate: false,
      note: null,
    }));
  return ([...backs, ...(body as Obj[]).map((c) => ({ ...c, direction: c.direction ?? (c.from_ccy === "USD" ? "to_eur" : "to_usd") }))] as Obj[]).sort((a, z) =>
    String(z.date).localeCompare(String(a.date)),
  );
}

function withLifetime(body: unknown, data: Obj): unknown {
  const j = journeyFor(bookOf(data));
  const b = body as Record<"EUR" | "USD", Obj>;
  if (!b?.EUR || !b.USD) return body;
  const add = (side: Obj, c: "EUR" | "USD") => {
    const cur = side.currency as Obj | undefined;
    const life = cur?.lifetime as Obj | undefined;
    if (!cur || !life || "your_rate" in life) return side;
    const r = j.EUR.stats.your_rate;
    const conv = j.EUR.bridge!.lines.find((l) => l.key === "conversion_cost")!.eur;
    const back = j.EUR.back_in_euros;
    return {
      ...side,
      currency: {
        ...cur,
        lifetime: {
          ...life,
          your_rate: r.rate,
          ecb_avg: r.ecb_avg,
          breakeven_rate: r.rate,
          conversion_cost_eur: conv,
          realised_eur: back ? back.realised_eur : null,
          fx_pnl_eur: j.EUR.bridge!.total_eur,
          vs_impact_note:
            c === "EUR"
              ? "Impact's lifetime currency figure differs a little: it values each day's holdings at that day's rate, this card your rate against today's."
              : "In dollars the currency adds nothing; this card shows what it did to your euros.",
        },
      },
    };
  };
  return { ...b, EUR: add(b.EUR, "EUR"), USD: add(b.USD, "USD") };
}

function withHoldingsRate(body: unknown, data: Obj): unknown {
  const b = body as Record<"EUR" | "USD", Obj>;
  if (!b?.EUR || !b.USD) return body;
  const rate = journeyFor(bookOf(data)).EUR.stats.your_rate.rate;
  return { ...b, EUR: { ...b.EUR, fx_your_rate: b.EUR.fx_your_rate ?? rate }, USD: { ...b.USD, fx_your_rate: b.USD.fx_your_rate ?? rate } };
}

function withCashedOut(body: unknown, data: Obj, periods: boolean): unknown {
  const b = body as Record<"EUR" | "USD", Obj & { rows?: Obj[] }>;
  if (!b?.EUR || !b.USD) return body;
  const backs = PLAN[bookOf(data)].backs;
  const add = (side: Obj & { rows?: Obj[] }, c: "EUR" | "USD") => {
    if (!side.rows) return side;
    if (periods) {
      return {
        ...side,
        rows: side.rows.map((r) => {
          const label = String(r.label ?? "");
          const hit = backs.filter((p) => (label.length === 4 ? p.date.slice(0, 4) === label : p.date.slice(0, 7) === label));
          const amount = hit.reduce((t, p) => t + (c === "EUR" ? p.eur : p.usd), 0);
          return { ...r, cashed_out_eur: r.cashed_out_eur ?? f2(c === "EUR" ? amount : hit.reduce((t, p) => t + p.eur, 0)), cashed_out: f2(amount) };
        }),
      };
    }
    const total = backs.reduce((t, p) => t + (c === "EUR" ? p.eur : p.usd), 0);
    const totalEur = backs.reduce((t, p) => t + p.eur, 0);
    const summary = (side.summary ?? {}) as Obj;
    return { ...side, cashed_out_eur: f2(totalEur), summary: { ...summary, cashed_out: f2(total), cashed_out_eur: f2(totalEur) } };
  };
  return { ...b, EUR: add(b.EUR, "EUR"), USD: add(b.USD, "USD") };
}

function withTranches(body: unknown, data: Obj): unknown {
  const b = body as { rows?: (Obj & { cost_native: string; gain_native: string; acquired_on: string })[]; symbol?: string };
  if (!b?.rows) return body;
  const now = rateNow(data);
  const book = bookOf(data);
  const rows = b.rows.map((r, i) => {
    if ("cost_eur" in r) return r;
    // A "your rate" a little under the day's ECB rate, from the tranche's age (made up, stable).
    const yr = 1.06 + ((dayNum(r.acquired_on) % 97) / 97) * 0.1;
    const cost = Number(r.cost_native);
    const costEur = cost / yr;
    const valueUsd = cost + Number(r.gain_native);
    const eurNow = valueUsd / now;
    const market = Number(r.gain_native) / now;
    return {
      ...r,
      cost_eur: f2(costEur),
      orig_eur: f2(costEur),
      your_rate: f4(yr),
      gain_eur: f2(eurNow - costEur),
      market_eur: f2(market),
      currency_eur: f2(eurNow - costEur - market),
      back_in_euros: null,
      ...(book === "stress" && i === 0 ? { your_rate: null, cost_eur: null, gain_eur: null } : {}),
    };
  });
  return { ...b, rows, ...sold(b.symbol, data) };
}

/** The sold-tranche result the Holding page shows under the open lots (the cash-out's sale). */
function sold(symbol: string | undefined, data: Obj): Obj {
  const book = bookOf(data);
  const plan = PLAN[book];
  const sym = plan.sell?.symbol ?? "FAKEG";
  if (symbol !== sym) return {};
  const out = cashOutsFor(book).find((o) => o.conversion_id === plan.backs[0]!.id)!;
  return {
    sold_lots: [
      {
        date: plan.sell?.date ?? "2025-11-12",
        quantity: plan.sell ? f4(plan.sell.qty) : "150.0000",
        proceeds_native: plan.sell ? f2(plan.sell.qty * plan.sell.price) : "11987.46",
        back_in_euros: true,
        realised_eur: out.eur.realised,
        market_eur: out.eur.market,
        currency_eur: out.eur.currency,
        conversion_cost_eur: out.eur.conversion_cost,
        conversion_id: out.conversion_id,
      },
      ...(book === "stress"
        ? [{ date: "2026-04-02", quantity: "12.5000", proceeds_native: "1051.20", back_in_euros: null, realised_eur: null, market_eur: "88.10", currency_eur: null, conversion_cost_eur: null, conversion_id: null }]
        : []),
    ],
  };
}

function withPeeks(body: unknown, data: Obj): unknown {
  const b = body as { peeks?: Record<string, Obj> } & Obj;
  const rate = journeyFor(bookOf(data)).EUR.stats.your_rate.rate;
  if (b?.peeks) return { ...b, peeks: Object.fromEntries(Object.entries(b.peeks).map(([k, p]) => [k, { ...p, your_rate: p.your_rate ?? rate }])) };
  if (b && typeof b === "object" && "instrument_id" in b) return { ...b, your_rate: b.your_rate ?? rate };
  return body;
}

function withDiagnostics(body: unknown, data: Obj): unknown {
  const b = body as { checks?: Obj[] } & Obj;
  if (!b?.checks || b.checks.some((c) => c.id === "idle_dollars")) return body;
  const j = journeyFor(bookOf(data)).EUR;
  const stress = bookOf(data) === "stress";
  const check = (id: string, title: string, severity: string, count: number, detail: string, label: string, to: string) => ({
    id,
    title,
    severity: count === 0 ? "ok" : severity,
    count,
    detail,
    examples: [],
    actions: [],
    fix: count === 0 ? null : { label, to },
  });
  const extra = [
    check("idle_dollars", "Idle dollars", "info", j.idle.length, j.idle.length ? `${j.idle.length} conversion${j.idle.length === 1 ? "" : "s"} left dollars in the USD account for more than 30 days.` : "No dollars have waited more than 30 days.", "Open the Currency page", "/currency#dollars"),
    check("uncovered_buys", "Buys not covered by deposits", "warn", j.flagged.uncovered_buys, j.flagged.uncovered_buys ? `${j.flagged.uncovered_buys} buys spent more dollars than you had deposited; their euro cost uses the ECB rate.` : "Every buy is paid for by deposited dollars.", "Review conversions", "/conversions?needs=1"),
    check("negative_broker_cash", "Negative broker cash", "warn", stress ? 1 : 0, stress ? "Retirement shows −$12.40 of cash; it counts as $0 in the total." : "No account has negative cash.", "Open transactions", "/transactions"),
    check("withdrawals_not_converted", "Withdrawals not yet converted back", "info", stress ? 1 : 0, stress ? "1 withdrawal is still in dollars in the USD account." : "Every withdrawal has gone back to euros.", "Cash out to euros", "/cash-out"),
    check("conversion_back_uncovered", "Conversions back with no dollars behind them", "warn", stress ? 1 : 0, stress ? "1 conversion back sent more dollars than the USD account held; the rest uses the ECB rate." : "Every conversion back is covered by dollars.", "Open conversions", "/conversions?direction=to_eur"),
  ];
  return { ...b, checks: [...b.checks, ...extra] };
}

/** A preview of a conversion back (the guided flow's last step), worked like the server would. */
function preview(body: CashOutPreviewIn, data: Obj): CashOutOut {
  const book = bookOf(data);
  const usd = Number(body.usd_sent) || 0;
  const eur = Number(body.eur_received) || 0;
  const fees = Number(body.fees_eur) || 0;
  // The dollars' book: the nice cash-out's per-dollar figures, scaled.
  const ref = cashOutsFor(book)[book === "nice" ? 0 : 2]!;
  const k = usd / Number(ref.usd_sent);
  const ecb = book === "nice" ? 1.0862 : 1.1589;
  const orig = Number(ref.eur.put_in) * k;
  const market = Number(ref.eur.market) * k;
  const atEcb = usd / ecb;
  const currency = atEcb - orig - market;
  const cost = eur - atEcb - fees;
  const realised = eur - fees - orig;
  const days = Math.max(1, dayNum(body.date || ANCHOR) - dayNum(book === "nice" ? "2024-09-02" : "2024-01-10"));
  const xirr = orig > 0 && eur - fees > 0 ? Math.pow((eur - fees) / orig, 365 / days) - 1 : null;
  const usdPut = Number(ref.usd.put_in) * k;
  const usdX = usdPut > 0 && usd > 0 ? Math.pow(usd / usdPut, 365 / days) - 1 : null;
  const gap = xirr !== null && usdX !== null ? (xirr - usdX) * 100 : null;
  return {
    conversion_id: null,
    date: body.date,
    usd_sent: f2(usd),
    eur_received: f2(eur),
    fees_eur: f2(fees),
    eur: { put_in: f2(orig), market: f2(market), currency: f2(currency), conversion_cost: f2(cost), realised: f2(realised), realised_pct: orig ? f4(realised / orig) : null, xirr: xirr === null ? null : f4(xirr) },
    usd: { put_in: f2(usdPut), market: f2(usd - usdPut), realised: f2(usd - usdPut), realised_pct: usdPut ? f4(usd / usdPut - 1) : null, xirr: usdX === null ? null : f4(usdX) },
    note:
      gap === null
        ? "Enter the dollars sent and the euros received to see the result."
        : `In euros you kept ${Math.abs(gap).toFixed(1)} points a year ${gap >= 0 ? "more" : "less"} than in dollars.`,
    flagged: false,
  };
}

// ---- routing -----------------------------------------------------------------------------

/** A 7.4 answer for this request, or undefined to fall through. `{__status}` answers with that status. */
export function journeyAnswer(url: URL, method: string, data: Obj, body?: string): unknown | undefined {
  const path = url.pathname;
  if (method === "POST" && path === "/api/cash-out/preview") {
    try {
      return preview(JSON.parse(body ?? "{}") as CashOutPreviewIn, data);
    } catch {
      return { __status: 422 };
    }
  }
  if (method !== "GET") return undefined;
  if (path === "/api/currency/journey" || path === "/api/currency/journey/both") {
    const j = journeyFor(bookOrEmpty(data));
    // §8 names the sides eur / usd; both spellings are sent until the generated types settle it.
    const both: JourneyBoth = { eur: j.EUR, usd: j.USD };
    return both;
  }
  const m = /^\/api\/trail\/(deposit|buy|sell|withdrawal|conversion)\/(\d+)$/.exec(path);
  if (m) return trailFor(m[1]!, Number(m[2]), data);
  return undefined;
}

/** Adds the 7.4 fields to a recorded (or synthesised) answer. */
export function journeyExtend(path: string, body: unknown, data: Obj): unknown {
  if (path === "/api/transactions/all") return withJourneyRows(body, data);
  if (path === "/api/fx-conversions") return withDirection(body, data);
  if (path === "/api/overview/both") return withLifetime(body, data);
  if (path === "/api/holdings/both") return withHoldingsRate(body, data);
  if (path === "/api/deposits/both") return withCashedOut(body, data, false);
  if (path.startsWith("/api/periods/")) return withCashedOut(body, data, true);
  if (path === "/api/diagnostics") return withDiagnostics(body, data);
  if (/^\/api\/holdings\/\d+\/tranches$/.test(path)) return withTranches(body, data);
  if (path === "/api/holdings/peeks" || /^\/api\/holdings\/\d+\/peek$/.test(path)) return withPeeks(body, data);
  return body;
}

/** Test hook: the journey of a book. */
export const journeyFixture = (book: "nice" | "stress") => journeyFor(book);
export const PLAN_FOR_TESTS = PLAN;
