import { PencilLine } from "lucide-react";
import { useState } from "react";
import { Chip } from "../../components/Chip";
import "./EstChip.scss";
import { useEstimates, type EstimateRow } from "../../lib/queries/recurring";

/** "est." tag on an estimated row (icon plus text, never colour alone); one tap opens quick-settle. */
export function EstChip({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className="est-chip" aria-label="Estimated row: settle it" onClick={onOpen}>
      <Chip size="sm" tone="estimate" icon={<PencilLine aria-hidden />}>
        est.
      </Chip>
    </button>
  );
}

/**
 * The quick-settle queue for a tapped est. row: that row first, then the other drafts of
 * the same plan, so one Save moves on to the next.
 */
export function useEstimateQueue(rowType: EstimateRow["row_type"] = "transaction") {
  const { data } = useEstimates();
  const [queue, setQueue] = useState<readonly EstimateRow[]>([]);
  return {
    queue,
    open: (id: number) => {
      const rows = (data?.rows ?? []).filter((r) => r.row_type === rowType);
      const tapped = rows.find((r) => r.id === id);
      if (!tapped) return;
      const rest = rows.filter((r) => r.id !== id && r.plan_id === tapped.plan_id);
      setQueue([tapped, ...rest]);
    },
    close: () => setQueue([]),
  };
}
