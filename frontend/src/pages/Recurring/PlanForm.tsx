import { useState } from "react";
import { Button } from "../../components/Button";
import { Field } from "../../components/Field";
import { Input } from "../../components/Input";
import { Select } from "../../components/Select";
import { useToast } from "../../components/Toast";
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
  { value: "days", label: "days" },
  { value: "weeks", label: "weeks" },
  { value: "months", label: "months" },
];
const PROVIDER_OPTIONS = [
  { value: "revolut", label: "Revolut" },
  { value: "wise", label: "Wise" },
  { value: "other", label: "Other" },
];

export interface PlanFormProps {
  kind: PlanKind;
  /** Plan id when editing. */
  id?: number;
  initial?: Partial<RecurringPlanInput>;
  saveLabel?: string;
  skipLabel?: string;
  onSaved: () => void;
  onSkip?: () => void;
}

/** One form for the three plan kinds (the setup flow and the edit sheet both use it). */
export function PlanForm({ kind, id, initial, saveLabel = "Save plan", skipLabel, onSaved, onSkip }: PlanFormProps) {
  const accounts = useAccounts();
  const instruments = useInstruments();
  const save = useSavePlan();
  const { toast } = useToast();
  const [unit, setUnit] = useState<string>(initial?.unit ?? (kind === "buy" ? "weeks" : "months"));
  const [every, setEvery] = useState(String(initial?.every ?? 1));
  const [anchor, setAnchor] = useState(initial?.anchor == null ? "" : String(initial.anchor));
  const [start, setStart] = useState(initial?.start_date ?? new Date().toISOString().slice(0, 10));
  const [end, setEnd] = useState(initial?.end_date ?? "");
  const [accountId, setAccountId] = useState(initial?.account_id == null ? "" : String(initial.account_id));
  const [instrumentId, setInstrumentId] = useState(initial?.instrument_id == null ? "" : String(initial.instrument_id));
  const [amount, setAmount] = useState(initial?.amount == null ? "" : String(initial.amount));
  const [shares, setShares] = useState(initial?.shares == null ? "" : String(initial.shares));
  const [provider, setProvider] = useState<string>(initial?.provider ?? "revolut");
  const [fee, setFee] = useState(initial?.expected_fee == null ? "" : String(initial.expected_fee));

  const accountOptions = (accounts.data ?? []).map((a) => ({ value: String(a.id), label: `${a.broker} ${a.account_label}` }));
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
      instrument_id: kind === "buy" ? Number(instrumentId) || null : null,
      amount: amount === "" ? null : amount,
      shares: kind === "buy" && shares !== "" ? shares : null,
      provider: kind === "conversion" ? (provider as RecurringPlanInput["provider"]) : null,
      expected_fee: kind === "conversion" && fee !== "" ? fee : null,
    };
    save.mutate(
      { id, body },
      {
        onSuccess: () => {
          toast({ title: id === undefined ? "Plan added" : "Plan saved", tone: "success" });
          onSaved();
        },
        onError: (e) => toast({ title: "Could not save the plan", description: e.message, tone: "error" }),
      },
    );
  };

  return (
    <form
      className="recurring-page__form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="recurring-page__form-kind">{KIND_LABEL[kind]}</p>
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
        <>
          <Field label="Instrument">
            {(c) => <Select id={c.id} options={instrumentOptions} value={instrumentId} onValueChange={setInstrumentId} placeholder="Choose an instrument" />}
          </Field>
          <Field label="Amount per buy" hint="Either an amount, or a number of shares.">
            {(c) => (
              <Input
                id={c.id}
                inputMode="decimal"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  if (e.target.value) setShares("");
                }}
              />
            )}
          </Field>
          <Field label="Or shares per buy">
            {(c) => (
              <Input
                id={c.id}
                inputMode="decimal"
                value={shares}
                onChange={(e) => {
                  setShares(e.target.value);
                  if (e.target.value) setAmount("");
                }}
              />
            )}
          </Field>
        </>
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
    </form>
  );
}
