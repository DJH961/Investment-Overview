/**
 * Transactions view-model — the browser-side shape of the desktop's raw ledger
 * read-model (`readmodels/transactions.py`), ready for the Transactions tab.
 *
 * The export carries the ledger only when the desktop publishes with
 * `include_transactions=True`; when it is absent we still return a well-formed
 * (empty) view with `available = false` so the UI can show a clear "not included
 * in this export" state and the Settings toggle can offer to hide the tab.
 *
 * Each `net*` figure is a **signed cash flow** (money in is positive, out is
 * negative) already converted on the row's own trade date, so the EUR and USD
 * legs reflect the historical rate rather than today's spot — never re-derive one
 * leg from the other here.
 */
import { Decimal } from "./decimal-config";
import { MONEY_MARKET_SYMBOLS, isMoneyMarketHolding } from "./money-market";
import type { ExportHolding, ExportTransactionRecord, ExportTransactions, MobileExport } from "./types";

/** One ledger row, parsed into Decimals for display. */
export interface TxnRow {
  id: number | null;
  /** Trade date, ISO `YYYY-MM-DD`. */
  date: string;
  account: string;
  /** Ledger kind slug (`buy`, `sell`, `dividend`, …). */
  kind: string;
  /** Instrument symbol, or "" for a pure cash movement. */
  symbol: string;
  /** Signed share quantity (negative for sells); null for cash-only rows. */
  quantity: Decimal | null;
  priceNative: Decimal | null;
  feesNative: Decimal | null;
  netNative: Decimal | null;
  /** Signed net cash flow in EUR (trade-date FX). */
  netEur: Decimal | null;
  /** Signed net cash flow in USD (trade-date FX). */
  netUsd: Decimal | null;
  source: string | null;
}

/** The whole Transactions tab model. */
export interface TransactionsView {
  /**
   * Whether the export actually carried a transactions block. False when the
   * desktop published without it — the tab then renders a "not included" state
   * rather than an empty list, and the user can hide the tab from Settings.
   */
  available: boolean;
  /** Newest-first ledger rows (empty when {@link available} is false). */
  rows: TxnRow[];
  /** Distinct ledger kinds present, sorted, for the kind filter dropdown. */
  kinds: string[];
}

/** Parse a nullable decimal-string into a Decimal, tolerating bad input. */
function dec(value: string | null | undefined): Decimal | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    const d = new Decimal(value);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

function toRow(r: ExportTransactionRecord, mmSymbols: ReadonlySet<string>): TxnRow {
  const symbol = typeof r.symbol === "string" ? r.symbol : "";
  let kind = typeof r.kind === "string" ? r.kind : "";
  let quantity = dec(r.quantity);
  let priceNative = dec(r.price_native);

  // Money-market settlement funds (VMFXX, SPAXX …) hold a constant $1.00 NAV by
  // design, so a *reinvested* distribution's "shares" are merely the dollar
  // amount and its "price" is always 1 — both meaningless noise. Log these as a
  // plain dividend with no share/price detail, matching how the desktop treats
  // them (the income is recognised, the par-value mechanics are hidden).
  if (kind === "dividend_reinvest" && symbol !== "" && mmSymbols.has(symbol.trim().toUpperCase())) {
    kind = "dividend";
    quantity = null;
    priceNative = null;
  }

  return {
    id: typeof r.id === "number" ? r.id : null,
    date: typeof r.date === "string" ? r.date : "",
    account: typeof r.account === "string" ? r.account : "",
    kind,
    symbol,
    quantity,
    priceNative,
    feesNative: dec(r.fees_native),
    netNative: dec(r.net_native),
    netEur: dec(r.net_eur),
    netUsd: dec(r.net_usd),
    source: typeof r.source === "string" ? r.source : null,
  };
}

/**
 * The set of money-market / settlement-fund symbols this export knows about:
 * the desktop's well-known ticker list plus any holding the export explicitly
 * flags (`is_money_market`) or that matches the ticker/name heuristic. Used to
 * normalise reinvested money-market distributions into plain dividends.
 */
function moneyMarketSymbolSet(data: MobileExport): ReadonlySet<string> {
  const set = new Set<string>(MONEY_MARKET_SYMBOLS);
  const holdings: ExportHolding[] = Array.isArray(data.holdings) ? data.holdings : [];
  for (const holding of holdings) {
    if (!isMoneyMarketHolding(holding)) continue;
    const sym = (holding.price_symbol || holding.symbol || "").trim().toUpperCase();
    if (sym) set.add(sym);
  }
  return set;
}

/** Narrow the loosely-typed export block to a rows array, or null when absent. */
function rawRows(block: ExportTransactions | undefined): ExportTransactionRecord[] | null {
  if (!block || typeof block !== "object") return null;
  const rows = (block as ExportTransactions).rows;
  return Array.isArray(rows) ? rows : null;
}

/**
 * Build the Transactions view from a decoded export. Returns an unavailable
 * (empty) view when the export omitted the ledger, so callers never have to
 * special-case a missing block.
 */
export function buildTransactions(data: MobileExport): TransactionsView {
  const raw = rawRows(data.transactions);
  if (raw === null) {
    return { available: false, rows: [], kinds: [] };
  }
  const mmSymbols = moneyMarketSymbolSet(data);
  const rows = raw.map((r) => toRow(r, mmSymbols));
  const kinds = [...new Set(rows.map((r) => r.kind).filter((k) => k !== ""))].sort();
  return { available: true, rows, kinds };
}
