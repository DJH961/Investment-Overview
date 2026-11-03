import { useMemo } from "react";
import { AllocationBar } from "../AllocationBar";
import { Card } from "../Card";
import { ErrorState } from "../ErrorState";
import { Skeleton } from "../Skeleton";
import { toNum, useAllocations } from "../../lib/queries/portfolio";
import type { ReportingCurrency } from "../../lib/prefs";
import "./AssetClassCard.scss";

export interface AssetClassCardProps {
  /** Reporting currency. */
  currency: ReportingCurrency;
}

/** Overview bar of the current split by asset class. */
export function AssetClassCard({ currency }: AssetClassCardProps) {
  const allocations = useAllocations(currency);
  const slices = useMemo(
    () =>
      (allocations.data?.current_by_asset_class ?? []).map((b) => ({
        id: b.label,
        label: b.label,
        actual: toNum(b.pct) ?? 0,
      })),
    [allocations.data],
  );

  return (
    <Card className="asset-class-card" title="Asset classes" collapsibleId="overview.asset-classes">
      {allocations.isError && !allocations.data ? (
        <ErrorState message={allocations.error.message} onRetry={() => void allocations.refetch()} />
      ) : allocations.isPending ? (
        <Skeleton height="3rem" />
      ) : (
        <AllocationBar slices={slices} ariaLabel="Allocation by asset class" />
      )}
    </Card>
  );
}
