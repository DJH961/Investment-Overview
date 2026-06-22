/**
 * Display-currency preference (EUR ↔ USD), persisted per device.
 *
 * EUR and USD are equal, first-class display currencies. Internally the compute
 * layer denominates figures in EUR purely as a common FX-pivot (see compute.ts)
 * — that is an implementation detail, NOT a claim that EUR is the base/primary
 * currency. USD is the native booked currency for almost every transaction and
 * is the figure that must stay exact. The user can flip the whole dashboard
 * between the two with one tap; this module holds the chosen currency plus the
 * live EUR→USD rate so the formatting helpers can convert the pivot amounts on
 * the fly without re-running the compute pipeline. Like the theme choice, this
 * is a non-secret, device-local preference.
 */

import { Decimal } from "./decimal-config";

export type DisplayCurrency = "EUR" | "USD";

const STORAGE_KEY = "iv.web.currency";
const SUPPORTED: DisplayCurrency[] = ["EUR", "USD"];

let current: DisplayCurrency = loadCurrency();
/** Units of USD per one EUR. Updated from live FX (or the export meta). */
let eurUsdRate: Decimal | null = null;

function isDisplayCurrency(value: string): value is DisplayCurrency {
  return (SUPPORTED as string[]).includes(value);
}

function loadCurrency(): DisplayCurrency {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && isDisplayCurrency(stored)) return stored;
  } catch {
    /* localStorage may be unavailable (private mode); fall back to EUR. */
  }
  return "EUR";
}

function saveCurrency(value: DisplayCurrency): void {
  try {
    if (value === "EUR") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* Preference just won't persist; the in-memory choice still applies. */
  }
}

/** The active display currency. */
export function getDisplayCurrency(): DisplayCurrency {
  return current;
}

/** Set (and persist) the active display currency. */
export function setDisplayCurrency(value: DisplayCurrency): void {
  current = value;
  saveCurrency(value);
}

/** Flip EUR ↔ USD, returning the new choice. */
export function toggleDisplayCurrency(): DisplayCurrency {
  setDisplayCurrency(current === "EUR" ? "USD" : "EUR");
  return current;
}

/**
 * Record the EUR→USD rate (units of USD per 1 EUR). A non-positive or missing
 * rate is ignored so the toggle degrades gracefully to showing EUR.
 */
export function setEurUsdRate(rate: Decimal | null | undefined): void {
  eurUsdRate = rate && rate.greaterThan(0) ? rate : null;
}

/** Whether a USD conversion is currently possible (a positive rate is known). */
export function canConvertToUsd(): boolean {
  return eurUsdRate !== null;
}

/**
 * Pick the figure for the active display currency for a value that is *already*
 * denominated in its currency and must NOT be FX-rescaled — chiefly growth
 * percentages and rates (total gain %, MTD/YTD growth, XIRR), where the EUR and
 * USD figures genuinely differ because of FX drift between the cash-flow dates
 * and now (mirroring the desktop's per-currency KPIs). When USD is selected and
 * a USD figure is available, it is used verbatim; otherwise the EUR figure is
 * used (USD display with no USD figure falls back to EUR rather than blanking).
 */
export function pickByCurrency(
  valueEur: Decimal | null,
  valueUsd: Decimal | null,
): Decimal | null {
  if (current === "USD" && eurUsdRate !== null && valueUsd !== null) return valueUsd;
  return valueEur;
}

/**
 * Convert an EUR amount into the active display currency, returning both the
 * converted value and the ISO currency code to format it with. When USD is
 * selected but no rate is known, the value stays in EUR.
 */
export function convertFromEur(valueEur: Decimal): { value: Decimal; code: DisplayCurrency } {
  if (current === "USD" && eurUsdRate !== null) {
    return { value: valueEur.times(eurUsdRate), code: "USD" };
  }
  return { value: valueEur, code: "EUR" };
}

/**
 * Pick the right figure for the active display currency for an amount that is a
 * sum of *historical* flows or a point-in-time valuation (e.g. contributions,
 * period flows). Such figures must not be rescaled by today's spot rate, so
 * when USD is selected we use the pre-computed `valueUsd` (converted at the FX
 * rate in force on each underlying date by the desktop). Only when USD is
 * selected but no `valueUsd` is available do we fall back to spot-converting
 * the EUR figure — better an approximation than a blank. EUR display always
 * uses `valueEur`.
 */
export function displayAmount(
  valueEur: Decimal | null,
  valueUsd: Decimal | null,
): { value: Decimal; code: DisplayCurrency } | null {
  if (current === "USD" && eurUsdRate !== null) {
    if (valueUsd !== null) return { value: valueUsd, code: "USD" };
    if (valueEur !== null) return { value: valueEur.times(eurUsdRate), code: "USD" };
    return null;
  }
  return valueEur === null ? null : { value: valueEur, code: "EUR" };
}
