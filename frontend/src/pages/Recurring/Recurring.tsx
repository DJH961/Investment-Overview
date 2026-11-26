import { ArrowLeftRight, Banknote, CirclePause, CirclePlay, CircleCheck, CircleSlash, Pencil, Plus, Receipt, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Chip } from "../../components/Chip";
import { Dialog } from "../../components/Dialog";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { PageHeader } from "../../components/PageHeader";
import { ReminderCard } from "../../components/ReminderCard";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { formatDate, formatMoney } from "../../lib/format";
import { usePlanAction, usePlans, type RecurringPlan } from "../../lib/queries/recurring";
import { KIND_LABEL, PlanForm } from "./PlanForm";
import { FormShell } from "./FormShell";
import { SetupFlow } from "./SetupFlow";
import "./Recurring.scss";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const KIND_ICON = { conversion: ArrowLeftRight, deposit: Banknote, buy: Receipt } as const;

function ordinal(n: number): string {
  const v = n % 100;
  const suffix = v >= 11 && v <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

/** "Every month on the 5th", "Every 2 weeks on Monday", "Every 10 days". */
export function cadenceText(p: Pick<RecurringPlan, "unit" | "every" | "anchor">): string {
  const unit = p.unit === "days" ? "day" : p.unit === "weeks" ? "week" : "month";
  const head = p.every === 1 ? `Every ${unit}` : `Every ${p.every} ${unit}s`;
  if (p.unit === "weeks" && p.anchor != null) return `${head} on ${WEEKDAYS[p.anchor]}`;
  if (p.unit === "months" && p.anchor != null) return `${head} on the ${ordinal(p.anchor)}`;
  return head;
}

/** "$200", "€1,000", "$12.50": no needless ".00". */
function shortMoney(amount: string | null, currency: "USD" | "EUR"): string {
  const n = Number(amount);
  return formatMoney(n, currency, { narrow: true, digits: Number.isInteger(n) ? 0 : 2 });
}

const PROVIDER_NAME: Record<string, string> = { wise: "Wise", revolut: "Revolut", other: "another provider" };

/** The title: what is bought, converted or deposited (the cadence is the muted line below). */
function titleText(p: RecurringPlan): string {
  if (p.kind === "conversion") return `${shortMoney(p.amount, p.currency === "USD" ? "USD" : "EUR")} via ${PROVIDER_NAME[p.provider ?? "revolut"]}`;
  if (p.kind === "deposit") return `${shortMoney(p.amount, "USD")} deposit`;
  const parts = p.legs.map((l) => `${l.shares ? `${Number(l.shares)} sh` : shortMoney(l.amount, "USD")} ${l.symbol}`);
  return parts.length <= 2 ? parts.join(" + ") : `${parts.length} holdings`;
}

const STATUS = {
  active: { label: "Active", icon: <CircleCheck aria-hidden />, tone: "neutral" as const },
  paused: { label: "Paused", icon: <CirclePause aria-hidden />, tone: "warn" as const },
  ended: { label: "Ended", icon: <CircleSlash aria-hidden />, tone: "neutral" as const },
};

/** Manage > Recurring: the plans that write estimated rows, plus the one quiet reminder. */
export function Recurring() {
  const plans = usePlans();
  const action = usePlanAction();
  const { toast } = useToast();
  const [editing, setEditing] = useState<RecurringPlan | null>(null);
  const [adding, setAdding] = useState<RecurringPlan["kind"] | null>(null);
  const [setup, setSetup] = useState(false);
  const [deleting, setDeleting] = useState<RecurringPlan | null>(null);

  const run = (id: number, a: "pause" | "resume" | "end" | "delete", done?: string) =>
    action.mutate(
      { id, action: a },
      {
        onSuccess: () => done && toast({ title: done, tone: "success" }),
        onError: (e) => toast({ title: "That did not work", description: e.message, tone: "error" }),
      },
    );

  let body;
  if (plans.isPending) body = <Skeleton height="8rem" />;
  else if (plans.isError) body = <ErrorState title="Could not load the plans" onRetry={() => plans.refetch()} />;
  else if (plans.data.length === 0)
    body = (
      <EmptyState
        title="No recurring plans yet"
        description="Set up your routine once and the app adds each conversion, deposit and buy for you, flagged est. until you settle it."
        action={
          <Button variant="primary" leftIcon={<Sparkles aria-hidden />} onClick={() => setSetup(true)}>
            Set up your routine
          </Button>
        }
      />
    );
  else
    body = (
      <ul className="recurring-page__list">
        {plans.data.map((p) => {
          const Icon = KIND_ICON[p.kind];
          const st = STATUS[p.status];
          return (
            <li key={p.id} className="recurring-page__plan">
              <div className="recurring-page__plan-main">
                <span className="recurring-page__plan-icon">
                  <Icon aria-hidden />
                </span>
                <div className="recurring-page__plan-text">
                  <span className="recurring-page__plan-title">{titleText(p)}</span>
                  <span className="recurring-page__plan-sub">
                    {[
                      cadenceText(p),
                      p.next_due ? `Next ${formatDate(p.next_due)}` : null,
                      p.end_date ? `until ${formatDate(p.end_date)}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {p.account && (
                    <span className="recurring-page__plan-account" data-truncate-ok title={p.account}>
                      {p.account}
                    </span>
                  )}
                  {p.kind === "buy" && p.legs.length > 2 && (
                    <span className="recurring-page__plan-account" data-truncate-ok title={p.legs.map((l) => l.symbol).join(", ")}>
                      {p.legs.map((l) => l.symbol).join(", ")}
                    </span>
                  )}
                  {p.note && <span className="recurring-page__plan-note">{p.note}</span>}
                </div>
                <Chip className="recurring-page__plan-status" size="sm" tone={st.tone} icon={st.icon}>
                  {st.label}
                </Chip>
              </div>
              <div className="recurring-page__plan-actions">
                <Button size="sm" variant="ghost" leftIcon={<Pencil aria-hidden />} onClick={() => setEditing(p)}>
                  Edit
                </Button>
                {p.status === "paused" ? (
                  <Button size="sm" variant="ghost" leftIcon={<CirclePlay aria-hidden />} onClick={() => run(p.id, "resume", "Plan resumed")}>
                    Resume
                  </Button>
                ) : (
                  p.status === "active" && (
                    <Button size="sm" variant="ghost" leftIcon={<CirclePause aria-hidden />} onClick={() => run(p.id, "pause", "Plan paused")}>
                      Pause
                    </Button>
                  )
                )}
                {p.status !== "ended" && (
                  <Button size="sm" variant="ghost" leftIcon={<CircleSlash aria-hidden />} onClick={() => run(p.id, "end", "Plan ended")}>
                    End
                  </Button>
                )}
                <Button size="sm" variant="ghost" leftIcon={<Trash2 aria-hidden />} onClick={() => setDeleting(p)}>
                  Delete
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    );

  return (
    <div className="recurring-page">
      <PageHeader
        title="Recurring"
        subtitle="Plans for conversions, deposits and buys. Each due date adds an est. row once its price has settled."
        actions={
          <>
            <Button variant="secondary" leftIcon={<Sparkles aria-hidden />} onClick={() => setSetup(true)}>
              Set up your routine
            </Button>
            <Button variant="primary" leftIcon={<Plus aria-hidden />} onClick={() => setAdding("buy")}>
              Add plan
            </Button>
          </>
        }
      />
      <ReminderCard />
      <Card flush>{body}</Card>

      <SetupFlow open={setup} onClose={() => setSetup(false)} />
      <FormShell
        open={adding !== null}
        onClose={() => setAdding(null)}
        title="Add a plan"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAdding(null)}>
              Cancel
            </Button>
            <Button type="submit" form="recurring-plan-form" variant="primary">
              Add plan
            </Button>
          </>
        }
      >
        {adding && (
          <>
            <fieldset className="recurring-page__kinds" aria-label="Kind of plan">
              {(["buy", "deposit", "conversion"] as const).map((k) => (
                <Button key={k} size="sm" variant={adding === k ? "primary" : "secondary"} aria-pressed={adding === k} onClick={() => setAdding(k)}>
                  {k === "buy" ? "Buy" : k === "deposit" ? "Deposit" : "Conversion"}
                </Button>
              ))}
            </fieldset>
            <PlanForm key={adding} kind={adding} hideKind hideActions formId="recurring-plan-form" onSaved={() => setAdding(null)} />

          </>
        )}
      </FormShell>
      <FormShell
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="Edit plan"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button type="submit" form="recurring-plan-form" variant="primary">
              Save plan
            </Button>
          </>
        }
      >
        {editing && (
          <PlanForm
            key={editing.id}
            kind={editing.kind}
            id={editing.id}
            hideActions
            formId="recurring-plan-form"
            initial={{
              unit: editing.unit,
              every: editing.every,
              anchor: editing.anchor,
              start_date: editing.start_date,
              end_date: editing.end_date,
              account_id: editing.account_id,
              amount: editing.amount,
              legs: editing.legs.map((l) => ({ instrument_id: l.instrument_id, amount: l.amount, shares: l.shares })),
              currency: editing.currency,
              provider: editing.provider,
              expected_fee: editing.expected_fee,
            }}
            onSaved={() => setEditing(null)}
          />
        )}
      </FormShell>
      <Dialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this plan?"
        description={`The rows it already added (${deleting ? KIND_LABEL[deleting.kind] : ""}) stay in your ledger.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (deleting) run(deleting.id, "delete", "Plan deleted");
                setDeleting(null);
              }}
            >
              Delete plan
            </Button>
          </>
        }
      />
    </div>
  );
}
