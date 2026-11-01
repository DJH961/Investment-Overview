import { useState, type FormEvent } from "react";
import { Button } from "../../components/Button";
import { Field } from "../../components/Field";
import { Input } from "../../components/Input";
import { Select, type SelectOption } from "../../components/Select";
import { fieldErrors, type TransactionOut, type TransactionWrite } from "../../lib/queries/ledger";

export const KIND_OPTIONS: SelectOption[] = [
  { value: "buy", label: "Buy" },
  { value: "sell", label: "Sell" },
  { value: "dividend_cash", label: "Dividend (cash)" },
  { value: "dividend_reinvest", label: "Dividend (reinvested)" },
  { value: "deposit", label: "Deposit" },
  { value: "withdrawal", label: "Withdrawal" },
  { value: "interest", label: "Interest" },
  { value: "fee", label: "Fee" },
  { value: "transfer_in", label: "Transfer in" },
  { value: "transfer_out", label: "Transfer out" },
  { value: "split", label: "Split" },
];

const TRADE_KINDS = new Set(["buy", "sell", "dividend_reinvest", "split"]);
const DECIMAL = /^\d+(\.\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface FormState {
  account: string;
  kind: string;
  date: string;
  symbol: string;
  quantity: string;
  price: string;
  total: string;
  fees: string;
  description: string;
  route: boolean;
}

/** Ledger values are signed; the form takes positive magnitudes. */
const magnitude = (v: string | null | undefined) => (v ? v.replace(/^[-+]/, "") : "");

function initial(row: TransactionOut | null, accounts: SelectOption[]): FormState {
  return {
    account: row?.account_id != null ? String(row.account_id) : (accounts[0]?.value ?? ""),
    kind: row?.kind ?? "buy",
    date: row?.date ?? new Date().toISOString().slice(0, 10),
    symbol: row?.symbol ?? "",
    quantity: magnitude(row?.quantity),
    price: magnitude(row?.price_native),
    total: magnitude(row?.gross_native),
    fees: magnitude(row?.fees_native),
    description: row?.description ?? "",
    route: false,
  };
}

export interface TransactionFormProps {
  row: TransactionOut | null;
  accounts: SelectOption[];
  busy: boolean;
  serverError: unknown;
  onSubmit: (body: TransactionWrite) => void;
  onCancel: () => void;
  onDelete?: () => void;
}

export function TransactionForm({ row, accounts, busy, serverError, onSubmit, onCancel, onDelete }: TransactionFormProps) {
  const [state, setState] = useState<FormState>(() => initial(row, accounts));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setState((s) => ({ ...s, [key]: value }));
  const server = serverError ? fieldErrors(serverError) : {};
  const err = (key: string) => errors[key] ?? server[key];
  const isTrade = TRADE_KINDS.has(state.kind);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!/^\d+$/.test(state.account)) next.account_id = "Pick an account";
    if (!DATE.test(state.date)) next.date = "Bad date - use YYYY-MM-DD";
    for (const key of ["quantity", "price", "total", "fees"] as const) {
      if (state[key] && !DECIMAL.test(state[key])) next[key] = "Enter a non-negative decimal";
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const body: TransactionWrite = {
      account_id: Number(state.account),
      date: state.date,
      kind: state.kind as TransactionWrite["kind"],
      symbol: state.symbol.trim().toUpperCase() || null,
      quantity: state.quantity || null,
      price: state.price || null,
      total: state.total || null,
      fees: state.fees || null,
      description: state.description.trim() || null,
      route_money_market: row ? false : state.route,
    };
    onSubmit(body);
  };

  const text = (key: "symbol" | "quantity" | "price" | "total" | "fees" | "description", decimal = false) =>
    function render(c: { id: string; invalid: boolean; "aria-describedby"?: string }) {
      return (
        <Input
          id={c.id}
          aria-describedby={c["aria-describedby"]}
          inputMode={decimal ? "decimal" : undefined}
          value={state[key]}
          invalid={c.invalid}
          onChange={(e) => set(key, e.target.value)}
        />
      );
    };

  return (
    <form className="transaction-form" onSubmit={submit} noValidate>
      {err("_form") && (
        <p className="transaction-form__error" role="alert">
          {err("_form")}
        </p>
      )}
      <div className="transaction-form__grid">
        <Field label="Account" error={err("account_id")}>
          {(c) =>
            accounts.length > 0 ? (
              <Select
                id={c.id}
                options={accounts}
                value={state.account}
                onValueChange={(v) => set("account", v)}
                invalid={c.invalid}
                placeholder="Pick an account"
              />
            ) : (
              <Input
                id={c.id}
                inputMode="numeric"
                placeholder="Account id"
                value={state.account}
                invalid={c.invalid}
                onChange={(e) => set("account", e.target.value)}
              />
            )
          }
        </Field>
        <Field label="Kind" error={err("kind")}>
          {(c) => (
            <Select id={c.id} options={KIND_OPTIONS} value={state.kind} onValueChange={(v) => set("kind", v)} invalid={c.invalid} />
          )}
        </Field>
        <Field label="Date" error={err("date")}>
          {(c) => <Input id={c.id} type="date" value={state.date} invalid={c.invalid} onChange={(e) => set("date", e.target.value)} />}
        </Field>
        {isTrade && (
          <Field label="Symbol" error={err("symbol")}>
            {text("symbol")}
          </Field>
        )}
        {isTrade && (
          <Field label="Quantity" error={err("quantity")}>
            {text("quantity", true)}
          </Field>
        )}
        {isTrade && (
          <Field label="Price" error={err("price")}>
            {text("price", true)}
          </Field>
        )}
        <Field label={isTrade ? "Total (native)" : "Amount (native)"} error={err("total")}>
          {text("total", true)}
        </Field>
        <Field label="Fees" error={err("fees")}>
          {text("fees", true)}
        </Field>
      </div>
      <Field label="Description" error={err("description")}>
        {text("description")}
      </Field>
      {!row && (
        <label className="transaction-form__check">
          <input type="checkbox" checked={state.route} onChange={(e) => set("route", e.target.checked)} />
          <span>Auto-fill the money-market fund for cash transfers</span>
        </label>
      )}
      <div className="transaction-form__actions">
        {onDelete && (
          <Button type="button" variant="danger" onClick={onDelete}>
            Delete
          </Button>
        )}
        <span className="transaction-form__spacer" />
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={busy}>
          Save
        </Button>
      </div>
    </form>
  );
}
