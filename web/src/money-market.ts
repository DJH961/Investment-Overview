/**
 * Money-market / settlement fund detection for the live-data layer.
 *
 * Brokerage settlement / core funds (Vanguard `VMFXX`, Fidelity `SPAXX`, …)
 * hold uninvested cash and maintain a constant $1.00 NAV by design, so their
 * price never moves. The desktop keeps them in the broad `mutual_fund` asset
 * class (see `domain/money_market.py` — `MONEY_MARKET_ASSET_CLASS`), which means
 * `asset_class` alone cannot tell them apart from ordinary, genuinely
 * fetchable mutual funds. Requesting a quote for one only ever returns the same
 * dollar and wastes a free-tier credit, so they must be excluded from live
 * fetching.
 *
 * The export now carries an explicit `is_money_market` flag (the desktop is the
 * source of truth via `domain.money_market.is_money_market`); this module
 * mirrors the desktop's ticker/name heuristic so already-published blobs that
 * predate the flag are still handled correctly.
 */

import type { ExportHolding } from "./types";

/**
 * Well-known settlement / core money-market fund tickers. Mirrors
 * `domain/money_market.py` (`MONEY_MARKET_SYMBOLS`) so the browser can identify
 * them even from an older export that lacks the explicit `is_money_market` flag.
 */
export const MONEY_MARKET_SYMBOLS: ReadonlySet<string> = new Set([
  // Vanguard
  "VMFXX",
  "VMRXX",
  "VUSXX",
  // Fidelity
  "SPAXX",
  "FDRXX",
  "SPRXX",
  "FZFXX",
  "FDLXX",
  "FCASH",
  // Schwab
  "SWVXX",
  "SNVXX",
  "SNSXX",
]);

/**
 * Whether a holding is a money-market / settlement fund and so must never be
 * sent to the price provider. Prefers the export's explicit `is_money_market`
 * flag; falls back to the desktop's ticker/name heuristic for older blobs.
 */
export function isMoneyMarketHolding(holding: ExportHolding): boolean {
  if (holding.is_money_market === true) return true;
  const symbol = (holding.price_symbol || holding.symbol || "").trim().toUpperCase();
  if (symbol && MONEY_MARKET_SYMBOLS.has(symbol)) return true;
  const name = holding.name ?? "";
  return name.toLowerCase().includes("money market");
}
