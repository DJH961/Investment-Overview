import { Link } from "react-router";
import { Money } from "../../components/Money";
import type { StatItem } from "../../components/StatStrip";
import { formatNumber } from "../../lib/format";
import { useFxCosts, type FxCostsDto, type FxCostSummaryDto } from "../../lib/queries/fxCosts";
import { toNum } from "../../lib/queries/portfolio";
import type { FxConversion } from "../../lib/queries/manage";
import { offPctText, providerLabel } from "./matching";

/**
 * What converting cost you, kept light on this page (7.3): two strip tiles, the average
 * all-in rate on the fold headers and the cost in each row's sub line. Every figure is the
 * server's (`/api/fx-conversions/costs`); the deep dive lives on the Currency page.
 */
export function useCostsAll(): FxCostsDto | undefined {
  return useFxCosts("EUR", "all").data;
}

/** The extra stat-strip tiles: total cost and the average distance from the ECB reference. */
function costOf(cost: string | null | undefined): number | null {
  const n = toNum(cost);
  return n === null ? null : -n;
}

export function costStatItems(costs: FxCostsDto | undefined): StatItem[] {
  if (!costs || costs.summary.count === 0) return [];
  const s = costs.summary;
  const pct = toNum(s.cost_pct);
  const cheaper =
    costs.cheaper_provider && costs.cheaper_than
      ? `${providerLabel(costs.cheaper_provider)} cheaper than ${providerLabel(costs.cheaper_than)}`
      : null;
  const rate = toNum(s.all_in_rate);
  return [
    {
      key: "rate",
      label: "Your average rate",
      tip: "Dollars you got per euro on average, with fees counted in, weighted by the euros converted.",
      value: rate === null ? "–" : formatNumber(rate, 4),
      note: "$ per €, fees included",
    },
    {
      key: "cost",
      label: "Total cost",
      tip: "Fees plus the spread against the ECB daily reference (struck about 14:15 CET, so a small negative figure is intraday noise, not a win).",
      // A cost is shown as what it took from you: negative, in the loss colour (7.3.1).
      value: <Money amount={costOf(s.cost)} currency="EUR" signed colored digits={0} />,
      note: (
        <Link to={{ pathname: "/currency", hash: "#conversions" }} className="cost-link">
          Cost over time →
        </Link>
      ),
    },
    {
      key: "avg",
      label: "Avg vs ECB",
      tip: "All-in rate against the ECB daily reference, weighted by the euros converted.",
      value: offPctText(s.avg_off_pct),
      note: cheaper ?? (pct !== null ? `${formatNumber(pct * 100, 2)} % of converted` : undefined),
    },
  ];
}

/** The period's summary for a fold header: its month, or its year when the rows span months. */
function periodSummary(rows: readonly FxConversion[], costs: FxCostsDto): FxCostSummaryDto | null {
  if (rows.length === 0) return null;
  const months = new Set(rows.map((r) => r.date.slice(0, 7)));
  if (months.size === 1) return costs.by_month.find((m) => m.month === [...months][0]) ?? null;
  const year = Number(rows[0].date.slice(0, 4));
  return costs.by_year.find((y) => y.year === year) ?? null;
}

/**
 * " · avg 1.0830" for a fold header, or nothing. A filter that leaves only some of a
 * period's conversions would make the server's figure for the whole period wrong, so
 * then it is left out.
 */
export function PeriodRate({
  rows,
  costs,
  filtered,
}: {
  rows: readonly FxConversion[];
  costs: FxCostsDto | undefined;
  filtered: boolean;
}) {
  if (!costs || filtered) return null;
  const rate = toNum(periodSummary(rows, costs)?.all_in_rate ?? null);
  return rate === null ? null : <> · avg {formatNumber(rate, 4)}</>;
}
