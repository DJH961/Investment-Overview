import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../components/Button";
import { Field } from "../../components/Field";
import { Input } from "../../components/Input";
import { Select } from "../../components/Select";
import { useToast } from "../../components/Toast";
import { formatMoney } from "../../lib/format";
import { useAccounts } from "../../lib/queries/accounts";
import { useInstruments } from "../../lib/queries/instruments";
import { useSavePlan, type PlanKind, type RecurringPlanInput } from "../../lib/queries/recurring";

export const KIND_LABEL: Record<PlanKind, string> = {
  conversion: "Currency conversion (EUR to USD)",
  deposit: "Deposit into a broker account",
  buy: "Buy",
};

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const UNIT_OPTIONS = [
  { value: "days", label: "Days" },
  { value: "weeks", label: "Weeks" },
  { value: "months", label: "Months" },
];
const PROVIDER_OPTIONS = [
  { value: "revolut", label: "Revolut" },
  { value: "wise", label: "Wise" },
  { value: "other", label: "Other" },
];

interface LegDraft {
  instrumentId: string;
  mode: "amount" | "shares";
  value: string;
}

/** "1000.000000" as typed back: no padding zeros. */
const plain = (v: string | number | null | undefined): string => (v == null || v === "" ? "" : String(Number(v)));

/** "fidelity" -> "Fidelity", "savings_bank" -> "Savings Bank". */
const brokerName = (broker: string): string => broker.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export interface PlanFormProps {
  kind: PlanKind;
  /** Plan id when editing. */
  id?: number;
  initial?: Partial<RecurringPlanInput>;
  /** Hide the kind line when the surrounding UI already names it (setup step, kind buttons). */
  hideKind?: boolean;
  /** The surrounding wizard renders the buttons (a footer that stays visible) and submits this form by id. */
  hideActions?: boolean;
  formId?: string;
  saveLabel?: string;
  skipLabel?: string;
  /** The deposit these buys are paid from (dollars): shows "Total $X of $Y" under the holdings. */
  depositTotal?: number;
  /** Reports the cadence as it is edited (the setup flow re-splits the buys when it changes). */
  onCadenceChange?: (c: { unit: string; every: number; anchor: number | null }) => void;
  onSaved: (body?: RecurringPlanInput) => void;
  onSkip?: () => void;
}

