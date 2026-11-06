import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { lastSessionLabel } from "../Freshness";
import type { ReportingCurrency } from "../../lib/prefs";
import { overviewQuery, toNum } from "../../lib/queries/portfolio";
import type { ShellSummary } from "../../lib/shell";
import { useTimeZone } from "../../lib/timezone";

/**
 * The portfolio value and day move for the top bar, on every view. Shares the
 * Overview query's cache (one entry for both currencies): cached data shows at
 * once, and a fetch of its own waits `delayMs` so it never competes with the
 * page's first load. The server computes every figure.
 *
 * While an ETF twin stands in for a fund whose NAV has not posted, the bar
 * carries the estimated book, matching the Overview headline: one portfolio
 * figure in the app, marked "≈" rather than quietly differing from the hero.
 */
export function usePortfolioSummary(currency: ReportingCurrency, delayMs = 1200): ShellSummary | undefined {
  const timeZone = useTimeZone();
  const [armed, setArmed] = useState(delayMs <= 0);
  useEffect(() => {
    if (armed) return undefined;
    const t = setTimeout(() => setArmed(true), delayMs);
    return () => clearTimeout(t);
  }, [armed, delayMs]);
  const kpis = useQuery({ ...overviewQuery(currency), enabled: armed }).data?.kpis;
  if (!kpis) return undefined;
  const est = kpis.estimate ?? null;
  return {
    value: toNum(est ? est.total_value : kpis.total_value),
    currency,
    pct: toNum(est ? est.daily_growth_pct : kpis.daily_growth_pct),
    move: toNum(est ? est.daily_move : kpis.daily_move),
    estimated: est !== null,
    dayLabel: lastSessionLabel(kpis.daily_growth_as_of, { timeZone }) ?? "today",
  };
}
