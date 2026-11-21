import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
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

/** The neutral title (index.html). Never read back from `document.title`: that may hold figures. */
export const BASE_TITLE = "Investment Overview";

/**
 * Keeps `document.title` current from the cached overview while the app is visible and focused.
 * When the user switches away, the neutral title protects the portfolio figures from showing
 * in the browser's background tab. The neutral title is a constant on purpose: capturing
 * `document.title` at mount could capture figures whenever the shell remounted.
 */
export function useTabTitle(currency: ReportingCurrency): void {
  const { hide } = useHideAmounts();
  // Reads the shared cache only (no request of its own); updates when a tick patches it.
  const kpis = useQuery({ ...overviewQuery(currency), enabled: false }).data?.kpis;
  useEffect(() => {
    // `hasFocus` catches switching to another window as well as another browser tab. Keep a
    // local focus bit too: blur must hide the figures immediately, even before the browser's
    // focus state has caught up with the event.
    let focused = document.hasFocus();
    const syncTitle = () => {
      const privateView = document.visibilityState === "visible" && focused && document.hasFocus();
      document.title = privateView ? tabTitle(kpis, currency, hide, BASE_TITLE) : BASE_TITLE;
    };
    const onFocus = () => {
      focused = true;
      syncTitle();
    };
    const onBlur = () => {
      focused = false;
      syncTitle();
    };

    document.addEventListener("visibilitychange", syncTitle);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    syncTitle();

    return () => {
      document.removeEventListener("visibilitychange", syncTitle);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.title = BASE_TITLE;
    };
  }, [kpis, currency, hide]);
}
