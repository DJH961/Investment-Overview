/**
 * Fixture answers for the 7.1 endpoints (docs/v7_1_contract.md) until the recorder
 * writes them: synthesised from the recorded holdings, anchored on the recording day
 * (`installFixtures` then shifts every date to this week, like the recorded answers).
 *
 * Shows: FAKEL (a stock) with four tranches (one long-term within 60 days), a fully
 * sold purchase and a reinvested-dividend group; FAKENX (a NAV fund) with its FAKEL
 * twin; lookup results, one of them owned. Numbers are made up and only roughly
 * consistent; they exist to exercise the screens.
 */

type Obj = Record<string, unknown>;
type Row = {
  instrument_id: number;
  symbol: string;
  name: string;
  native_currency: string;
  price_type: string;
  is_money_market: boolean;
  shares: string;
  price_native: string | null;
  avg_price_native: string | null;
  account: string;
  value: string | null;
  twin?: Obj | null;
};

const ANCHOR = "2026-06-30";
const DAY = 86_400_000;
const dayNum = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY);
const iso = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);
const END = dayNum(ANCHOR);
const isWeekday = (n: number) => {
  const w = new Date(n * DAY).getUTCDay();
  return w !== 0 && w !== 6;
};
const s = (v: number, digits = 6) => v.toFixed(digits);

/** A smooth deterministic wiggle (no Math.random: the same picture every reload). */
const wiggle = (seed: number, x: number) =>
  0.012 * Math.sin(x * 0.9 + seed) + 0.008 * Math.sin(x * 2.7 + seed * 2) + 0.004 * Math.sin(x * 7.1 + seed * 3);

function rows(data: Obj): { usd: Row[]; eur: Row[]; rate: number } {
  const both = data["GET /api/holdings/both?group_by=none"] as { USD: { holdings: Row[] }; EUR: { holdings: Row[] } } | undefined;
  const usd = both?.USD.holdings ?? [];
  const eur = both?.EUR.holdings ?? [];
  const a = usd.find((r) => r.native_currency === "USD" && Number(r.value) > 0);
  const b = a && eur.find((r) => r.instrument_id === a.instrument_id);
  const rate = a && b ? Number(b.value) / Number(a.value) : 0.86; // EUR per USD
  return { usd, eur, rate };
}

// ---- trades and tranches ------------------------------------------------------------

interface Trade {
  date: string;
  kind: "buy" | "sell";
  qty: number;
  price: number;
}

function tradesFor(row: Row): Trade[] {
  const shares = Number(row.shares);
  const avg = Number(row.avg_price_native ?? row.price_native ?? 1);
  if (row.symbol === "FAKEL") {
    return [
      { date: "2022-05-10", kind: "buy", qty: 300, price: 88 },
      { date: "2023-01-17", kind: "sell", qty: 300, price: 97 },
      { date: "2023-03-14", kind: "buy", qty: 2000, price: 95.2 },
      { date: "2024-08-20", kind: "buy", qty: 1500, price: 131.4 },
      { date: "2025-08-05", kind: "buy", qty: 800, price: 182.75 },
    ];
  }
  return [{ date: "2024-01-15", kind: "buy", qty: shares, price: avg }];
}

const REINVEST_DATES = ["2024-03-20", "2024-06-20", "2024-09-20", "2024-12-20", "2025-03-20", "2025-06-20", "2025-09-19", "2025-12-19", "2026-03-20"];

