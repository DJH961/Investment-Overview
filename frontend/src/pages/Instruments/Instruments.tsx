import { Pencil, Search } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { DataTable, type Column } from "../../components/DataTable";
import { Dialog } from "../../components/Dialog";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { Field } from "../../components/Field";
import { IconButton } from "../../components/IconButton";
import { Input } from "../../components/Input";
import { PageHeader } from "../../components/PageHeader";
import { Select, type SelectOption } from "../../components/Select";
import { Sheet } from "../../components/Sheet";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { ApiError } from "../../lib/api";
import { formatDate, formatPercent } from "../../lib/format";
import {
  instrumentErrors,
  useInstruments,
  useRedownloadPrices,
  useUpdateInstrument,
  type AssetClass,
  type Instrument,
  type InstrumentPatch,
  type PricingMode,
} from "../../lib/queries/instruments";
import { useShellStatus } from "../../lib/shell";
import { useIsPhone } from "../../lib/useMediaQuery";
import { usePersistentState } from "../../lib/usePersistentState";
import "./Instruments.scss";

export const ASSET_CLASS_OPTIONS: { value: AssetClass; label: string }[] = [
  { value: "etf", label: "ETF" },
  { value: "mutual_fund", label: "Mutual fund" },
  { value: "stock", label: "Stock" },
  { value: "cash", label: "Cash / money market" },
  { value: "savings", label: "Savings" },
  { value: "unknown", label: "Unknown" },
];
const ASSET_LABEL: Record<string, string> = Object.fromEntries(ASSET_CLASS_OPTIONS.map((o) => [o.value, o.label]));

export const PRICING_MODES: { value: PricingMode; label: string; help: string }[] = [
  {
    value: "auto",
    label: "Automatic",
    help: "Daily closes are downloaded from the price provider (using the provider symbol if set, else the ticker).",
  },
  {
    value: "manual",
    label: "Manual",
    help: "Nothing is downloaded. Valuations use the prices you enter yourself (Health & Repair → Market data).",
  },
  {
    value: "delisted",
    label: "Delisted",
    help: "The ticker no longer trades. Download stops; the last known price and the history stay as they are.",
  },
];
const MODE_LABEL: Record<string, string> = Object.fromEntries(PRICING_MODES.map((m) => [m.value, m.label]));

const DECIMAL = /^\d+(\.\d+)?$/;

/** "0.03" (%) -> "0.0003" without float rounding; display-only unit change, no maths. */
export function percentToFraction(pct: string): string {
  const [int, frac = ""] = pct.split(".");
  const digits = int.padStart(3, "0") + frac;
  const point = digits.length - frac.length - 2;
  const out = `${digits.slice(0, point)}.${digits.slice(point)}`.replace(/^0+(?=\d)/, "").replace(/\.?0+$/, "");
  return out === "" || out === "." ? "0" : out;
}

/** "0.0003" -> "0.03" (%). */
export function fractionToPercent(fraction: string | null): string {
  if (!fraction) return "";
  const [int, frac = ""] = fraction.replace(/^-/, "").split(".");
  const padded = frac.padEnd(2, "0");
  const out = `${(int + padded.slice(0, 2)).replace(/^0+(?=\d)/, "")}.${padded.slice(2)}`.replace(/\.?0+$/, "");
  return out === "" ? "0" : out;
}

interface FormState {
  name: string;
  asset_class: string;
  expense_ratio: string;
  category: string;
  active: boolean;
  provider_symbol: string;
  pricing_mode: PricingMode;
}

function initial(i: Instrument): FormState {
  return {
    name: i.name ?? "",
    asset_class: i.asset_class,
    expense_ratio: fractionToPercent(i.expense_ratio),
    category: i.category ?? "",
    active: i.active,
    provider_symbol: i.provider_symbol ?? "",
    pricing_mode: i.pricing_mode,
  };
}

/** Only the fields that changed; an emptied text field is `null` (clears the override). */
export function buildPatch(i: Instrument, s: FormState): InstrumentPatch {
  const start = initial(i);
  const patch: InstrumentPatch = {};
  const text = (v: string) => v.trim() || null;
  if (s.name.trim() !== start.name.trim()) patch.name = text(s.name);
  if (s.asset_class !== start.asset_class) patch.asset_class = s.asset_class as AssetClass;
  if (s.expense_ratio.trim() !== start.expense_ratio)
    patch.expense_ratio = s.expense_ratio.trim() ? percentToFraction(s.expense_ratio.trim()) : null;
  if (s.category.trim() !== start.category.trim()) patch.category = text(s.category);
  if (s.active !== start.active) patch.active = s.active;
  if (s.provider_symbol.trim().toUpperCase() !== start.provider_symbol.toUpperCase())
    patch.provider_symbol = text(s.provider_symbol.toUpperCase());
  if (s.pricing_mode !== start.pricing_mode) patch.pricing_mode = s.pricing_mode;
  return patch;
}

