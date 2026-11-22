import { createContext, useCallback, useContext } from "react";
import { useSearchParams } from "react-router";
import { RATE_RANGES, type RateRange } from "../../lib/queries/currencyRate";
import { usePersistentState } from "../../lib/usePersistentState";

/**
 * The Currency page's one range (v7.2). The picker sits on the rate chart at the top;
 * the rate chart, Impact and The dollar all describe this window. What if has none.
 * The URL (`?range=`) wins, so a link or a sub-page keeps the window; otherwise the
 * last choice on this device.
 */
export type CurrencyRange = RateRange;

export const isCurrencyRange = (v: unknown): v is CurrencyRange => RATE_RANGES.includes(v as RateRange);

export interface CurrencyRangeState {
  range: CurrencyRange;
  setRange: (range: CurrencyRange) => void;
}

export const CurrencyRangeContext = createContext<CurrencyRangeState | null>(null);

/** Owner of the range state: the Currency page (and its sub-pages) call this once. */
export function useCurrencyRangeState(): CurrencyRangeState {
  const [stored, setStored] = usePersistentState<CurrencyRange>("currency.rate.range", "1y", isCurrencyRange);
  const [params, setParams] = useSearchParams();
  const asked = params.get("range");
  const range = isCurrencyRange(asked) ? asked : stored;
  const setRange = useCallback(
    (next: CurrencyRange) => {
      setStored(next);
      setParams(
        (p) => {
          const out = new URLSearchParams(p);
          out.set("range", next);
          return out;
        },
        { replace: true, preventScrollReset: true },
      );
    },
    [setStored, setParams],
  );
  return { range, setRange };
}

/** The page's range, for a section or sub-page rendered inside the Currency page. */
export function useCurrencyRange(): CurrencyRangeState {
  const ctx = useContext(CurrencyRangeContext);
  if (!ctx) throw new Error("useCurrencyRange must be used inside the Currency page");
  return ctx;
}