function tranches(row: Row, accountId: number): Obj {
  const price = Number(row.price_native ?? 0);
  const ccy = row.native_currency;
  const out: Obj[] = [];
  let id = 1;
  const lot = (date: string, source: string, bought: number, left: number, cps: number) => {
    const age = END - dayNum(date);
    const y = new Date(`${date}T00:00:00Z`);
    const longOn = iso(dayNum(`${y.getUTCFullYear() + 1}-${date.slice(5)}`) + 1);
    const toLong = dayNum(longOn) - END;
    const status = toLong <= 0 ? "long" : toLong <= 60 ? "soon" : "short";
    const cost = left * cps;
    out.push({
      id: id++,
      account_id: accountId,
      account_name: row.account,
      acquired_on: date,
      source,
      quantity_bought: s(bought, 4),
      quantity_left: s(left, 4),
      cost_per_share_native: s(cps),
      cost_native: s(cost, 2),
      age_days: age,
      long_term_on: longOn,
      days_to_long_term: toLong <= 0 ? null : toLong,
      status,
      gain_native: s(left * price - cost, 2),
      gain_pct: cost > 0 ? s((left * price - cost) / cost) : null,
    });
  };
  let fullySold = 0;
  for (const t of tradesFor(row)) {
    if (t.kind === "sell") continue;
    const sold = row.symbol === "FAKEL" && t.date === "2022-05-10";
    if (sold) {
      fullySold += 1;
      continue;
    }
    lot(t.date, "buy", t.qty, t.qty, t.price);
  }
  const groups: Obj[] = [];
  if (row.symbol === "FAKEL") {
    // Four decimals each, the last one takes the rest, so the lots sum to the position exactly.
    const total = Number(row.shares) - 4300;
    const each = Math.floor((total / REINVEST_DATES.length) * 1e4) / 1e4;
    const first = id;
    REINVEST_DATES.forEach((d, i) => {
      const q = i === REINVEST_DATES.length - 1 ? total - each * (REINVEST_DATES.length - 1) : each;
      lot(d, "reinvest", q, q, 150 + i * 12);
    });
    const members = out.filter((r) => (r.id as number) >= first);
    const cost = members.reduce((a, r) => a + Number(r.cost_native), 0);
    const left = members.reduce((a, r) => a + Number(r.quantity_left), 0);
    const gain = members.reduce((a, r) => a + Number(r.gain_native), 0);
    groups.push({
      account_id: accountId,
      source: "reinvest",
      count: members.length,
      quantity_left: s(left, 4),
      cost_native: s(cost, 2),
      avg_cost_per_share_native: s(cost / left),
      gain_native: s(gain, 2),
      gain_pct: s(gain / cost),
      long_count: members.filter((r) => r.status === "long").length,
      short_count: members.filter((r) => r.status !== "long").length,
      row_ids: members.map((r) => r.id),
    });
  }
  const left = out.reduce((a, r) => a + Number(r.quantity_left), 0);
  const longQ = out.filter((r) => r.status === "long").reduce((a, r) => a + Number(r.quantity_left), 0);
  return {
    instrument_id: row.instrument_id,
    symbol: row.symbol,
    currency: ccy,
    method: "fifo_view",
    as_of: ANCHOR,
    price_native: row.price_native,
    rows: out,
    groups,
    totals: {
      quantity_left: s(left, 4),
      position_quantity: s(Number(row.shares), 4),
      matches_position: Math.abs(left - Number(row.shares)) < 1e-6,
      long_quantity: s(longQ, 4),
      short_quantity: s(left - longQ, 4),
      fully_sold_count: fullySold,
    },
  };
}

// ---- price paths ----------------------------------------------------------------------

const RANGE_START: Record<string, number> = {
  "1m": END - 30,
  "3m": END - 91,
  "6m": END - 182,
  ytd: dayNum("2026-01-01"),
  "1y": END - 365,
  all: dayNum("2022-05-10"),
};

/** Daily close for a symbol on day n: ends at `last`, a gentle drift plus a wiggle. */
function closeOn(seed: number, last: number, n: number, drift = 0.00045): number {
  const x = n - END;
  return last * Math.exp(drift * x + wiggle(seed, n / 9) - wiggle(seed, END / 9));
}

const SESSION_OPEN = "13:30:00";
const SESSION_CLOSE = "20:00:00";
/** Instants carry their offset, like the recorded answers (else a browser reads them as local). */
const UTC = "+00:00";

function sessionDays(count: number): number[] {
  const out: number[] = [];
  for (let n = END; out.length < count; n--) if (isWeekday(n)) out.unshift(n);
  return out;
}

/** Intraday prices every 10 minutes through a session, landing on that day's close. */
function intraday(seed: number, last: number, days: number[]): { t: string; v: number }[] {
  const pts: { t: string; v: number }[] = [];
  for (const n of days) {
    const close = closeOn(seed, last, n);
    const prev = closeOn(seed, last, n - 1);
    for (let m = 0; m <= 390; m += 10) {
      const f = m / 390;
      const v = prev + (close - prev) * f + prev * 0.003 * Math.sin(f * 9 + seed + n);
      const at = new Date(Date.parse(`${iso(n)}T${SESSION_OPEN}Z`) + m * 60_000).toISOString().slice(0, 19) + UTC;
      pts.push({ t: at, v: m === 390 ? close : v });
    }
  }
  return pts;
}

