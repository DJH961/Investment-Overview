import { useRef, useState, type FormEvent } from "react";
import { Button } from "../../components/Button";
import { Field } from "../../components/Field";
import { Input } from "../../components/Input";
import { Select, type SelectOption } from "../../components/Select";
import { Switch } from "../../components/Switch";
import { getFormatPrefs, todayIn } from "../../lib/format";
import { parseDecimal, toApiDecimal } from "../../lib/parseDecimal";
import { fieldErrors, type TransactionOut, type TransactionWrite } from "../../lib/queries/ledger";
import { reconcileTrade } from "../../lib/queries/transactions-extra";

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
/** Kinds where the server can book the matching money-market leg. */
export const CASH_MOVE_KINDS = new Set(["deposit", "withdrawal", "transfer_in", "transfer_out"]);
/** Kinds where quantity x price = total applies. */
const RECONCILE_KINDS = new Set(["buy", "sell", "dividend_reinvest"]);
export const MONEY_MARKET_HINT =
  "Also books the matching buy or sell of the account's money-market (settlement) fund, so cash you move in or out " +
  "does not sit uninvested. Leave it on unless you enter the fund's legs yourself, otherwise the cash is counted twice.";
/** A typed non-negative number, with a decimal comma or dot. */
const isDecimal = (v: string) => {
  const n = parseDecimal(v);
  return n !== null && n >= 0 && !/^\s*[-\u2212]/.test(v);
};
/** The dot-decimal string the API expects, or null for empty / invalid input. */
const apiValue = (v: string) => (v.trim() && isDecimal(v) ? toApiDecimal(v) : null);
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
    date: row?.date ?? todayIn(getFormatPrefs().timeZone),
    symbol: row?.symbol ?? "",
    quantity: magnitude(row?.quantity),
    price: magnitude(row?.price_native),
    total: magnitude(row?.gross_native),
    fees: magnitude(row?.fees_native),
    description: row?.description ?? "",
    route: true,
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
  const canRoute = !row && CASH_MOVE_KINDS.has(state.kind);
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const checkSeq = useRef(0);

  /** On blur: fill the one missing figure, or flag qty x price != total (server maths). */
  const reconcile = async (next: FormState = state) => {
    if (!RECONCILE_KINDS.has(next.kind)) return setCheck(null);
    const figures = { quantity: next.quantity, price: next.price, total: next.total };
    const given = Object.values(figures).filter((v) => v && isDecimal(v)).length;
    if (given < 2 || Object.values(figures).some((v) => v && !isDecimal(v))) return setCheck(null);
    const seq = ++checkSeq.current;
    try {
      const res = await reconcileTrade({
        quantity: apiValue(figures.quantity),
        price: apiValue(figures.price),
        total: apiValue(figures.total),
      });
      if (seq !== checkSeq.current) return;
      if (res.error) return setCheck({ ok: false, text: res.error });
      if (res.filled === "quantity" || res.filled === "price" || res.filled === "total") {
        const field = res.filled;
        const value = res[field] ?? "";
        setState((s) => ({ ...s, [field]: value }));
        return setCheck({ ok: true, text: `Filled in ${field} - quantity x price = total OK` });
      }
      setCheck({ ok: true, text: "Quantity x price = total OK" });
    } catch {
      if (seq === checkSeq.current) setCheck(null); // the check is a convenience; saving still validates
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!/^\d+$/.test(state.account)) next.account_id = "Pick an account";
    if (!DATE.test(state.date)) next.date = "Bad date - use YYYY-MM-DD";
    for (const key of ["quantity", "price", "total", "fees"] as const) {
      if (state[key].trim() && !isDecimal(state[key])) next[key] = "Enter a non-negative number, like 12.5 or 12,5";
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const body: TransactionWrite = {
      account_id: Number(state.account),
      date: state.date,
      kind: state.kind as TransactionWrite["kind"],
      symbol: state.symbol.trim().toUpperCase() || null,
      quantity: apiValue(state.quantity),
      price: apiValue(state.price),
      total: apiValue(state.total),
      fees: apiValue(state.fees),
      description: state.description.trim() || null,
      route_money_market: canRoute ? state.route : false,
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
          onBlur={decimal && key !== "fees" ? () => void reconcile() : undefined}
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
      {check && RECONCILE_KINDS.has(state.kind) && (
        <p
          className={`transaction-form__check-hint transaction-form__check-hint--${check.ok ? "ok" : "error"}`}
          role={check.ok ? "status" : "alert"}
        >
          {check.text}
        </p>
      )}
      <Field label="Description" error={err("description")}>
        {text("description")}
      </Field>
      {canRoute && (
        <Switch
          checked={state.route}
          onCheckedChange={(v) => set("route", v)}
          label="Auto-fill the money-market fund"
        />
      )}
      {canRoute && <p className="transaction-form__hint">{MONEY_MARKET_HINT}</p>}
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
