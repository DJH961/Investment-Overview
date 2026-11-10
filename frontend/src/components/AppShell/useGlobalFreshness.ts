import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { describeFreshness, useLiveGrace, type FreshnessView } from "../Freshness";
import { useLiveStatus } from "../../lib/live";
import type { ReportingCurrency } from "../../lib/prefs";
import { overviewQuery } from "../../lib/queries/portfolio";
import { useRefreshState } from "../../lib/refresh";
import { useTimeZone } from "../../lib/timezone";

/**
 * The top bar's price-freshness chip, the same on every view.
 *
 * Every page used to publish its own label ("Prices as of …", "As of 5 Nov",
 * "Import" …), so the bar said something different on each screen. Now the shell
 * builds the chip once from the Overview payload's server-computed `freshness`
 * block (the cache the top-bar summary already shares), plus the live stream's
 * latest tick. Returns `undefined` until that data is there, so the page's own
 * status (loading / offline) shows meanwhile.
 */
export function useGlobalFreshness(currency: ReportingCurrency, delayMs = 1200): FreshnessView | undefined {
  const timeZone = useTimeZone();
  const live = useLiveGrace(useLiveStatus());
  const refresh = useRefreshState();
  const [armed, setArmed] = useState(delayMs <= 0);
  useEffect(() => {
    if (armed) return undefined;
    const t = setTimeout(() => setArmed(true), delayMs);
    return () => clearTimeout(t);
  }, [armed, delayMs]);
  const data = useQuery({ ...overviewQuery(currency), enabled: armed }).data;
  if (!data?.freshness) return undefined;
  return describeFreshness(data.freshness, {
    live,
    refresh,
    timeZone,
    sessionDate: data.kpis?.daily_growth_as_of,
  });
}