const sessionsOf = (days: number[]) => days.map((n) => ({ open: `${iso(n)}T${SESSION_OPEN}${UTC}`, close: `${iso(n)}T${SESSION_CLOSE}${UTC}` }));

function seedOf(symbol: string): number {
  return [...symbol].reduce((a, c) => a + c.charCodeAt(0), 0) % 17;
}

function sharesOn(trades: Trade[], day: number, finalShares: number): number {
  const traded = trades.filter((t) => dayNum(t.date) <= day).reduce((a, t) => a + (t.kind === "buy" ? t.qty : -t.qty), 0);
  const total = trades.reduce((a, t) => a + (t.kind === "buy" ? t.qty : -t.qty), 0);
  // Reinvested shares trickle in over time (FAKEL): spread the gap linearly.
  const gap = finalShares - total;
  const firstDay = dayNum(trades[0]?.date ?? ANCHOR);
  return traded + (gap > 0 ? gap * Math.min(1, Math.max(0, (day - firstDay) / (END - firstDay))) : 0);
}

function history(row: Row, range: string, mode: string, rate: number): Obj | { __status: number } {
  const nav = row.price_type === "nav" || row.is_money_market;
  if (nav && (range === "1d" || range === "1w")) return { __status: 422 };
  const seed = seedOf(row.symbol);
  const last = Number(row.price_native ?? 1);
  const trades = tradesFor(row);
  const shares = Number(row.shares);
  const usd = row.native_currency === "USD";
  const eurOf = (native: number) => (usd ? native * rate : native);
  const usdOf = (native: number) => (usd ? native : native / rate);
  const intra = range === "1d" || range === "1w";
  let pts: { t: string; v: number; day: number }[];
  let days: number[] = [];
  if (intra) {
    days = sessionDays(range === "1d" ? 1 : 5);
    pts = intraday(seed, last, days).map((p) => ({ ...p, day: dayNum(p.t.slice(0, 10)) }));
  } else {
    const start = RANGE_START[range] ?? RANGE_START["1y"];
    pts = [];
    for (let n = start; n <= END; n++) if (isWeekday(n)) pts.push({ t: iso(n), v: closeOn(seed, last, n), day: n });
  }
  const first = pts[0]?.day ?? END;
  const flowsTo = (day: number) =>
    trades.filter((t) => dayNum(t.date) <= day).reduce((a, t) => a + (t.kind === "buy" ? 1 : -1) * t.qty * t.price, 0);
  const points = pts.map((p) => {
    const value = sharesOn(trades, p.day, shares) * p.v;
    const inv = flowsTo(p.day);
    return {
      t: p.t,
      v: s(p.v),
      value_native: mode === "value" ? s(value, 2) : null,
      value_eur: mode === "value" ? s(eurOf(value), 2) : null,
      value_usd: mode === "value" ? s(usdOf(value), 2) : null,
      invested_eur: mode === "value" ? s(eurOf(inv), 2) : null,
      invested_usd: mode === "value" ? s(usdOf(inv), 2) : null,
    };
  });
  const inRange = trades.filter((t) => dayNum(t.date) >= first && dayNum(t.date) <= END);
  const startV = Number(points[0]?.value_native ?? 0) || sharesOn(trades, first, shares) * (pts[0]?.v ?? last);
  const endV = shares * last;
  const bought = inRange.reduce((a, t) => a + (t.kind === "buy" ? 1 : -1) * t.qty * t.price, 0);
  const divs = endV * 0.006 * ((END - first) / 365);
  const change = endV - startV - bought;
  const ret = change / Math.max(1, startV + bought / 2);
  return {
    instrument_id: row.instrument_id,
    symbol: row.symbol,
    ccy: row.native_currency,
    range,
    mode,
    x_mode: intra ? "time" : "date",
    sessions: intra ? sessionsOf(days) : [],
    points,
    trades: inRange.map((t) => ({ t: t.date, kind: t.kind, quantity: s(t.qty, 4), price_native: s(t.price) })),
    avg_price_native: row.avg_price_native,
    period: {
      change_eur: s(eurOf(change), 2),
      change_usd: s(usdOf(change), 2),
      return_eur: s(ret),
      return_usd: s(ret),
      bought_eur: s(eurOf(bought), 2),
      bought_usd: s(usdOf(bought), 2),
      dividends_eur: s(eurOf(divs), 2),
      dividends_usd: s(usdOf(divs), 2),
    },
  };
}

