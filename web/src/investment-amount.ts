/**
 * The owner's **regular investment amount** — the euros they send to the US on a
 * recurring basis to keep investing — held in memory for the render layer.
 *
 * The canonical value lives in {@link AppConfig.investmentAmountEur} (persisted
 * per device and carried in the portable config packet). The app shell mirrors
 * it here whenever it renders so display helpers — chiefly the USD
 * investing-power panel in the currency box — can read it without threading the
 * whole config through every render call, exactly like the EUR→USD rate in
 * `currency.ts`.
 */

import { Decimal } from "./decimal-config";

/** Default regular investment amount in EUR when nothing is configured. */
export const DEFAULT_INVESTMENT_AMOUNT_EUR = 100;

let amountEur: Decimal = new Decimal(DEFAULT_INVESTMENT_AMOUNT_EUR);

/**
 * Record the configured regular investment amount (EUR). A non-positive or
 * missing value falls back to the default so the investing-power panel always
 * has a sensible notional to work from.
 */
export function setInvestmentAmountEur(value: number | Decimal | null | undefined): void {
  if (value === null || value === undefined) {
    amountEur = new Decimal(DEFAULT_INVESTMENT_AMOUNT_EUR);
    return;
  }
  const next = value instanceof Decimal ? value : new Decimal(value);
  amountEur = next.isFinite() && next.greaterThan(0) ? next : new Decimal(DEFAULT_INVESTMENT_AMOUNT_EUR);
}

/** The active regular investment amount in EUR (always a positive Decimal). */
export function getInvestmentAmountEur(): Decimal {
  return amountEur;
}