function InstrumentForm({ instrument, onDone }: { instrument: Instrument; onDone: () => void }) {
  const { toast } = useToast();
  const update = useUpdateInstrument();
  const redownload = useRedownloadPrices();
  const [state, setState] = useState<FormState>(() => initial(instrument));
  const [localError, setLocalError] = useState<string | null>(null);
  const [suggest, setSuggest] = useState(false);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setState((s) => ({ ...s, [k]: v }));
  const errors = update.isError ? instrumentErrors(update.error) : {};
  const mode = PRICING_MODES.find((m) => m.value === state.pricing_mode);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (state.expense_ratio.trim() && !DECIMAL.test(state.expense_ratio.trim())) {
      setLocalError("Enter the expense ratio as a percentage, e.g. 0.03");
      return;
    }
    setLocalError(null);
    const patch = buildPatch(instrument, state);
    if (Object.keys(patch).length === 0) return onDone();
    update.mutate(
      { id: instrument.id, patch },
      {
        onSuccess: (r) => {
          toast({ title: `Saved ${instrument.symbol}`, description: r.changed.length ? `Changed: ${r.changed.join(", ")}` : undefined, tone: "success" });
          if (r.redownload_suggested) setSuggest(true);
          else onDone();
        },
      },
    );
  };

  const startRedownload = () =>
    redownload.mutate(instrument.id, {
      onSuccess: () => {
        toast({ title: `Re-downloading ${instrument.symbol} prices`, description: "Follow it under Health & Repair.", tone: "success" });
        onDone();
      },
      onError: (e) =>
        toast({
          title: "Could not start the re-download",
          description: e instanceof ApiError && e.status === 403 ? "This needs a signed-in browser session." : e.message,
          tone: "error",
        }),
    });

  if (suggest) {
    return (
      <div className="instruments-page__suggest">
        <p className="instruments-page__text">
          The price mapping of {instrument.symbol} changed. The stored price history still comes from the old source. Re-download it
          now so valuations use the new one? This drops the cached closes (manual fixes stay) and rebuilds the history; it can take a
          few minutes.
        </p>
        <div className="instruments-page__actions">
          <Button variant="ghost" onClick={onDone}>
            Later
          </Button>
          <Button variant="primary" loading={redownload.isPending} onClick={startRedownload}>
            Re-download prices
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form className="instruments-page__form" onSubmit={submit} noValidate>
      {(errors._form || localError) && (
        <p className="instruments-page__error" role="alert">
          {localError ?? errors._form}
        </p>
      )}
      <p className="instruments-page__text">
        {instrument.symbol} · {instrument.native_currency} · {instrument.transaction_count} transactions. Edits are overrides on top of
        the imported values; clear a field to go back to the imported one.
      </p>
      <div className="instruments-page__grid">
        <Field label="Name" error={errors.name} hint={instrument.name_override ? `Imported: ${instrument.ledger_name ?? "—"}` : undefined}>
          {(c) => <Input id={c.id} value={state.name} invalid={c.invalid} onChange={(e) => set("name", e.target.value)} />}
        </Field>
        <Field
          label="Asset class"
          error={errors.asset_class}
          hint={instrument.asset_class_override ? `Imported: ${ASSET_LABEL[instrument.ledger_asset_class] ?? instrument.ledger_asset_class}` : undefined}
        >
          {(c) => (
            <Select
              id={c.id}
              options={ASSET_CLASS_OPTIONS as SelectOption[]}
              value={state.asset_class}
              invalid={c.invalid}
              onValueChange={(v) => set("asset_class", v)}
            />
          )}
        </Field>
        <Field label="Expense ratio (% per year)" error={errors.expense_ratio} hint="E.g. 0.03 for 0.03 %. Used for the cost estimates.">
          {(c) => (
            <Input
              id={c.id}
              inputMode="decimal"
              value={state.expense_ratio}
              invalid={c.invalid}
              onChange={(e) => set("expense_ratio", e.target.value)}
            />
          )}
        </Field>
        <Field label="Category" error={errors.category} hint="Free text, e.g. 'US large cap'.">
          {(c) => <Input id={c.id} value={state.category} invalid={c.invalid} onChange={(e) => set("category", e.target.value)} />}
        </Field>
        <Field
          label="Provider symbol"
          error={errors.provider_symbol}
          hint={`Ticker sent to the price provider when it differs (e.g. a .DE listing). Now fetching: ${instrument.fetch_symbol ?? "nothing"}.`}
        >
          {(c) => (
            <Input
              id={c.id}
              value={state.provider_symbol}
              placeholder={instrument.symbol}
              invalid={c.invalid}
              onChange={(e) => set("provider_symbol", e.target.value)}
            />
          )}
        </Field>
        <Field label="Pricing" error={errors.pricing_mode} hint={mode?.help}>
          {(c) => (
            <Select
              id={c.id}
              options={PRICING_MODES.map(({ value, label }) => ({ value, label }))}
              value={state.pricing_mode}
              invalid={c.invalid}
              onValueChange={(v) => set("pricing_mode", v as PricingMode)}
            />
          )}
        </Field>
      </div>
      <label className="instruments-page__check" title="Inactive instruments are not priced and are hidden from pickers; history stays.">
        <input type="checkbox" checked={state.active} onChange={(e) => set("active", e.target.checked)} />
        <span>Active (inactive: no price downloads, hidden from pickers; history stays)</span>
      </label>
      {errors.active && <p className="instruments-page__error">{errors.active}</p>}
      <div className="instruments-page__actions">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={update.isPending}>
          Save
        </Button>
      </div>
    </form>
  );
}

