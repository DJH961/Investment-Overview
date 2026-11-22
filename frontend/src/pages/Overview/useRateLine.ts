import { useMemo } from "react";
import type { LifetimeRateLine } from "../../components/CurrencyLifetime";
import { useRateHistory, type RateTrendDto } from "../../lib/queries/currencyRate";
import { toNum } from "../../lib/queries/portfolio";

/**
 * The Overview's quiet currency hints (v7.2): the server's 1-year rate history gives the
 * dollar trend (chip on both currency cards) and the line for the lifetime card's
 * sparkline. The sparkline sits in the card's "EUR/USD now" tile, under that rate and
 * your average in the same quote, so it is drawn in EUR/USD in both views (a second
 * quote right beside the first would read as a contradiction). Values are the server's.
 */
export function useRateLine(): { trend: RateTrendDto | null; line: LifetimeRateLine | null } {
  const q = useRateHistory("1y");
  const data = q.data;
  return useMemo(() => {
    if (!data) return { trend: null, line: null };
    const values = (data.points ?? []).map((p) => toNum(p.rate)).filter((v): v is number => v !== null);
    const avg = data.avg_rate ? toNum(data.avg_rate.rate) : null;
    const trend = data.trend ?? null;
    return {
      trend,
      line: values.length > 1 ? { values, avg, quote: "EUR/USD", trend } : null,
    };
  }, [data]);
}
