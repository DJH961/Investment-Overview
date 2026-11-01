import { Coins, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
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
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { ApiError } from "../../lib/api";
import { formatDate, formatNumber } from "../../lib/format";
import {
  useDeleteConversion,
  useFxConversions,
  useFxPool,
  useSaveConversion,
  type DepositMatch,
  type FxConversion,
} from "../../lib/queries/manage";
import "./CurrencyConversions.scss";

interface FormState {
  date: string;
  eur: string;
  usd: string;
  fees: string;
  note: string;
}

const EMPTY: FormState = { date: "", eur: "", usd: "", fees: "", note: "" };

function fromConversion(c: FxConversion): FormState {
  return { date: c.date, eur: c.eur_sent, usd: c.usd_received, fees: c.fees_eur ?? "", note: c.note ?? "" };
}

/** Display-only readout of the typed numbers; the server stores the real rate. */
function previewRate(eur: string, usd: string): string {
  const e = Number(eur);
  const u = Number(usd);
  return e > 0 && u > 0 ? formatNumber(u / e, 4) : "–";
}

export interface ConversionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: FxConversion | null;
}

export function ConversionDialog({ open, onOpenChange, editing }: ConversionDialogProps) {
  const save = useSaveConversion();
  const { toast } = useToast();
  const [form, setForm] = useState<FormState>(editing ? fromConversion(editing) : EMPTY);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.date || !(Number(form.eur) > 0) || !(Number(form.usd) > 0)) {
      setError("Enter a date and positive EUR and USD amounts.");
      return;
    }
    setError(null);
    save.mutate(
      {
        id: editing?.id,
        body: {
          date: form.date,
          eur_sent: form.eur,
          usd_received: form.usd,
          fees_eur: form.fees || null,
          note: form.note || null,
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
          <Button type="submit" form="conversion-form" loading={save.isPending}>
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
        <Field label="Note (optional)">{(c) => <Input {...c} value={form.note} onChange={set("note")} />}</Field>
        <p className="conversion-form__rate">
          Effective rate: <strong>{previewRate(form.eur, form.usd)}</strong> USD per EUR
        </p>
        {error && (
          <p className="conversion-form__error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

function MatchRow({ d }: { d: DepositMatch }) {
  return (
    <li className="conversions__match">
      <div className="conversions__match-head">
        <span>{formatDate(d.date)}</span>
        <Money amount={Number(d.usd)} currency="USD" />
        <span className="conversions__rate">
          {d.effective_rate ? `${formatNumber(Number(d.effective_rate), 4)} USD/EUR` : "no rate"}
        </span>
        {d.fallback_to_ecb && (
          <Link className="conversions__badge" to="/diagnostics">
            ECB fallback: <Money amount={Number(d.fallback_usd)} currency="USD" />
          </Link>
        )}
      </div>
      <ul className="conversions__slices">
        {d.matched.map((s) => (
          <li key={`${s.conversion_id}-${s.usd}`}>
            Conversion #{s.conversion_id}: <Money amount={Number(s.usd)} currency="USD" /> for{" "}
            <Money amount={Number(s.eur)} currency="EUR" />
          </li>
        ))}
      </ul>
    </li>
  );
}

export function CurrencyConversions() {
  const list = useFxConversions();
  const pool = useFxPool();
  const del = useDeleteConversion();
  const { toast } = useToast();
  const [dialog, setDialog] = useState<{ editing: FxConversion | null } | null>(null);
  const [confirm, setConfirm] = useState<FxConversion | null>(null);

  const remainingById = new Map((pool.data?.remaining ?? []).map((r) => [r.conversion_id, r]));

  const columns: Column<FxConversion>[] = [
    { key: "date", header: "Date", primary: true, cell: (r) => formatDate(r.date), sortValue: (r) => r.date },
    {
      key: "eur",
      header: "EUR sent",
      align: "right",
      cell: (r) => <Money amount={Number(r.eur_sent)} currency="EUR" />,
      sortValue: (r) => Number(r.eur_sent),
    },
    {
      key: "usd",
      header: "USD received",
      align: "right",
      cell: (r) => <Money amount={Number(r.usd_received)} currency="USD" />,
      sortValue: (r) => Number(r.usd_received),
    },
    {
      key: "rate",
      header: "Effective rate",
      align: "right",
      cell: (r) => formatNumber(Number(r.effective_rate), 4),
      sortValue: (r) => Number(r.effective_rate),
    },
    {
      key: "fees",
      header: "Fees",
      align: "right",
      cell: (r) => (r.fees_eur ? <Money amount={Number(r.fees_eur)} currency="EUR" /> : "–"),
    },
    {
      key: "left",
      header: "Remaining in pool",
      align: "right",
      cell: (r) => {
        const rem = remainingById.get(r.id);
        return rem ? <Money amount={Number(rem.usd)} currency="USD" /> : "–";
      },
    },
    { key: "note", header: "Note", cell: (r) => r.note ?? "" },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (r) => (
        <Menu
          trigger={<IconButton label={`Actions for conversion ${r.id}`} size="sm" icon={<MoreHorizontal aria-hidden />} />}
          items={[
            { label: "Edit", icon: <Pencil aria-hidden />, onSelect: () => setDialog({ editing: r }) },
            { label: "Delete", icon: <Trash2 aria-hidden />, danger: true, onSelect: () => setConfirm(r) },
          ]}
        />
      ),
    },
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

      {list.isError ? (
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
              columns={columns}
              rows={list.data}
              rowKey={(r) => String(r.id)}
              defaultSort={{ key: "date", direction: "desc" }}
            />
          </Card>
          <Card title="Deposit matching" subtitle="Any uncovered part uses the ECB rate.">
            {pool.isError ? (
              <ErrorState onRetry={() => void pool.refetch()} />
            ) : pool.isPending ? (
              <Skeleton height="120px" />
            ) : pool.data.deposits.length === 0 ? (
              <p className="conversions__muted">No USD deposits to match yet.</p>
            ) : (
              <ul className="conversions__matches">
                {pool.data.deposits.map((d) => (
                  <MatchRow key={d.transaction_id} d={d} />
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      {dialog && (
        <ConversionDialog
          key={dialog.editing?.id ?? "new"}
          open
          editing={dialog.editing}
          onOpenChange={(o) => !o && setDialog(null)}
        />
      )}
      <Dialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Delete conversion"
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
