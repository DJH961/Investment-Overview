import { ClipboardCheck, Upload } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { useEstimates, useSettle, type EstimateRow } from "../../lib/queries/recurring";
import { Button } from "../Button";
import { SettleSheet } from "../SettleSheet";
import { useToast } from "../Toast";
import "./ReminderCard.scss";

/**
 * The one quiet reminder for estimated rows from recurring plans: a line per plan that says
 * what input is needed ("Revolut conversion, 1 Dec: type what you received"), never a line
 * per row, and nothing at all for deposits. Each line opens the quick-settle sheet on that
 * plan's drafts; "Accept as estimated" settles them as they are.
 */
export function ReminderCard() {
  const { data } = useEstimates();
  const [queue, setQueue] = useState<readonly EstimateRow[]>([]);
  const settle = useSettle();
  const { toast } = useToast();
  if (!data?.count) return null;
  const rowsOf = (planId: number | null, kind: "buy" | "conversion") =>
    data.rows.filter((r) => r.plan_id === planId && (kind === "buy") === (r.row_type === "transaction"));
  return (
    <section className="reminder-card" aria-label="Estimated rows to settle">
      <h2 className="reminder-card__title">
        <ClipboardCheck aria-hidden /> {data.count} estimated {data.count === 1 ? "row" : "rows"} to settle
      </h2>
      <ul className="reminder-card__list">
        {data.groups.map((g) => {
          const rows = rowsOf(g.plan_id, g.kind);
          return (
            <li key={`${g.plan_id}-${g.kind}`} className="reminder-card__line">
              <span className="reminder-card__message">{g.message}</span>
              <span className="reminder-card__actions">
                <Button size="sm" variant="primary" onClick={() => setQueue(rows)}>
                  Settle
                </Button>
                {g.input === "import" && (
                  <Link to="/import" className="reminder-card__link">
                    <Upload aria-hidden /> Import file
                  </Link>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  loading={settle.isPending}
                  onClick={() =>
                    settle.mutate(
                      { rows: rows.map((r) => ({ row_type: r.row_type, id: r.id })) },
                      { onError: (e) => toast({ title: "Could not settle", description: e.message, tone: "error" }) },
                    )
                  }
                >
                  Accept as estimated
                </Button>
              </span>
            </li>
          );
        })}
      </ul>
      <SettleSheet rows={queue} onClose={() => setQueue([])} />
    </section>
  );
}
