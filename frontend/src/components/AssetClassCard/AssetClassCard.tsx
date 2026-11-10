import { useMemo } from "react";
import { AllocationBar } from "../AllocationBar";
import { Card } from "../Card";
import { ErrorState } from "../ErrorState";
import { Skeleton } from "../Skeleton";
import { assetClassLabel } from "../../lib/format";
import { toNum, useAllocations } from "../../lib/queries/portfolio";
import type { ReportingCurrency } from "../../lib/prefs";
import "./AssetClassCard.scss";

export interface AssetClassCardProps {
  /** Reporting currency. */
  currency: ReportingCurrency;
}

/**
 * One fixed look per asset class, so a class keeps its colour whatever else is held.
 * Mutual funds and cash get the pair that stays furthest apart for a protan viewer
 * (teal hatched vs solid gold): cash is often a thin sliver, where hatching hides
 * the colour, so it is always solid. Pairs are in tokens.cvd.test.ts.
 */
const CLASS_LOOK: Record<string, { color: number; hatched: boolean }> = {
  etf: { color: 1, hatched: false },
  mutual_fund: { color: 2, hatched: true },
  cash: { color: 3, hatched: false },
  stock: { color: 6, hatched: false },
  savings: { color: 5, hatched: true },
  unknown: { color: 4, hatched: true },
};

/** Overview bar of the current split by asset class. */
export function AssetClassCard({ currency }: AssetClassCardProps) {
  const allocations = useAllocations(currency);
  const slices = useMemo(
    () =>
      (allocations.data?.current_by_asset_class ?? []).map((b) => ({
        id: b.label,
        label: assetClassLabel(b.label),
        actual: toNum(b.pct) ?? 0,
        ...CLASS_LOOK[b.label],
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