// ---- twin -----------------------------------------------------------------------------

function twin(row: Row, twinRow: Row | undefined, range: string): Obj | { __status: number } {
  if (!row.twin || !twinRow) return { __status: 404 };
  const tSeed = seedOf(twinRow.symbol);
  const fSeed = seedOf(row.symbol);
  const tLast = Number(twinRow.price_native ?? 1);
  const fLast = Number(row.price_native ?? 1);
  const pending = Boolean(row.twin.pending);
  const base = {
    instrument_id: row.instrument_id,
    symbol: row.symbol,
    twin_symbol: twinRow.symbol,
    twin_reason: "manual",
    range,
    twin_now: { price_native: s(tLast), day_pct: s(closeOn(tSeed, tLast, END) / closeOn(tSeed, tLast, END - 1) - 1), captured_at: "2026-06-30T18:15:00+00:00" },
    stats: { median_gap_pp: "0.0600", bias_pp: "0.0200", bias_label: "runs_high", sessions: 38 },
    recent: sessionDays(6)
      .slice(0, 5)
      .reverse()
      .map((n, i) => {
        const est = closeOn(tSeed, tLast, n) / closeOn(tSeed, tLast, n - 1) - 1;
        const gap = [0.04, -0.03, 0.07, 0.02, -0.05][i] ?? 0;
        return { session_date: iso(n), estimate_pct: s(est), nav_pct: s(est - gap / 100), gap_pp: s(gap, 4) };
      }),
  };
  if (range === "1d" || range === "1w") {
    const days = sessionDays(range === "1d" ? 1 : 5);
    const twinPts = intraday(tSeed, tLast, days);
    // While the NAV is pending, today's session stops at the live minute.
    const live = pending ? twinPts.filter((p) => p.t <= "2026-06-30T18:15:00") : twinPts;
    const prevNav = fLast;
    const prevTwin = closeOn(tSeed, tLast, END - 1);
    const navDays = pending ? days.filter((n) => n !== END) : days;
    return {
      ...base,
      x_mode: "time",
      sessions: sessionsOf(days),
      twin_points: live.map((p) => ({ t: p.t, price_native: s(p.v) })),
      estimate_points:
        range === "1d" ? live.filter((p) => p.t.startsWith(ANCHOR)).map((p) => ({ t: p.t, price_native: s((prevNav * p.v) / prevTwin) })) : [],
      nav_points: navDays.map((n) => ({ t: `${iso(n)}T${SESSION_CLOSE}${UTC}`, nav_native: s(closeOn(fSeed, fLast, n, 0.0004)) })),
      rebased: null,
    };
  }
  const start = RANGE_START[range] ?? RANGE_START["1y"];
  const days: number[] = [];
  for (let n = start; n <= END; n++) if (isWeekday(n)) days.push(n);
  const f0 = closeOn(fSeed, fLast, start, 0.0004);
  const t0 = closeOn(tSeed, tLast, start);
  return {
    ...base,
    x_mode: "date",
    sessions: [],
    twin_points: days.map((n) => ({ t: iso(n), price_native: s(closeOn(tSeed, tLast, n)) })),
    estimate_points: [],
    nav_points: days.map((n) => ({ t: iso(n), nav_native: s(closeOn(fSeed, fLast, n, 0.0004)) })),
    rebased: days.map((n) => {
      const f = closeOn(fSeed, fLast, n, 0.0004) / f0 - 1;
      const t = closeOn(tSeed, tLast, n) / t0 - 1;
      return { t: iso(n), fund_pct: s(f), twin_pct: s(t), gap_pp: s((t - f) * 100, 4) };
    }),
  };
}

// ---- peek -----------------------------------------------------------------------------

