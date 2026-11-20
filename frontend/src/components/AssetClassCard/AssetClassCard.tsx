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
 * One fixed look per asset class, so a class keeps its colour whatever else is held
 * (the Allocation treemap's Fund view stripes its tiles with the same colours).
 * ETFs, mutual funds and cash are three solid, clearly different colours (violet/blue,
 * gold, dark teal): cash is often a thin sliver, where hatching hides the colour.
 * Stocks take the light teal and are hatched, the one pair (cash) that sits closer
 * for a protan viewer in the dark theme. Pairs are in tokens.cvd.test.ts.
 */
export const ASSET_CLASS_LOOK: Record<string, { color: number; hatched: boolean }> = {
  etf: { color: 1, hatched: false },
  mutual_fund: { color: 3, hatched: false },
  cash: { color: 5, hatched: false },
  stock: { color: 6, hatched: true },
  savings: { color: 2, hatched: true },
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
        ...ASSET_CLASS_LOOK[b.label],
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
