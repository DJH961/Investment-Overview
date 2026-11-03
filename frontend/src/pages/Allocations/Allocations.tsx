import { PieChart } from "lucide-react";
import { useMemo } from "react";
import { AllocationBar } from "../../components/AllocationBar";
import { Card } from "../../components/Card";
import { DataTable, type Column } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { Money } from "../../components/Money";
import { PageHeader } from "../../components/PageHeader";
import { Percent } from "../../components/Percent";
import { Skeleton } from "../../components/Skeleton";
import { assetClassLabel, formatNumber } from "../../lib/format";
import { usePrefs } from "../../lib/prefs";
import { useAllocations, type AllocationsData } from "../../lib/queries/allocations";
import { useCalculatorInputs } from "../../lib/queries/reports";
import { Builder } from "./Builder";
import "./Allocations.scss";

export { totalWeight } from "./builder";

type DriftRow = AllocationsData["drift"][number];

export function Allocations() {
  const { currency } = usePrefs();
  const q = useAllocations(currency);
  const inputs = useCalculatorInputs(currency);

  const hasDrift = (q.data?.drift.length ?? 0) > 0;
  const slices = useMemo(
    () =>
      hasDrift
        ? (q.data?.drift ?? []).map((d: DriftRow) => ({
            id: d.key,
            label: d.label,
            actual: Number(d.current_pct),
            target: Number(d.target_pct),
          }))
        : (q.data?.current_by_asset_class ?? []).map((b) => ({ id: b.label, label: assetClassLabel(b.label), actual: Number(b.pct) })),
    [q.data, hasDrift],
  );

  const driftColumns: Column<DriftRow>[] = [
    { key: "label", header: "Fund", primary: true, cell: (r) => r.label, sortValue: (r) => r.label },
    { key: "cur", header: "Current", align: "right", cell: (r) => <Percent ratio={Number(r.current_pct)} digits={1} /> },
    { key: "tgt", header: "Target", align: "right", cell: (r) => <Percent ratio={Number(r.target_pct)} digits={1} /> },
    {
      key: "drift",
      header: "Drift",
      align: "right",
      cell: (r) => `${Number(r.drift_pp) > 0 ? "+" : ""}${formatNumber(Number(r.drift_pp), 1)} pp`,
      sortValue: (r) => Math.abs(Number(r.drift_pp)),
    },
    {
      key: "delta",
      header: "To reach target",
      align: "right",
      phone: "hide",
      cell: (r) => (r.delta_value ? <Money amount={Number(r.delta_value)} currency={currency} signed colored /> : "–"),
    },
  ];

  const failed = (q.isError && !q.data) || (inputs.isError && !inputs.data);
  const noFunds = inputs.data !== undefined && inputs.data.instruments.length === 0;
  const active = q.data?.targets.find((t) => t.id === q.data?.active_target_id);

  return (
    <div className="allocations">
      <PageHeader title="Allocations" subtitle="Investment calculator, targets and drift." />
      {failed ? (
        <ErrorState
          onRetry={() => {
            void q.refetch();
            void inputs.refetch();
          }}
        />
      ) : noFunds ? (
        <EmptyState
          icon={<PieChart aria-hidden />}
          title="No funds yet"
          description="Import transactions first, then build a target mix here."
        />
      ) : (
        <>
          {/* Each section renders as soon as its own data is there; only the rest shows a skeleton. */}
          {/* Always shown: with no target yet this is where the first one is made. */}
          {inputs.data && q.data ? (
            <Builder
              key={q.data.active_target_id ?? "none"}
              inputs={inputs.data}
              allocations={q.data}
              defaultCcy={currency}
            />
          ) : (
            <Skeleton height="260px" />
          )}
          {q.data ? (
            <Card
              collapsibleId="allocations.drift"
              title={hasDrift ? `Targets & drift${active ? ` · ${active.name}` : ""}` : "Current allocation"}
              subtitle={
                hasDrift
                  ? "Drift: positive means over-allocated, negative under-allocated."
                  : "No active target yet. Share of portfolio value by asset class."
              }
            >
              <AllocationBar slices={slices} ariaLabel="Current allocation with target markers" />
              {hasDrift && (
                <DataTable caption="Allocation drift" columns={driftColumns} rows={q.data.drift} rowKey={(r) => r.key} />
              )}
            </Card>
          ) : (
            <Skeleton height="260px" />
          )}
        </>
      )}
    </div>
  );
}
