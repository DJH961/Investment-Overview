import { ChevronDown, ChevronRight, Coins, Copy, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { DataTable, type Column } from "../../components/DataTable";
import { Dialog } from "../../components/Dialog";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { Field } from "../../components/Field";
import { IconButton } from "../../components/IconButton";
import { Input } from "../../components/Input";
import { KpiTile } from "../../components/KpiTile";
import { Menu } from "../../components/Menu";
import { Money } from "../../components/Money";
import { PageHeader } from "../../components/PageHeader";
import { Select } from "../../components/Select";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { ApiError } from "../../lib/api";
import { formatDate, formatNumber } from "../../lib/format";
import { parseDecimal, toApiDecimal } from "../../lib/parseDecimal";
import {
  useDeleteConversion,
  useFxConversions,
  useFxPool,
  useFxReference,
  useSaveConversion,
  type DepositMatch,
  type FxConversion,
  type FxProvider,
} from "../../lib/queries/manage";
import { useIsPhone } from "../../lib/useMediaQuery";
import { conversionName, offEcbText, sliceName } from "./matching";
import { PinDialog } from "./PinDialog";
import { StatusChip } from "./StatusChip";
import "./CurrencyConversions.scss";

interface FormState {
  date: string;
  eur: string;
  usd: string;
  fees: string;
  note: string;
  /** "" = not set. */
  provider: FxProvider | "";
}

const EMPTY: FormState = { date: "", eur: "", usd: "", fees: "", note: "", provider: "" };

const NO_PROVIDER = "none";
const PROVIDER_OPTIONS = [
  { value: NO_PROVIDER, label: "Not set" },
  { value: "wise", label: "Wise" },
  { value: "revolut", label: "Revolut" },
  { value: "other", label: "Other" },
];
const PROVIDER_LABEL: Record<string, string> = { wise: "Wise", revolut: "Revolut", other: "Other" };

function fromConversion(c: FxConversion): FormState {
  return {
    date: c.date,
    eur: c.eur_sent,
    usd: c.usd_received,
    fees: c.fees_eur ?? "",
    note: c.note ?? "",
    provider: c.provider ?? "",
  };
}

/** Duplicate: every figure carried over, the date left empty for the new day. */
function duplicateOf(c: FxConversion): Partial<FormState> {
  return { ...fromConversion(c), date: "" };
}

/** Display-only readout of the typed numbers; the server stores the real rate. */
function previewRate(eur: string, usd: string): string {
  const e = parseDecimal(eur);
  const u = parseDecimal(usd);
  return e !== null && u !== null && e > 0 && u > 0 ? formatNumber(u / e, 4) : "–";
}

export interface ConversionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: FxConversion | null;
  /** Starting values for a new conversion (for example the date and USD gap of a deposit). */
  prefill?: Partial<FormState>;
}