function peek(row: Row, data: Obj, accountId: number): Obj {
  const seed = seedOf(row.symbol);
  const last = Number(row.price_native ?? 1);
  const shares = Number(row.shares);
  const days = sessionDays(5);
  const points = days.map((n) => ({ t: iso(n), value_native: s(closeOn(seed, last, n) * shares, 2) }));
  const v0 = Number(points[0]?.value_native ?? 0);
  const lots = tranches(row, accountId) as { rows: { days_to_long_term: number | null; long_term_on: string }[] };
  const next = lots.rows.filter((r) => r.days_to_long_term !== null).sort((a, b) => a.days_to_long_term! - b.days_to_long_term!)[0];
  const trades = tradesFor(row);
  const lastTrade = trades[trades.length - 1];
  const divs = (data["GET /api/deposits/dividends/both"] as { USD?: { rows?: Obj[] } } | undefined)?.USD?.rows ?? [];
  const lastDiv = divs.filter((d) => d.symbol === row.symbol).sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  return {
    week: { points, change_pct: v0 > 0 ? s(Number(points[points.length - 1]?.value_native) / v0 - 1) : null },
    tranches: { open_count: lots.rows.length, next_long_term_on: next?.long_term_on ?? null, next_long_term_days: next?.days_to_long_term ?? null },
    last_trade: lastTrade ? { date: lastTrade.date, kind: lastTrade.kind, quantity: s(lastTrade.qty, 4) } : null,
    last_dividend: lastDiv ? { date: lastDiv.date, amount: lastDiv.amount_native, currency: lastDiv.currency } : null,
    twin: row.twin ?? null,
  };
}

// ---- lookup ---------------------------------------------------------------------------

const CATALOG = [
  { symbol: "FAKEQ", name: "Fakequity Holdings Corp.", exchange: "NASDAQ", type: "Stock", currency: "USD", price: 412.37, low: 301.2, high: 455.9, seed: 3 },
  { symbol: "FAKEW", name: "Fake World Broad Market ETF", exchange: "NYSE Arca", type: "ETF", currency: "USD", price: 118.04, low: 97.5, high: 121.3, seed: 8 },
  { symbol: "FAKEX.DE", name: "Fakeland Industrie AG", exchange: "XETRA", type: "Stock", currency: "EUR", price: 63.18, low: 48.1, high: 70.4, seed: 11 },
];

function lookupSearch(q: string, usd: Row[]): Obj {
  const needle = q.trim().toLowerCase();
  const held = usd.map((r) => ({ symbol: r.symbol, name: r.name, exchange: "Portfolio", type: r.price_type === "nav" ? "Mutual fund" : "ETF", currency: r.native_currency, held_instrument_id: r.instrument_id }));
  const others = CATALOG.map((c) => ({ symbol: c.symbol, name: c.name, exchange: c.exchange, type: c.type, currency: c.currency, held_instrument_id: null }));
  const results = [...held, ...others].filter((r) => r.symbol.toLowerCase().includes(needle) || r.name.toLowerCase().includes(needle)).slice(0, 10);
  return { results };
}

function lookupQuote(symbol: string, rate: number): Obj | { __status: number } {
  const c = CATALOG.find((x) => x.symbol === symbol);
  if (!c) return { __status: 404 };
  const prev = closeOn(c.seed, c.price, END - 1);
  return {
    symbol: c.symbol,
    name: c.name,
    exchange: c.exchange,
    type: c.type,
    currency: c.currency,
    price_native: s(c.price),
    day_change_native: s(c.price - prev),
    day_pct: s(c.price / prev - 1),
    captured_at: "2026-06-30T18:15:00+00:00",
    week52_low: s(c.low),
    week52_high: s(c.high),
    fx_eur_usd: s(1 / rate),
  };
}

function lookupHistory(symbol: string, range: string, rate: number): Obj | { __status: number } {
  const c = CATALOG.find((x) => x.symbol === symbol);
  if (!c) return { __status: 404 };
  const intra = range === "1d" || range === "1w";
  const fxAt = (n: number) => s((1 / rate) * (1 + 0.004 * Math.sin(n / 5)));
  if (intra) {
    const days = sessionDays(range === "1d" ? 1 : 5);
    return {
      symbol,
      currency: c.currency,
      range,
      x_mode: "time",
      sessions: sessionsOf(days),
      points: intraday(c.seed, c.price, days).map((p) => ({ t: p.t, price_native: s(p.v), fx_eur_usd: fxAt(dayNum(p.t.slice(0, 10))) })),
    };
  }
  const start = range === "all" ? END - 365 * 5 : (RANGE_START[range] ?? RANGE_START["1y"]);
  const points = [];
  for (let n = start; n <= END; n++) if (isWeekday(n)) points.push({ t: iso(n), price_native: s(closeOn(c.seed, c.price, n)), fx_eur_usd: fxAt(n) });
  return { symbol, currency: c.currency, range, x_mode: "date", sessions: [], points };
}

// ---- additions to recorded answers ------------------------------------------------------

