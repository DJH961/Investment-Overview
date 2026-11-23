import { ClipboardCheck, Upload } from "lucide-react";
import { useState } from "react";
import { useEstimates, type EstimateRow } from "../../lib/queries/recurring";
import { Button, LinkButton } from "../Button";
import { SettleSheet } from "../SettleSheet";
import "./ReminderCard.scss";

/**
 * The one quiet reminder for estimated rows from recurring plans: a line per plan that says
 * what input is needed ("Revolut conversion, 1 Dec: type what you received"), never a line
 * per row, and nothing at all for deposits. Each line opens the quick-settle sheet on that
 * plan's drafts: you always see the numbers before they are confirmed.
 */
export function ReminderCard() {
  const { data } = useEstimates();
  const [queue, setQueue] = useState<readonly EstimateRow[]>([]);
  if (!data?.count) return null;
  const rowsOf = (planId: number | null, kind: "buy" | "conversion") =>
    data.rows.filter((r) => r.plan_id === planId && (kind === "buy") === (r.row_type === "transaction"));
  return (
    <section className="reminder-card" aria-label="Estimated rows to settle">
      <h2 className="reminder-card__title">
        <ClipboardCheck aria-hidden /> {data.count} estimated {data.count === 1 ? "entry" : "entries"} to settle
      </h2>
      <ul className="reminder-card__list">
        {data.groups.map((g) => {
          const rows = rowsOf(g.plan_id, g.kind);
          return (
            <li key={`${g.plan_id}-${g.kind}`} className="reminder-card__line">
              <span className="reminder-card__message">{g.message}</span>
              <span className="reminder-card__actions">
                <Button className="reminder-card__btn" variant="primary" fullWidth onClick={() => setQueue(rows)}>
                  Settle
                </Button>
                {g.input === "import" && (
                  <LinkButton className="reminder-card__btn" to="/import" fullWidth leftIcon={<Upload aria-hidden />}>
                    Import file
                  </LinkButton>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <SettleSheet rows={queue} onClose={() => setQueue([])} />
    </section>
  );
}
