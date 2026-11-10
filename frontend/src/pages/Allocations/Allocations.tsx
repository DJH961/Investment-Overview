import { PieChart } from "lucide-react";
import { useNavigate } from "react-router";
import { Button } from "../../components/Button";
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

/** Empty-state way out: the Import page. */
function ImportButton() {
  const navigate = useNavigate();
  return (
    <Button variant="primary" onClick={() => navigate("/import")}>
      Import a broker file
    </Button>
  );
}

export function Allocations() {
  const { currency } = usePrefs();
  const q = useAllocations(currency);
  const inputs = useCalculatorInputs(currency);

  const failed = (q.isError && !q.data) || (inputs.isError && !inputs.data);
  const noFunds = inputs.data !== undefined && inputs.data.instruments.length === 0;

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
          action={<ImportButton />}
        />
      ) : (
        <>
          {/* Each section renders as soon as its own data is there; only the rest shows a skeleton. */}
          {/* Always shown: with no target yet this is where the first one is made. */}
          {inputs.data && q.data ? (
            // Not keyed by the active target: saving one must not wipe the mix being edited.
            <Builder
              inputs={inputs.data}
              allocations={q.data}
              defaultCcy={currency}
            />
          ) : (
            <Skeleton height="260px" />
          )}
          {q.data ? <DriftCard data={q.data} ccy={currency} /> : <Skeleton height="260px" />}
        </>
      )}
    </div>
  );
}
