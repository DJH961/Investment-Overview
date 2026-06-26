/**
 * Window growth for the "Value over time" headline.
 *
 * The little percentage beside the value chart must read the *same* window the
 * graph is drawing, not a fixed "today" figure:
 *
 *   - **1D** is handled by the caller (it reuses the live close-to-now move, so
 *     the headline is measured from the previous session's CLOSE exactly like
 *     the intraday graph's dashed reference line).
 *   - **1W** uses a {@link modifiedDietzGrowth | simple} period growth over the
 *     window — short enough that cash-flow timing barely matters.
 *   - **1M / 1Y / All** (anything beyond a week) use an **XIRR-based scaled
 *     growth**: solve the window's money-weighted rate from its cash flows and
 *     compound it back over the window length. A dollar-cost-averaged book whose
 *     weekly deposits make a naive value-over-value ratio look wild then reads as
 *     a stable, money-weighted period return.
 *
 * The function operates on the curve already denominated in the active display
 * currency, so the headline honours the EUR/USD toggle just like the graph.
 */

import Decimal from "decimal.js";

import {
  xirr,
  totalGrowthPctCompounded,
  yearsBetween,
  type Cashflow,
} from "./returns";

/** How to measure a window's growth. */
export type GrowthMode = "simple" | "xirr";

/** One curve point in the active display currency. */
export interface WindowPoint {
  /** ISO `YYYY-MM-DD`. */
  date: string;
  /** Portfolio value at this point (display currency), or null when unknown. */
  value: Decimal | null;
  /** Cumulative external contributions up to this point (display currency). */
  contributions: Decimal | null;
}

/**
 * Modified Dietz period return: `(close - open - flow) / (open + flow/2)`.
 * Mirrors {@link ../phase4!modifiedDietzGrowth} (kept local so this leaf module
 * has no UI dependency). Returns null on a non-positive denominator.
 */
function modifiedDietzGrowth(
  opening: Decimal,
  closing: Decimal,
  flow: Decimal,
): Decimal | null {
  const denom = opening.plus(flow.dividedBy(2));
  if (denom.lessThanOrEqualTo(0)) return null;
  return closing.minus(opening).minus(flow).dividedBy(denom);
}

/**
 * Growth over the supplied window of (already display-currency) curve points.
 *
 * `simple` returns a Modified-Dietz period return; `xirr` solves the window's
 * money-weighted rate (opening value as the initial investment, each cumulative
 * contribution step as a dated deposit, the closing value as the terminal flow)
 * and compounds it over the window length. The `xirr` path falls back to the
 * simple growth when the solver can't converge, so the headline always has a
 * number when the simple form does. Returns null when the window is too short
 * or has no usable opening value.
 */
export function windowGrowthPct(points: WindowPoint[], mode: GrowthMode): Decimal | null {
  const valued = points.filter((p): p is WindowPoint & { value: Decimal } => p.value !== null);
  if (valued.length < 2) return null;

  const opening = valued[0].value;
  const closing = valued[valued.length - 1].value;
  const firstContrib = valued[0].contributions;
  const lastContrib = valued[valued.length - 1].contributions;
  // Net external flow across the window from the cumulative-contributions track.
  const flow =
    firstContrib !== null && lastContrib !== null
      ? lastContrib.minus(firstContrib)
      : new Decimal(0);

  const simple = modifiedDietzGrowth(opening, closing, flow);
  if (mode === "simple") return simple;

  // XIRR-scaled: the window's money-weighted return compounded over its length.
  const openDate = valued[0].date;
  const endDate = valued[valued.length - 1].date;
  if (openDate === endDate || opening.lessThanOrEqualTo(0)) return simple;

  const flows: Cashflow[] = [{ date: openDate, amount: opening.negated() }];
  let prevContrib = firstContrib;
  for (let i = 1; i < valued.length; i += 1) {
    const c = valued[i].contributions;
    if (c !== null && prevContrib !== null) {
      const delta = c.minus(prevContrib);
      // Deposits are negative in the XIRR sign convention (money paid in).
      if (!delta.isZero()) flows.push({ date: valued[i].date, amount: delta.negated() });
      prevContrib = c;
    }
  }

  const rate = xirr(flows, endDate, { terminalValue: closing });
  const scaled = totalGrowthPctCompounded(rate, yearsBetween(openDate, endDate));
  return scaled ?? simple;
}