export function Instruments() {
  const isPhone = useIsPhone();
  const [params, setParams] = useSearchParams();
  const list = useInstruments();
  const [q, setQ] = usePersistentState("instruments.q", "");
  const [showInactive, setShowInactive] = usePersistentState("instruments.inactive", true);
  const editId = Number(params.get("id")) || null;
  const editing = editId !== null ? list.data?.find((i) => i.id === editId) : undefined;

  useShellStatus(list.isError ? "stale" : "closed", list.isError ? "Offline" : "Instruments", () => void list.refetch(), list.isFetching);

  const open = (id: number | null) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (id === null) next.delete("id");
        else next.set("id", String(id));
        return next;
      },
      { replace: true },
    );

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (list.data ?? []).filter(
      (i) =>
        (showInactive || i.active) &&
        (!needle || [i.symbol, i.name, i.category].some((v) => v?.toLowerCase().includes(needle))),
    );
  }, [list.data, q, showInactive]);

  const columns: Column<Instrument>[] = [
    { key: "symbol", header: "Symbol", primary: true, cell: (i) => i.symbol, sortValue: (i) => i.symbol },
    { key: "name", header: "Name", phone: "sub", cell: (i) => i.name ?? "—", sortValue: (i) => i.name },
    {
      key: "class",
      header: "Asset class",
      cell: (i) => ASSET_LABEL[i.asset_class] ?? i.asset_class,
      sortValue: (i) => i.asset_class,
    },
    {
      key: "ter",
      header: "TER",
      align: "right",
      cell: (i) => (i.expense_ratio ? formatPercent(Number(i.expense_ratio), { digits: 2 }) : "—"),
      sortValue: (i) => (i.expense_ratio ? Number(i.expense_ratio) : null),
    },
    { key: "category", header: "Category", cell: (i) => i.category ?? "—", phone: "hide", sortValue: (i) => i.category },
    {
      key: "pricing",
      header: "Pricing",
      cell: (i) => (
        <span className={`instruments-page__mode instruments-page__mode--${i.pricing_mode}`}>
          {MODE_LABEL[i.pricing_mode]}
          {i.provider_symbol ? ` (${i.provider_symbol})` : ""}
        </span>
      ),
      sortValue: (i) => i.pricing_mode,
    },
    {
      key: "price",
      header: "Last price",
      cell: (i) => (i.latest_price_date ? formatDate(i.latest_price_date, "short") : "—"),
      sortValue: (i) => i.latest_price_date,
      phone: "hide",
      nowrap: true,
    },
    { key: "count", header: "Txns", align: "right", cell: (i) => i.transaction_count, sortValue: (i) => i.transaction_count, phone: "hide" },
    {
      key: "edit",
      header: "",
      cell: (i) => <IconButton label={`Edit ${i.symbol}`} size="sm" icon={<Pencil aria-hidden />} onClick={() => open(i.id)} />,
    },
  ];

  const form = editing && <InstrumentForm key={editing.id} instrument={editing} onDone={() => open(null)} />;
  const title = editing ? `Edit ${editing.symbol}` : "Edit instrument";

  return (
    <div className="instruments-page">
      <PageHeader title="Instruments" subtitle="Names, asset classes, costs and how each one is priced." />
      <search className="instruments-page__filters">
        <Input
          aria-label="Search instruments"
          placeholder="Search…"
          leftIcon={<Search aria-hidden />}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <label className="instruments-page__check">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          <span>Show inactive</span>
        </label>
      </search>
      {list.isError && !list.data ? (
        <ErrorState title="Could not load instruments" message={list.error.message} onRetry={() => void list.refetch()} />
      ) : list.isPending ? (
        <Skeleton height="16rem" />
      ) : list.data.length === 0 ? (
        <EmptyState title="No instruments yet" description="They appear when you import or add transactions." />
      ) : (
        <Card flush>
          <DataTable
            caption="Instruments"
            columns={columns}
            rows={rows}
            rowKey={(i) => String(i.id)}
            defaultSort={{ key: "symbol", direction: "asc" }}
            rowClassName={(i) => !i.active && "instruments-page__row--inactive"}
            emptyMessage="No instruments match."
          />
        </Card>
      )}
      {editId !== null && list.data && !editing && (
        <p className="instruments-page__error" role="alert">
          Instrument #{editId} was not found.
        </p>
      )}
      {editing &&
        (isPhone ? (
          <Sheet open onOpenChange={(o) => !o && open(null)} title={title}>
            {form}
          </Sheet>
        ) : (
          <Dialog open onOpenChange={(o) => !o && open(null)} title={title}>
            {form}
          </Dialog>
        ))}
    </div>
  );
}
