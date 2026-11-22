import { Coins, Copy, MoreHorizontal, Pencil, Pin, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Chip } from "../../components/Chip";
import { Dialog } from "../../components/Dialog";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { Field } from "../../components/Field";
import { IconButton } from "../../components/IconButton";
import { Input } from "../../components/Input";
import { Menu } from "../../components/Menu";
import { Money } from "../../components/Money";
import { PageHeader } from "../../components/PageHeader";
import { Select } from "../../components/Select";
import { Skeleton } from "../../components/Skeleton";
import { StatStrip } from "../../components/StatStrip";
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
import {
  ecbCell,
  offEcbText,
  offPctText,
  offPctWords,
  providerLabel,
  trimDecimal,
  weekdayDate,
} from "./matching";
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

function fromConversion(c: FxConversion): FormState {
  return {
    date: c.date,
    eur: trimDecimal(c.eur_sent),
    usd: trimDecimal(c.usd_received),
    fees: trimDecimal(c.fees_eur),
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
      description="Record a real EUR to USD exchange (Wise, Revolut, your bank). EUR returns use the rate you actually got."
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
              ? [
                  reference.data.ecb_rate_date && reference.data.ecb_rate_date !== form.date
                    ? `ECB ${formatNumber(ecb, 4)} (${weekdayDate(reference.data.ecb_rate_date)}, the last fixing before this day)`
                    : `ECB on ${formatDate(form.date)}: ${formatNumber(ecb, 4)}`,
                  offEcbText(typedRate, ecb),
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "No ECB fixing on file for this day yet"}
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

/** One deposit: how much each conversion paid, as a bar of the deposit's dollars. */
function MatchRow({
  d,
  conversions,
  onAdd,
  onPin,
}: {
  d: DepositMatch;
  conversions: ReadonlyMap<number, FxConversion>;
  onAdd: (d: DepositMatch) => void;
  onPin: (d: DepositMatch) => void;
}) {
  const total = Number(d.usd);
  // A bar is this slice's share of the deposit (linear presentation maths on server figures).
  const share = (usd: string) => `${Math.min(100, Math.max(0, total > 0 ? (Number(usd) / total) * 100 : 0))}%`;
  const hasFallback = d.fallback_usd !== null && Number(d.fallback_usd) > 0;
  return (
    <li className="deposit" id={`deposit-${d.transaction_id}`}>
      <div className="deposit__head">
        <div className="deposit__title">
          <span className="deposit__date">{formatDate(d.date)}</span>
          <Money amount={total} currency="USD" className="deposit__usd" />
        </div>
        <StatusChip status={d.status} pinned={d.pinned} />
        <span className="deposit__rate">
          {d.effective_rate ? `Your rate ${formatNumber(Number(d.effective_rate), 4)}` : "No rate for this deposit"}
        </span>
      </div>
      <ul className="deposit__slices">
        {d.slices.map((s) => {
          const c = conversions.get(s.conversion_id);
          return (
            <li key={`${s.conversion_id}-${s.usd}-${s.pinned}`} className="deposit__slice">
              <div className="deposit__slice-top">
                <Link to={{ hash: `#conversion-${s.conversion_id}` }} className="deposit__link">
                  {[formatDate(s.conversion_date), providerLabel(c?.provider), formatNumber(Number(s.rate), 4)]
                    .filter(Boolean)
                    .join(" · ")}
                  {s.pinned && (
                    <span className="deposit__pinned" title="Pinned">
                      <Pin className="deposit__pin" aria-hidden />
                      <span className="deposit__sr">Pinned</span>
                    </span>
                  )}
                </Link>
                <span className="deposit__amounts">
                  <Money amount={Number(s.usd)} currency="USD" /> for <Money amount={Number(s.eur)} currency="EUR" />
                </span>
              </div>
              <span className="deposit__bar" aria-hidden>
                <span className="deposit__fill" style={{ width: share(s.usd) }} />
              </span>
            </li>
          );
        })}
        {hasFallback && (
          <li className="deposit__slice">
            <div className="deposit__slice-top">
              <span className="deposit__ecb">
                ECB rate{d.fallback_rate_date ? ` of ${formatDate(d.fallback_rate_date)}` : ""}
                {d.fallback_rate ? ` · ${formatNumber(Number(d.fallback_rate), 4)}` : ""}
              </span>
              <span className="deposit__amounts">
                <Money amount={Number(d.fallback_usd)} currency="USD" />
                {d.fallback_eur ? (
                  <>
                    {" "}
                    for <Money amount={Number(d.fallback_eur)} currency="EUR" />
                  </>
                ) : null}
              </span>
            </div>
            <span className="deposit__bar" aria-hidden>
              <span className="deposit__fill deposit__fill--ecb" style={{ width: share(d.fallback_usd as string) }} />
            </span>
          </li>
        )}
      </ul>
      <div className="deposit__actions">
        {d.status !== "matched" && (
          <Button size="sm" variant="secondary" onClick={() => onAdd(d)}>
            Add the conversion
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={() => onPin(d)}>
          {d.pinned ? "Change pin…" : "Pin a conversion…"}
        </Button>
      </div>
    </li>
  );
}

/** One conversion: the dollars are the hero, the rate facts and the deposits it paid for sit quietly around. */
function ConversionRow({ c, menu }: { c: FxConversion; menu: React.ReactNode }) {
  const e = ecbCell(c);
  const n = c.used_by.length;
  const left = Number(c.remaining_usd);
  const fees = c.fees_eur && Number(c.fees_eur) > 0 ? Number(c.fees_eur) : 0;
  const allIn = Number(c.all_in_rate) !== Number(c.rate);
  return (
    <li className="conv" id={`conversion-${c.id}`}>
      <div className="conv__id">
        <span className="conv__date">{formatDate(c.date)}</span>
        {c.provider && (
          <Chip size="sm" outline>
            {providerLabel(c.provider)}
          </Chip>
        )}
      </div>
      <div className="conv__hero">
        <Money amount={Number(c.usd_received)} currency="USD" className="conv__usd" />
        <span className="conv__sent">
          from <Money amount={Number(c.eur_sent)} currency="EUR" />
          {fees > 0 && (
            <>
              {" "}
              + <Money amount={fees} currency="EUR" /> fees
            </>
          )}
        </span>
      </div>
      <dl className="conv__facts">
        <div className="conv__fact">
          <dt>Rate</dt>
          <dd>
            {formatNumber(Number(c.rate), 4)}
            {allIn && <span className="conv__sub">all-in {formatNumber(Number(c.all_in_rate), 4)}</span>}
          </dd>
        </div>
        <div className="conv__fact" title={e.title}>
          <dt>ECB that day</dt>
          <dd>
            {e.text}
            {e.from && <span className="conv__sub">{e.from}</span>}
          </dd>
        </div>
        <div className="conv__fact" title={offPctWords(c.off_pct) ?? undefined}>
          <dt>vs ECB</dt>
          <dd>{offPctText(c.off_pct)}</dd>
        </div>
      </dl>
      <div className="conv__paid">
        <span className="conv__label">Paid for</span>
        <span className="conv__chips">
          {n === 0 ? (
            <Chip size="sm" tone="neutral">
              In the pool
            </Chip>
          ) : (
            c.used_by.slice(0, 2).map((u) => (
              <Link key={`${u.deposit_id}-${u.pinned}`} to={{ hash: `#deposit-${u.deposit_id}` }} className="conv__chip-link">
                <Chip size="sm" outline>
                  {formatDate(u.date)}
                </Chip>
              </Link>
            ))
          )}
          {n > 2 && <span className="conv__sub">+{n - 2} more</span>}
          {n > 0 && left > 0.005 && (
            <span className="conv__sub">
              <Money amount={left} currency="USD" /> left
            </span>
          )}
        </span>
      </div>
      {c.note && (
        <p className="conv__note" title={c.note}>
          {c.note}
        </p>
      )}
      <div className="conv__menu">{menu}</div>
    </li>
  );
}

/** Scroll to (and briefly mark) the element a `#conversion-<id>` / `#deposit-<id>` link points at. */
function useHashTarget(ready: boolean) {
  const location = useLocation();
  useEffect(() => {
    const id = location.hash.slice(1);
    if (!ready || !id) return;
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("conversions__target");
    const timer = window.setTimeout(() => el.classList.remove("conversions__target"), 1800);
    return () => window.clearTimeout(timer);
  }, [location.hash, location.key, ready]);
}

export function CurrencyConversions() {
  const list = useFxConversions();
  const pool = useFxPool();
  const del = useDeleteConversion();
  const { toast } = useToast();
  const [dialog, setDialog] = useState<{ editing: FxConversion | null; prefill?: Partial<FormState> } | null>(null);
  const [confirm, setConfirm] = useState<FxConversion | null>(null);

  useHashTarget(Boolean(list.data && pool.data));
  const [pinning, setPinning] = useState<DepositMatch | null>(null);

  const byId = new Map((list.data ?? []).map((c) => [c.id, c]));
  const menuFor = (r: FxConversion) => (
    <Menu
      trigger={<IconButton label={`Actions for conversion ${r.id}`} icon={<MoreHorizontal aria-hidden />} />}
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
  );

  const addButton = (
    <Button leftIcon={<Plus aria-hidden />} onClick={() => setDialog({ editing: null })}>
      Add conversion
    </Button>
  );

  return (
    <div className="conversions">
      <PageHeader
        title="Currency conversions"
        subtitle="What your EUR to USD conversions really cost, and which one paid for each deposit."
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
          <StatStrip
            label="Conversions at a glance"
            phoneColumns={3}
            items={[
              {
                key: "pool",
                label: "In the pool",
                tip: "Dollars you converted but have not deposited yet, with what they cost in euros.",
                value: <Money amount={pool.data ? Number(pool.data.balance_usd) : null} currency="USD" digits={0} />,
                note: pool.data ? (
                  <>
                    <Money amount={Number(pool.data.balance_eur)} currency="EUR" /> at cost
                  </>
                ) : undefined,
              },
              {
                key: "count",
                label: "Conversions",
                value: list.data.length,
                note: (
                  <>
                    <Money amount={list.data.reduce((sum, c) => sum + Number(c.eur_sent), 0)} currency="EUR" /> sent
                  </>
                ),
              },
              {
                key: "ecb",
                label: "On the ECB rate",
                tip: "Deposits that use the ECB rate for all or part of their dollars, because no conversion of yours covers them.",
                value: pool.data ? pool.data.deposits.filter((d) => d.status !== "matched").length : "–",
                note: pool.data ? `of ${pool.data.deposits.length} deposits` : undefined,
              },
            ]}
          />
          <Card title="Conversions" flush>
            <ul className="conversions__list" aria-label="Currency conversions">
              {list.data.map((c) => (
                <ConversionRow key={c.id} c={c} menu={menuFor(c)} />
              ))}
            </ul>
          </Card>
          <Card
            title="How each deposit was paid for"
            subtitle="Pinned conversions first, then the oldest conversions first, then the ECB rate for the rest."
          >
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
                    conversions={byId}
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