/** `/deposits/dividends/both` › `by_holding` gains `by_year`, `last_12m`, `yield_ttm`. */
function withDividendExtras(body: unknown, usd: Row[], eur: Row[]): unknown {
  const b = body as Record<string, { rows: Obj[]; by_holding: Obj[] }>;
  if (!b?.USD) return body;
  const out: Obj = { ...b };
  for (const side of ["EUR", "USD"] as const) {
    const d = b[side];
    if (!d) continue;
    const holdings = side === "EUR" ? eur : usd;
    out[side] = {
      ...d,
      by_holding: d.by_holding.map((h) => {
        if ("by_year" in h) return h;
        const mine = d.rows.filter((r) => r.symbol === h.symbol);
        const years = new Map<number, number>();
        for (const r of mine) years.set(Number(String(r.date).slice(0, 4)), (years.get(Number(String(r.date).slice(0, 4))) ?? 0) + Number(r.amount ?? 0));
        const value = Number(holdings.find((x) => x.symbol === h.symbol)?.value ?? 0);
        return {
          ...h,
          by_year: [...years].sort((a, c) => a[0] - c[0]).map(([year, amount]) => ({ year, amount: s(amount, 2) })),
          last_12m: h.ttm,
          yield_ttm: value > 0 ? s(Number(h.ttm) / value) : null,
        };
      }),
    };
  }
  return out;
}

/** `/analytics/both` › attribution rows gain `share_of_pnl` and `own_return`. */
function withAttributionExtras(body: unknown): unknown {
  const b = body as Record<string, { attribution?: Obj[] }>;
  if (!b?.USD) return body;
  const out: Obj = { ...b };
  for (const side of ["EUR", "USD"] as const) {
    const d = b[side];
    if (!d?.attribution) continue;
    const total = d.attribution.reduce((a, r) => a + Number(r.absolute_pnl ?? 0), 0);
    out[side] = {
      ...d,
      attribution: d.attribution.map((r) => {
        if ("share_of_pnl" in r) return r;
        const pnl = Number(r.absolute_pnl ?? 0);
        const start = Number(r.start_value ?? 0);
        const flow = Number(r.net_contribution ?? 0);
        return {
          ...r,
          share_of_pnl: Math.abs(total) > 1 ? s(pnl / total) : null,
          own_return: start + flow / 2 > 0 ? s(pnl / (start + flow / 2)) : null,
        };
      }),
    };
  }
  return out;
}

/**
 * The 7.1 answer for a GET, or undefined to fall through to the recorded data. A
 * `{__status}` body is answered with that status.
 */
export function v71Answer(url: URL, data: Obj): unknown | undefined {
  const path = url.pathname;
  const { usd, rate } = rows(data);
  const accounts = (data["GET /api/accounts"] as { id: number; account_label?: string; name?: string }[] | undefined) ?? [];
  const accountId = (row: Row) => accounts.find((a) => (a.account_label ?? a.name) === row.account)?.id ?? 1;
  let m = /^\/api\/holdings\/(\d+)\/(peek|tranches|twin|history)$/.exec(path);
  if (m) {
    const row = usd.find((r) => r.instrument_id === Number(m![1]));
    if (!row) return { __status: 404 };
    const range = url.searchParams.get("range") ?? "1y";
    if (m[2] === "peek") return peek(row, data, accountId(row));
    if (m[2] === "tranches") return tranches(row, accountId(row));
    if (m[2] === "twin") return twin(row, usd.find((r) => r.symbol === (row.twin?.symbol as string | undefined)), range === "all" ? "1y" : range);
    return history(row, range, url.searchParams.get("mode") ?? "price", rate);
  }
  if (path === "/api/lookup/search") return lookupSearch(url.searchParams.get("q") ?? "", usd);
  m = /^\/api\/lookup\/([^/]+)\/(quote|history)$/.exec(path);
  if (m) {
    const symbol = decodeURIComponent(m[1]).toUpperCase();
    return m[2] === "quote" ? lookupQuote(symbol, rate) : lookupHistory(symbol, url.searchParams.get("range") ?? "1y", rate);
  }
  return undefined;
}

/** Adds the 7.1 fields to a recorded answer (only the endpoints the contract extends). */
export function v71Extend(path: string, body: unknown, data: Obj): unknown {
  if (path === "/api/deposits/dividends/both") {
    const { usd, eur } = rows(data);
    return withDividendExtras(body, usd, eur);
  }
  if (path === "/api/analytics/both") return withAttributionExtras(body);
  return body;
}
