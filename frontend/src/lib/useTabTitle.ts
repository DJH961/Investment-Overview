import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { formatMoney, formatPercent } from "./format";
import { useHideAmounts } from "./hideAmounts";
import type { ReportingCurrency } from "./prefs";
import { overviewQuery, toNum, type OverviewDto } from "./queries/portfolio";

/**
 * The browser tab title: `≈€123.4k ▲0.42%`. The "≈" only shows while a fund is valued from
 * its ETF twin (the estimated book). Presentation only: both figures come from the cached
 * overview, nothing is computed. Neutral (`fallback`) when amounts are hidden or no data.
 */
export function tabTitle(
  kpis: OverviewDto["kpis"] | undefined,
  currency: string,
  hide: boolean,
  fallback: string,
): string {
  if (hide || !kpis) return fallback;
  const est = kpis.estimate ?? null;
  const total = toNum(est ? est.total_value : kpis.total_value);
  if (total === null) return fallback;
  const pct = toNum(est ? est.daily_growth_pct : kpis.daily_growth_pct);
  const money = formatMoney(total, currency, { compact: true }).replace(/K\b/, "k");
  const head = `${est ? "≈" : ""}${money}`;
  if (pct === null) return head;
  const arrow = pct > 0 ? "▲" : pct < 0 ? "▼" : "";
  return `${head} ${arrow}${formatPercent(Math.abs(pct))}`;
}

/** Keeps `document.title` current from the cached overview; restores the original on unmount. */
export function useTabTitle(currency: ReportingCurrency): void {
  const { hide } = useHideAmounts();
  // Reads the shared cache only (no request of its own); updates when a tick patches it.
  const kpis = useQuery({ ...overviewQuery(currency), enabled: false }).data?.kpis;
  const original = useRef<string | null>(null);
  useEffect(() => {
    original.current = document.title;
    return () => {
      if (original.current !== null) document.title = original.current;
    };
  }, []);
  useEffect(() => {
    document.title = tabTitle(kpis, currency, hide, original.current ?? "Investment Overview");
  }, [kpis, currency, hide]);
}
