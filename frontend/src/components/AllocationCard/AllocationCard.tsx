import { useMemo } from "react";
import { Card } from "../Card";
import { ErrorState } from "../ErrorState";
import { Skeleton } from "../Skeleton";
import { Treemap } from "../Treemap";
import { formatPercent } from "../../lib/format";
import { toNum, useHoldings } from "../../lib/queries/portfolio";
import type { ReportingCurrency } from "../../lib/prefs";
import "./AllocationCard.scss";

export interface AllocationCardProps {
  /** Reporting currency. */
  currency: ReportingCurrency;
}

/** Overview treemap: holdings by value, tinted by today's move. */
export function AllocationCard({ currency }: AllocationCardProps) {
  const holdings = useHoldings(currency);
  const items = useMemo(
    () =>
      (holdings.data?.holdings ?? [])
        .map((h) => ({ h, value: toNum(h.value) ?? 0 }))
        .filter((x) => x.value > 0)
        .map(({ h, value }) => {
          const t = toNum(h.today_pct);
          return {
            id: h.symbol,
            label: h.symbol,
            value,
            tone: t === null || t === 0 ? ("neutral" as const) : t > 0 ? ("pos" as const) : ("neg" as const),
            detail: t === null ? undefined : formatPercent(t, { signed: true }),
          };
        }),
    [holdings.data],
  );

  return (
    <Card className="allocation-card" title="Allocation" collapsibleId="overview.allocation">
      {holdings.isError && !holdings.data ? (
        <ErrorState message={holdings.error.message} onRetry={() => void holdings.refetch()} />
      ) : holdings.isPending ? (
        <Skeleton height="12rem" />
      ) : (
        <Treemap items={items} ariaLabel="Holdings by value" />
      )}
    </Card>
  );
}
