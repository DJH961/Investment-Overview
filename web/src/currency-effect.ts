/**
 * How the EUR ↔ USD exchange rate has affected a EUR-based investor — the
 * browser mirror of the desktop `domain/currency_effect.py`.
 *
 * The owner funds the portfolio in **EUR**, buys USD-denominated assets, but
 * still lives in the euro zone, so the money will likely be converted *back* to
 * EUR one day. Between paying in and cashing out the EUR/USD rate moves, and
 * that move is a real gain or loss on top of the assets' own performance. This
 * module isolates that currency effect as pure {@link Decimal} math (no DOM) so
 * it can be unit-tested and rendered on the Risk tab.
 *
 * All rates are quoted **USD per EUR** (the conventional EUR/USD quote): a
 * *lower* rate means the euro has weakened, which is *favourable* for a euro
 * investor holding dollar assets (each dollar buys back more euros).
 */

import { Decimal } from "./decimal-config";

/**
 * The EUR/USD currency effect on a portfolio. Every field is `null` when it
 * cannot be computed (no USD value, no contributions, or a non-positive rate),
 * so the UI degrades to "—" rather than showing a misleading zero.
 */
export interface CurrencyEffect {
  /** Weighted average rate you invested at (USD per EUR), or null. */
  avgInvestRate: Decimal | null;
  /** Current spot rate (USD per EUR), or null. */
  currentRate: Decimal | null;
  /**
   * Fractional change of the current rate vs the average invest rate
   * (`current / avg − 1`). Negative ⇒ the euro weakened (good for you).
   */
  rateChangePct: Decimal | null;
  /**
   * Slice of your total EUR return attributable to FX, in fractional points
   * (`growthEur − growthUsd`). Positive ⇒ currency was a tailwind.
   */
  currencyEffectPp: Decimal | null;
  /**
   * EUR gained (+) or lost (−) purely from the rate move versus having invested
   * at the average rate — the FX P&L baked into your EUR value.
   */
  fxPnlEur: Decimal | null;
  /** What you'd receive converting the whole portfolio back to EUR now. */
  repatriationValueEur: Decimal | null;
  /** The rate at which the FX effect nets to zero (== the average invest rate). */
  breakevenRate: Decimal | null;
}

export interface CurrencyEffectInputs {
  /** Net external contributions in EUR (deposits minus withdrawals). */
  contributionsEur: Decimal | null;
  /** The same flows valued in USD at each trade date. */
  contributionsUsd: Decimal | null;
  /** Current portfolio value in EUR (today's spot). */
  valueEur: Decimal | null;
  /** Current portfolio value in USD (today's spot), or null. */
  valueUsd: Decimal | null;
  /** Compounded total growth measured in EUR (fraction). */
  growthEur: Decimal | null;
  /** Compounded total growth measured in USD (fraction). */
  growthUsd: Decimal | null;
}

/** Derive the EUR/USD {@link CurrencyEffect} from portfolio aggregates. */
export function computeCurrencyEffect(inputs: CurrencyEffectInputs): CurrencyEffect {
  const { contributionsEur, contributionsUsd, valueEur, valueUsd, growthEur, growthUsd } = inputs;

  let avgRate: Decimal | null = null;
  if (
    contributionsEur !== null &&
    contributionsUsd !== null &&
    contributionsEur.greaterThan(0) &&
    contributionsUsd.greaterThan(0)
  ) {
    avgRate = contributionsUsd.dividedBy(contributionsEur);
  }

  let currentRate: Decimal | null = null;
  if (valueEur !== null && valueUsd !== null && valueEur.greaterThan(0) && valueUsd.greaterThan(0)) {
    currentRate = valueUsd.dividedBy(valueEur);
  }

  let rateChangePct: Decimal | null = null;
  if (avgRate !== null && currentRate !== null && !avgRate.isZero()) {
    rateChangePct = currentRate.dividedBy(avgRate).minus(1);
  }

  let currencyEffectPp: Decimal | null = null;
  if (growthEur !== null && growthUsd !== null) {
    currencyEffectPp = growthEur.minus(growthUsd);
  }

  let fxPnlEur: Decimal | null = null;
  if (valueUsd !== null && valueEur !== null && avgRate !== null && !avgRate.isZero()) {
    // EUR value today minus the EUR you'd hold had the rate stayed at the
    // average you invested at (same USD assets, valued back at avgRate).
    fxPnlEur = valueEur.minus(valueUsd.dividedBy(avgRate));
  }

  return {
    avgInvestRate: avgRate,
    currentRate,
    rateChangePct,
    currencyEffectPp,
    fxPnlEur,
    repatriationValueEur: valueEur !== null && valueEur.greaterThan(0) ? valueEur : null,
    breakevenRate: avgRate,
  };
}