/** One form for the three plan kinds (the setup flow and the edit sheet both use it). */
export function PlanForm({ kind, id, initial, hideKind, hideActions, formId, depositTotal, onCadenceChange, saveLabel = "Save plan", skipLabel, onSaved, onSkip }: PlanFormProps) {
  const accounts = useAccounts();
  const instruments = useInstruments();
  const save = useSavePlan();
  const { toast } = useToast();
  const [unit, setUnit] = useState<string>(initial?.unit ?? (kind === "buy" ? "weeks" : "months"));
  const [every, setEvery] = useState(String(initial?.every ?? 1));
  const [anchor, setAnchor] = useState(initial?.anchor == null ? "" : String(initial.anchor));
  const [start, setStart] = useState(() => initial?.start_date ?? new Date().toISOString().slice(0, 10));
  const [end, setEnd] = useState(initial?.end_date ?? "");
  const [accountId, setAccountId] = useState(initial?.account_id == null ? "" : String(initial.account_id));
  const [legs, setLegs] = useState<LegDraft[]>(() =>
    (initial?.legs ?? []).length > 0
      ? (initial?.legs ?? []).map((l) => ({
          instrumentId: String(l.instrument_id),
          mode: l.shares != null ? "shares" : "amount",
          value: plain(l.shares ?? l.amount),
        }))
      : [{ instrumentId: "", mode: "amount", value: "" }],
  );
  const [amount, setAmount] = useState(plain(initial?.amount));
  const [provider, setProvider] = useState<string>(initial?.provider ?? "revolut");
  const [fee, setFee] = useState(plain(initial?.expected_fee));

  const anchorNum = anchor === "" || unit === "days" ? null : Number(anchor);
  useEffect(() => {
    onCadenceChange?.({ unit, every: Number(every) || 1, anchor: anchorNum });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- report only when the cadence itself changes
  }, [unit, every, anchorNum]);
  const legsTotal = legs.reduce((sum, l) => sum + (l.mode === "amount" ? Number(l.value) || 0 : 0), 0);
  const fmtUsd = (n: number) => formatMoney(n, "USD", { digits: Number.isInteger(n) ? 0 : 2 });

  const accountOptions = (accounts.data ?? []).map((a) => ({ value: String(a.id), label: `${brokerName(a.broker)} ${a.account_label}` }));
  const instrumentOptions = (instruments.data ?? []).map((i) => ({ value: String(i.id), label: i.symbol }));

  const submit = () => {
    const body: RecurringPlanInput = {
      kind,
      unit: unit as RecurringPlanInput["unit"],
      every: Number(every) || 1,
      anchor: anchor === "" || unit === "days" ? null : Number(anchor),
      start_date: start,
      end_date: end || null,
      account_id: kind === "conversion" ? null : Number(accountId) || null,
      amount: kind === "buy" || amount === "" ? null : amount,
      legs:
        kind === "buy"
          ? legs
              .filter((l) => l.instrumentId !== "" || l.value !== "")
              .map((l) => ({
                instrument_id: Number(l.instrumentId),
                amount: l.mode === "amount" ? l.value : null,
                shares: l.mode === "shares" ? l.value : null,
              }))
          : [],
      provider: kind === "conversion" ? (provider as RecurringPlanInput["provider"]) : null,
      expected_fee: kind === "conversion" && fee !== "" ? fee : null,
    };
    save.mutate(
      { id, body },
      {
        onSuccess: () => {
          toast({ title: id === undefined ? "Plan added" : "Plan saved", tone: "success" });
          onSaved(body);
        },
        onError: (e) => toast({ title: "Could not save the plan", description: e.message, tone: "error" }),
      },
    );
  };

  return (
    <form
      id={formId}
      className="recurring-page__form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {!hideKind && <p className="recurring-page__form-kind">{KIND_LABEL[kind]}</p>}
      {kind === "conversion" && (
        <>
          <Field label="Provider">
            {(c) => <Select id={c.id} options={PROVIDER_OPTIONS} value={provider} onValueChange={setProvider} />}
          </Field>
          <Field label="EUR amount per run">
            {(c) => <Input id={c.id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
          </Field>
          <Field label="Expected fee (EUR)" hint="Leave empty to use your last conversion's fee with this provider.">
            {(c) => <Input id={c.id} inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} />}
          </Field>
        </>
      )}
      {kind !== "conversion" && (
        <Field label="Account">
          {(c) => <Select id={c.id} options={accountOptions} value={accountId} onValueChange={setAccountId} placeholder="Choose an account" />}
        </Field>
      )}
      {kind === "deposit" && (
        <Field label="USD amount per deposit">
          {(c) => <Input id={c.id} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
      )}
      {kind === "buy" && (
        <fieldset className="recurring-page__legs">
          <legend className="recurring-page__legs-title">Holdings bought each time</legend>
          {legs.map((leg, i) => (
            <div key={i} className="recurring-page__leg">
              <Field label={`Holding ${i + 1}`}>
                {(c) => (
                  <Select
                    id={c.id}
                    options={instrumentOptions}
                    value={leg.instrumentId}
                    onValueChange={(v) => setLegs(legs.map((l, j) => (j === i ? { ...l, instrumentId: v } : l)))}
                    placeholder="Choose an instrument"
                  />
                )}
              </Field>
              <div className="recurring-page__leg-amount">
                <Field label={leg.mode === "amount" ? "Amount ($)" : "Shares"}>
                  {(c) => (
                    <Input
                      id={c.id}
                      inputMode="decimal"
                      value={leg.value}
                      onChange={(e) => setLegs(legs.map((l, j) => (j === i ? { ...l, value: e.target.value } : l)))}
                    />
                  )}
                </Field>
                <span className="recurring-page__leg-actions">
                  <Button
                    variant="ghost"
                    className="recurring-page__leg-btn"
                    onClick={() => setLegs(legs.map((l, j) => (j === i ? { ...l, mode: l.mode === "amount" ? "shares" : "amount" } : l)))}
                  >
                    {leg.mode === "amount" ? "Use shares" : "Use amount"}
                  </Button>
                  {legs.length > 1 && (
                    <Button
                      variant="ghost"
                      className="recurring-page__leg-btn"
                      aria-label={`Remove holding ${i + 1}`}
                      leftIcon={<Trash2 aria-hidden />}
                      onClick={() => setLegs(legs.filter((_, j) => j !== i))}
                    >
                      Remove
                    </Button>
                  )}
                </span>
              </div>
            </div>
          ))}
          {depositTotal != null && depositTotal > 0 && (
            <p className="recurring-page__legs-total" aria-live="polite">
              Total {fmtUsd(legsTotal)} of {fmtUsd(depositTotal)} for each buy
              {legsTotal > depositTotal ? " (more than the deposit)" : legsTotal < depositTotal ? " (less than the deposit)" : ""}
            </p>
          )}
          <Button
            variant="secondary"
            className="recurring-page__leg-btn"
            leftIcon={<Plus aria-hidden />}
            onClick={() => setLegs([...legs, { instrumentId: "", mode: "amount", value: "" }])}
          >
            Add a holding
          </Button>
        </fieldset>
      )}
      <div className="recurring-page__form-row">
        <Field label="Every">
          {(c) => <Input id={c.id} type="number" min={1} value={every} onChange={(e) => setEvery(e.target.value)} />}
        </Field>
        <Field label="Unit">{(c) => <Select id={c.id} options={UNIT_OPTIONS} value={unit} onValueChange={setUnit} />}</Field>
      </div>
      {unit === "weeks" && (
        <Field label="On">
          {(c) => (
            <Select
              id={c.id}
              options={WEEKDAYS.map((d, i) => ({ value: String(i), label: d }))}
              value={anchor === "" ? "0" : anchor}
              onValueChange={setAnchor}
            />
          )}
        </Field>
      )}
      {unit === "months" && (
        <Field label="Day of month" hint="Clamped to the month's last day (31 gives 30 April).">
          {(c) => <Input id={c.id} type="number" min={1} max={31} value={anchor} onChange={(e) => setAnchor(e.target.value)} />}
        </Field>
      )}
      <div className="recurring-page__form-row">
        <Field label="Starts">{(c) => <Input id={c.id} type="date" value={start} onChange={(e) => setStart(e.target.value)} />}</Field>
        <Field label="Ends (optional)">{(c) => <Input id={c.id} type="date" value={end} onChange={(e) => setEnd(e.target.value)} />}</Field>
      </div>
      {!hideActions && (
        <div className="recurring-page__form-actions">
          {onSkip && (
            <Button variant="ghost" onClick={onSkip}>
              {skipLabel ?? "Skip"}
            </Button>
          )}
          <Button type="submit" variant="primary" loading={save.isPending}>
            {saveLabel}
          </Button>
        </div>
      )}
    </form>
  );
}
