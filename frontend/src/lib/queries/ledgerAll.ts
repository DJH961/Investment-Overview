import { keepPreviousData, queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { components } from "../api-types";

type Schemas = components["schemas"];
export type TransactionOut = Schemas["TransactionOut"];
export type TransactionAll = Schemas["TransactionAll"];

export type LedgerSortKey = "date" | "symbol" | "kind" | "account" | "quantity" | "net";

/** The whole ledger once; the page filters, sorts and pages it in the browser. */
export const ledgerAllQuery = () =>
  queryOptions({
    queryKey: ["transactions", "all"],
    queryFn: ({ signal }) => api<TransactionAll>("/api/transactions/all", { signal }),
  });

export function useLedgerAll() {
  return useQuery({ ...ledgerAllQuery(), placeholderData: keepPreviousData });
}

export interface LedgerView {
  account_id?: number;
  kind?: string;
  /** Upper-case symbol, exact match. */
  symbol?: string;
  start?: string;
  end?: string;
  /** Case-insensitive substring over symbol, account, kind and description. */
  q?: string;
  hide_sweeps: boolean;
  sort: LedgerSortKey;
  order: "asc" | "desc";
}

export interface LedgerSummary {
  count: number;
  buy_count: number;
  sell_count: number;
  avg_trade_size_eur: number | null;
  avg_trade_size_usd: number | null;
}

export interface LedgerMonth {
  month: string;
  count: number;
  net_eur: number;
  net_usd: number;
  fx_incomplete: boolean;
}

const n = (v: string | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

/** Same rules as the server's ledger filter (symbol exact, text substring, sweeps hidden). */
export function filterLedger(rows: readonly TransactionOut[], v: LedgerView): TransactionOut[] {
  const needle = v.q?.trim().toLowerCase();
  return rows.filter((r) => {
    if (v.account_id !== undefined && r.account_id !== v.account_id) return false;
    if (v.kind && r.kind !== v.kind) return false;
    if (v.start && r.date < v.start) return false;
    if (v.end && r.date > v.end) return false;
    if (v.symbol && (r.symbol ?? "").toUpperCase() !== v.symbol) return false;
    if (v.hide_sweeps && r.is_settlement_leg) return false;
    if (needle) {
      const hay = [r.kind, r.description ?? "", r.symbol ?? "", r.account ?? ""];
      if (!hay.some((h) => h.toLowerCase().includes(needle))) return false;
    }
    return true;
  });
}

function sortValue(r: TransactionOut, key: LedgerSortKey): string | number | null {
  switch (key) {
    case "symbol":
      return r.symbol || null;
    case "account":
      return r.account;
    case "kind":
      return r.kind;
    case "quantity":
      return n(r.quantity);
    case "net":
      return n(r.net_native);
    default:
      return null;
  }
}

/** Chosen key (nulls last), then date + id as tiebreak, like the server. */
export function sortLedger(rows: readonly TransactionOut[], key: LedgerSortKey, order: "asc" | "desc"): TransactionOut[] {
  const dir = order === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key !== "date") {
      const x = sortValue(a, key);
      const y = sortValue(b, key);
      if (x === null && y !== null) return 1;
      if (y === null && x !== null) return -1;
      if (x !== null && y !== null && x !== y) return (x < y ? -1 : 1) * dir;
    }
    if (a.date !== b.date) return (a.date < b.date ? -1 : 1) * dir;
    return (a.id - b.id) * dir;
  });
}

export function summarizeLedger(rows: readonly TransactionOut[]): LedgerSummary {
  const trades = rows.filter((r) => r.kind === "buy" || r.kind === "sell");
  const avg = (pick: (r: TransactionOut) => string | null | undefined) => {
    const vals = trades.map((r) => n(pick(r))).filter((x): x is number => x !== null);
    return vals.length ? vals.reduce((s, x) => s + Math.abs(x), 0) / vals.length : null;
  };
  return {
    count: rows.length,
    buy_count: rows.filter((r) => r.kind === "buy").length,
    sell_count: rows.filter((r) => r.kind === "sell").length,
    avg_trade_size_eur: avg((r) => r.net_eur),
    avg_trade_size_usd: avg((r) => r.net_usd),
  };
}

/** Per-month count and net cash (trade-date FX legs from the server) over the given rows. */
export function monthTotals(rows: readonly TransactionOut[]): Map<string, LedgerMonth> {
  const out = new Map<string, LedgerMonth>();
  for (const r of rows) {
    const month = r.date.slice(0, 7);
    const m = out.get(month) ?? { month, count: 0, net_eur: 0, net_usd: 0, fx_incomplete: false };
    const eur = n(r.cash_eur);
    const usd = n(r.cash_usd);
    m.count += 1;
    m.net_eur += eur ?? 0;
    m.net_usd += usd ?? 0;
    if (eur === null || usd === null) m.fx_incomplete = true;
    out.set(month, m);
  }
  return out;
}
