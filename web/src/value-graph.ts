/**
 * Glue between the dashboard's computed model and the live 1D/1W curve builders
 * (docs/v3.0_live_web_companion_proposal.md §10.8). These are the **pure** pieces
 * that turn the already-computed {@link HoldingView}s into an
 * {@link IntradayAnchor}, and a built {@link CurvePoint} series into chart-ready
 * columns — both DOM-free, IndexedDB-free, and live-API-free so they unit-test in
 * isolation. The app shell ({@link ../app}) wires them to the real
 * {@link buildLiveSessionCurve}/{@link buildLiveWeekCurve} orchestration; the
 * Overview value chart ({@link ../ui}) consumes the columns.
 */

import { Decimal } from "./decimal-config";
import {
  buildIntradayAnchor,
  type AnchorHoldingInput,
  type IntradayAnchor,
} from "./intraday";
import type { CurvePoint } from "./timeseries";
import type { HoldingView } from "./compute";

/**
 * Build the live curve's whole-book {@link IntradayAnchor} from the computed
 * holdings plus the settled cash totals. Each market-priced holding with a live
 * value and a native price joins the intraday sleeve (keyed by its
 * `priceSymbol`); everything else folds into the flat base — exactly the split
 * {@link buildIntradayAnchor} performs. `baseFx` is the EUR→USD rate the EUR
 * values are expressed at.
 *
 * `graphFx` **freezes** the EUR view to a specific EUR→USD rate (the session
 * close, while the market is shut), so the 1D/1W market-day trajectory does not
 * slide around with overnight FX. When supplied it overrides `baseFx`, re-marks
 * each USD-booked holding's EUR value at that rate (`valueUsd / graphFx`, the USD
 * leg staying FX-free), and re-derives the EUR cash sleeve's USD twin from it.
 * Omitted/`null`, the holdings keep their live-FX EUR values exactly as before.
 */
export function buildModelAnchor(
  holdings: HoldingView[],
  cashValueEur: Decimal,
  cashValueUsd: Decimal,
  baseFx: Decimal | null,
  options: { navInSleeve?: boolean; graphFx?: Decimal | null } = {},
): IntradayAnchor {
  const graphFx = options.graphFx ?? null;
  const freeze = graphFx !== null && graphFx.greaterThan(0);
  const effectiveFx = freeze ? graphFx : baseFx;
  const inputs: AnchorHoldingInput[] = holdings.map((h) => ({
    // The bars are keyed by the Twelve Data ticker (`price_symbol`); fall back to
    // the display symbol only for fixtures that predate the `priceSymbol` field.
    priceSymbol: h.priceSymbol ?? h.symbol,
    nativeCurrency: h.nativeCurrency,
    priceType: h.priceType,
    shares: h.shares,
    priceNative: h.priceNative,
    valueEur: freeze ? frozenValueEur(h, graphFx) : h.valueEur,
    valueUsd: h.valueUsd,
  }));
  // The EUR cash sleeve's USD twin must agree with the rate the curve is anchored
  // at, or the flat base would carry a stale FX floor under the frozen sleeve.
  const cashUsd = freeze ? cashValueEur.times(graphFx) : cashValueUsd;
  return buildIntradayAnchor(inputs, cashValueEur, cashUsd, effectiveFx, options);
}

/**
 * A USD-booked holding's EUR value re-marked at the frozen `graphFx` (the USD leg
 * is FX-free, so `valueEur = valueUsd / graphFx`). EUR-native holdings and rows
 * with no USD twin keep their existing EUR value — FX does not apply to them.
 */
function frozenValueEur(h: HoldingView, graphFx: Decimal): Decimal | null {
  const isUsd = h.nativeCurrency.toUpperCase() === "USD";
  if (!isUsd || h.valueUsd === null) return h.valueEur;
  return h.valueUsd.dividedBy(graphFx);
}

/** Chart-ready columns for a live curve: aligned dates + per-currency values. */
export interface CurveColumns {
  /** ISO instant per point (`t`), index-aligned with the value columns. */
  dates: string[];
  /** EUR whole-book value at each point. */
  eur: Decimal[];
  /** USD whole-book value at each point (FX-free; USD is booked). */
  usd: Decimal[];
}

/**
 * Flatten a built {@link CurvePoint} series into index-aligned columns the chart
 * layer can denominate. The x-key is each point's instant as an ISO string so the
 * shared line chart (which parses `YYYY-MM-DD…` labels) can plot and date it.
 */
export function curveColumns(points: CurvePoint[]): CurveColumns {
  const dates: string[] = [];
  const eur: Decimal[] = [];
  const usd: Decimal[] = [];
  for (const p of points) {
    dates.push(new Date(p.t).toISOString());
    eur.push(p.valueEur);
    usd.push(p.valueUsd);
  }
  return { dates, eur, usd };
}