export function ConversionDialog({ open, onOpenChange, editing, prefill }: ConversionDialogProps) {
  const save = useSaveConversion();
  const { toast } = useToast();
  const [form, setForm] = useState<FormState>(editing ? fromConversion(editing) : { ...EMPTY, ...prefill });
  const [error, setError] = useState<string | null>(null);
  const reference = useFxReference(form.date);
  const typedRate = (() => {
    const e = parseDecimal(form.eur);
    const u = parseDecimal(form.usd);
    return e !== null && u !== null && e > 0 && u > 0 ? u / e : null;
  })();
  const ecb = reference.data?.published && reference.data.ecb_rate ? Number(reference.data.ecb_rate) : null;
  const usedBy = editing?.used_by.length ?? 0;
  const set =(k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const eur = toApiDecimal(form.eur);
    const usd = toApiDecimal(form.usd);
    const fees = form.fees.trim() === "" ? null : toApiDecimal(form.fees);
    if (!form.date || eur === null || usd === null || !(Number(eur) > 0) || !(Number(usd) > 0)) {
      setError("Enter a date and positive EUR and USD amounts, like 1000,50 or 1000.50.");
      return;
    }
    if (form.fees.trim() !== "" && (fees === null || Number(fees) < 0)) {
      setError("Fees must be a number, like 2,50 or 2.50.");
      return;
    }
    setError(null);
    save.mutate(
      {
        id: editing?.id,
        body: {
          date: form.date,
          eur_sent: eur,
          usd_received: usd,
          fees_eur: fees,
          note: form.note || null,
          provider: form.provider || null,
          // 7.3 matches EUR→USD only; the server rejects any other pair.
          from_ccy: "EUR",
          to_ccy: "USD",
        },
      },
      {
        onSuccess: () => {
          toast({ title: editing ? "Conversion updated" : "Conversion added", tone: "success" });
          onOpenChange(false);
        },
        onError: (err) => setError(err instanceof ApiError ? err.message : "Could not save the conversion."),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? "Edit conversion" : "Add conversion"}
      description="Record a real EUR to USD exchange. EUR returns use your actual rate."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" form="conversion-form" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="conversion-form" className="conversion-form" onSubmit={submit} noValidate>
        <Field label="Date">{(c) => <Input {...c} type="date" value={form.date} onChange={set("date")} />}</Field>
        <Field label="EUR sent">
          {(c) => <Input {...c} inputMode="decimal" value={form.eur} onChange={set("eur")} />}
        </Field>
        <Field label="USD received">
          {(c) => <Input {...c} inputMode="decimal" value={form.usd} onChange={set("usd")} />}
        </Field>
        <Field label="Fees (EUR, optional)">
          {(c) => <Input {...c} inputMode="decimal" value={form.fees} onChange={set("fees")} />}
        </Field>
        <Field label="Provider (optional)">
          {(c) => (
            <Select
              id={c.id}
              ariaLabel="Provider"
              value={form.provider || NO_PROVIDER}
              onValueChange={(v) => setForm((f) => ({ ...f, provider: v === NO_PROVIDER ? "" : (v as FxProvider) }))}
              options={PROVIDER_OPTIONS}
            />
          )}
        </Field>
        <Field label="Note (optional)">{(c) => <Input {...c} value={form.note} onChange={set("note")} />}</Field>
        <p className="conversion-form__rate">
          Effective rate: <strong>{previewRate(form.eur, form.usd)}</strong> USD per EUR
        </p>
        {/^\d{4}-\d{2}-\d{2}$/.test(form.date) && reference.data && (
          <p className="conversion-form__rate" data-testid="ecb-line">
            {ecb !== null
              ? [`ECB on ${formatDate(form.date)}: ${formatNumber(ecb, 4)}`, offEcbText(typedRate, ecb)]
                  .filter(Boolean)
                  .join(" · ")
              : "Reference not published yet"}
          </p>
        )}
        {editing && usedBy > 0 && (
          <p className="conversion-form__warn" role="note">
            Changes how {usedBy} {usedBy === 1 ? "deposit is" : "deposits are"} matched
          </p>
        )}
        {error && (
          <p className="conversion-form__error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

function MatchRow({
  d,
  onAdd,
  onPin,
}: {
  d: DepositMatch;
  onAdd: (d: DepositMatch) => void;
  onPin: (d: DepositMatch) => void;
}) {
  return (
    <li className="conversions__match">
      <div className="conversions__match-head">
        <span>{formatDate(d.date)}</span>
        <Money amount={Number(d.usd)} currency="USD" />
        <span className="conversions__rate">
          {d.effective_rate ? `${formatNumber(Number(d.effective_rate), 4)} USD/EUR` : "no rate"}
        </span>
        <StatusChip status={d.status} pinned={d.pinned} />
      </div>
      <ul className="conversions__slices">
        {d.slices.map((s) => (
          <li key={`${s.conversion_id}-${s.usd}-${s.pinned}`}>
            <Link to="/conversions" className="conversions__link">
              {sliceName(s.conversion_date, s.rate)}
            </Link>
            : <Money amount={Number(s.usd)} currency="USD" /> for <Money amount={Number(s.eur)} currency="EUR" />
            {s.pinned ? " (pinned)" : ""}
          </li>
        ))}
        {d.fallback_usd && Number(d.fallback_usd) > 0 && (
          <li>
            ECB rate{d.fallback_rate_date ? ` of ${formatDate(d.fallback_rate_date)}` : ""}
            {d.fallback_rate ? ` (${formatNumber(Number(d.fallback_rate), 4)})` : ""}:{" "}
            <Money amount={Number(d.fallback_usd)} currency="USD" />
            {d.fallback_eur ? (
              <>
                {" "}
                for <Money amount={Number(d.fallback_eur)} currency="EUR" />
              </>
            ) : null}
          </li>
        )}
      </ul>
      <div className="conversions__match-actions">
        {d.status !== "matched" && (
          <Button size="sm" variant="ghost" onClick={() => onAdd(d)}>
            Add the conversion
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => onPin(d)}>
          {d.pinned ? "Change pin…" : "Use this conversion…"}
        </Button>
      </div>
    </li>
  );
}

/** Row detail: which deposits a conversion paid for. */
function UsedBy({ c }: { c: FxConversion }) {
  const [open, setOpen] = useState(false);
  const n = c.used_by.length;
  return (
    <div className="conversions__used">
      <button
        type="button"
        className="conversions__used-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
        <span>
          Used by {n} {n === 1 ? "deposit" : "deposits"} · <Money amount={Number(c.remaining_usd)} currency="USD" /> left
        </span>
      </button>
      {open && (
        <ul className="conversions__slices">
          {n === 0 && <li>No deposit uses it yet.</li>}
          {c.used_by.map((u) => (
            <li key={`${u.deposit_id}-${u.pinned}`}>
              <Link to="/transactions" className="conversions__link">
                Deposit {formatDate(u.date)}
              </Link>
              : <Money amount={Number(u.usd)} currency="USD" /> for <Money amount={Number(u.eur)} currency="EUR" />
              {u.pinned ? " (pinned)" : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CurrencyConversions() {
  const list = useFxConversions();
  const pool = useFxPool();
  const del = useDeleteConversion();
  const { toast } = useToast();
  const [dialog, setDialog] = useState<{ editing: FxConversion | null; prefill?: Partial<FormState> } | null>(null);
  const [confirm, setConfirm] = useState<FxConversion | null>(null);

  const isPhone = useIsPhone();
  const [pinning, setPinning] = useState<DepositMatch | null>(null);

  const actionsColumn: Column<FxConversion> = {
    key: "actions",
    header: "",
    align: "right",
    cell: (r) => (
      <Menu
        trigger={<IconButton label={`Actions for conversion ${r.id}`} size="sm" icon={<MoreHorizontal aria-hidden />} />}
        items={[
          { label: "Edit", icon: <Pencil aria-hidden />, onSelect: () => setDialog({ editing: r }) },
          {
            label: "Duplicate",
            icon: <Copy aria-hidden />,
            onSelect: () => setDialog({ editing: null, prefill: duplicateOf(r) }),
          },
          { label: "Delete", icon: <Trash2 aria-hidden />, danger: true, onSelect: () => setConfirm(r) },
        ]}
      />
    ),
  };
  const usedColumn: Column<FxConversion> = {
    key: "used",
    header: "Used by",
    cell: (r) => <UsedBy c={r} />,
  };

  // Phone: one human-named line per conversion (date, amounts, rate) instead of eleven columns.
  const phoneColumns: Column<FxConversion>[] = [
    { key: "name", header: "Conversion", primary: true, cell: (r) => conversionName(r), sortValue: (r) => r.date },
    {
      key: "provider",
      header: "Provider",
      phone: "inline",
      cell: (r) => (r.provider ? PROVIDER_LABEL[r.provider] : ""),
    },
    usedColumn,
    actionsColumn,
  ];
  const columns: Column<FxConversion>[] = [
    { key: "date", header: "Date", primary: true, cell: (r) => formatDate(r.date), sortValue: (r) => r.date },
    {
      key: "eur",
      header: "Sent",
      align: "right",
      cell: (r) => <Money amount={Number(r.eur_sent)} currency="EUR" />,
      sortValue: (r) => Number(r.eur_sent),
    },
    {
      key: "usd",
      header: "Received",
      align: "right",
      phone: "headline",
      cell: (r) => <Money amount={Number(r.usd_received)} currency="USD" />,
      sortValue: (r) => Number(r.usd_received),
    },
    {
      key: "rate",
      header: "Rate",
      align: "right",
      cell: (r) => formatNumber(Number(r.rate), 4),
      sortValue: (r) => Number(r.rate),
    },
    {
      key: "allin",
      header: "All-in",
      align: "right",
      cell: (r) => formatNumber(Number(r.all_in_rate), 4),
      sortValue: (r) => Number(r.all_in_rate),
    },
    {
      key: "ecb",
      header: "ECB that day",
      align: "right",
      cell: (r) => (r.ecb_rate ? formatNumber(Number(r.ecb_rate), 4) : "n/a"),
    },
    {
      key: "fees",
      header: "Fees",
      align: "right",
      cell: (r) => (r.fees_eur ? <Money amount={Number(r.fees_eur)} currency="EUR" /> : "–"),
    },
    usedColumn,
    { key: "provider", header: "Provider", cell: (r) => (r.provider ? PROVIDER_LABEL[r.provider] : "") },
    { key: "note", header: "Note", cell: (r) => r.note ?? "" },
    actionsColumn,
  ];

  const addButton = (
    <Button leftIcon={<Plus aria-hidden />} onClick={() => setDialog({ editing: null })}>
      Add conversion
    </Button>
  );

  return (
    <div className="conversions">
      <PageHeader
        title="Currency conversions"
        subtitle="Your real conversion rate. Each USD deposit uses the oldest conversions first (FIFO)."
        actions={addButton}
      />

      {list.isError && !list.data ? (
        <ErrorState onRetry={() => void list.refetch()} />
      ) : list.isPending ? (
        <Skeleton height="220px" />
      ) : list.data.length === 0 ? (
        <EmptyState
          icon={<Coins aria-hidden />}
          title="No conversions yet"
          description="Until you add them, EUR returns use the ECB daily rate."
          action={addButton}
        />
      ) : (
        <>
          <div className="conversions__kpis">
            <KpiTile
              label="Pool balance (USD)"
              loading={pool.isPending}
              value={<Money amount={pool.data ? Number(pool.data.balance_usd) : null} currency="USD" />}
              hint={pool.data ? <Money amount={Number(pool.data.balance_eur)} currency="EUR" /> : undefined}
            />
            <KpiTile label="Batches" value={list.data.length} />
          </div>
          <Card title="Conversion batches" flush>
            <DataTable
              caption="Currency conversion batches"
              columns={isPhone ? phoneColumns : columns}
              rows={list.data}
              rowKey={(r) => String(r.id)}
              defaultSort={{ key: isPhone ? "name" : "date", direction: "desc" }}
            />
          </Card>
          <Card title="Deposit matching" subtitle="Any uncovered part uses the ECB rate.">
            {pool.isError && !pool.data ? (
              <ErrorState onRetry={() => void pool.refetch()} />
            ) : pool.isPending ? (
              <Skeleton height="120px" />
            ) : pool.data.deposits.length === 0 ? (
              <p className="conversions__muted">No USD deposits to match yet.</p>
            ) : (
              <ul className="conversions__matches">
                {pool.data.deposits.map((d) => (
                  <MatchRow
                    key={d.transaction_id}
                    d={d}
                    onAdd={(m) =>
                      setDialog({ editing: null, prefill: { date: m.date, usd: m.fallback_usd ?? "" } })
                    }
                    onPin={setPinning}
                  />
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      {dialog && (
        <ConversionDialog
          key={dialog.editing?.id ?? `new-${dialog.prefill?.date ?? ""}`}
          open
          editing={dialog.editing}
          prefill={dialog.prefill}
          onOpenChange={(o) => !o && setDialog(null)}
        />
      )}
      {pinning && list.data && (
        <PinDialog key={pinning.transaction_id} deposit={pinning} conversions={list.data} onClose={() => setPinning(null)} />
      )}
      <Dialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Delete this conversion?"
        description="EUR returns will be recomputed without this conversion."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={del.isPending}
              onClick={() =>
                confirm &&
                del.mutate(confirm.id, {
                  onSuccess: () => {
                    toast({ title: "Conversion deleted", tone: "success" });
                    setConfirm(null);
                  },
                  onError: () => toast({ title: "Could not delete", tone: "error" }),
                })
              }
            >
              Delete
            </Button>
          </>
        }
      />
    </div>
  );
}
