import { PieChart } from "lucide-react";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { PageHeader } from "../../components/PageHeader";
import { Skeleton } from "../../components/Skeleton";
import { usePrefs } from "../../lib/prefs";
import { useAllocations } from "../../lib/queries/allocations";
import { useCalculatorInputs } from "../../lib/queries/reports";
import { Builder } from "./Builder";
import { DriftCard } from "./DriftCard";
import "./Allocations.scss";

export { totalWeight } from "./builderState";

export function Allocations() {
  const { currency } = usePrefs();
  const q = useAllocations(currency);
  const inputs = useCalculatorInputs(currency);

  const failed = (q.isError && !q.data) || (inputs.isError && !inputs.data);
  const loading = q.isPending || inputs.isPending;

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
      ) : loading ? (
        <Skeleton height="260px" />
      ) : inputs.data.instruments.length === 0 ? (
        <EmptyState
          icon={<PieChart aria-hidden />}
          title="No funds yet"
          description="Import transactions first, then build a target mix here."
        />
      ) : (
        <>
          {/* Always shown: with no target yet this is where the first one is made. */}
          <Builder
            key={q.data.active_target_id ?? "none"}
            inputs={inputs.data}
            allocations={q.data}
            defaultCcy={currency}
          />
          <DriftCard data={q.data} ccy={currency} />
        </>
      )}
    </div>
  );
}
