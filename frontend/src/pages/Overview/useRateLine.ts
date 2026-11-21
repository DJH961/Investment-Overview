import { useMemo } from "react";
import type { LifetimeRateLine } from "../../components/CurrencyLifetime";
import type { ReportingCurrency } from "../../lib/prefs";
import { useRateHistory, type RateTrendDto } from "../../lib/queries/currencyRate";
import { toNum } from "../../lib/queries/portfolio";

/**
 * The Overview's quiet currency hints (v7.2): the server's 1-year rate history gives the
 * dollar trend (chip on both currency cards) and the line for the lifetime card's
 * sparkline. The quote follows the top switch like the Today card's pair: one dollar in
 * euros in the EUR view, EUR/USD in the USD view. Values are the server's; nothing is
 * computed here but picking the side of the quote.
 */
export function useRateLine(currency: ReportingCurrency): { trend: RateTrendDto | null; line: LifetimeRateLine | null } {
  const q = useRateHistory("1y");
  const data = q.data;
  return useMemo(() => {
    if (!data) return { trend: null, line: null };
    const dollar = currency === "EUR";
    const values = (data.points ?? [])
      .map((p) => toNum(dollar ? p.inverse : p.rate))
      .filter((v): v is number => v !== null);
    const avg = data.avg_rate ? toNum(dollar ? data.avg_rate.inverse : data.avg_rate.rate) : null;
    const trend = data.trend ?? null;
    return {
      trend,
      line: values.length > 1 ? { values, avg, quote: dollar ? "1 $ in €" : "EUR/USD", trend } : null,
    };
  }, [data, currency]);
}
