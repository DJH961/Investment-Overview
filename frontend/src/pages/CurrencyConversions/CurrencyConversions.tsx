import { Coins, Copy, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
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
import { formatDate, formatNumber, getFormatPrefs, todayIn } from "../../lib/format";
import { parseDecimal, toApiDecimal } from "../../lib/parseDecimal";
import { usePersistentState } from "../../lib/usePersistentState";
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
import { offEcbText, trimDecimal, weekdayDate } from "./matching";
import { ConversionHead, ConversionRow } from "./ConversionRow";
import { SettleSheet } from "../../components/SettleSheet";
import { useEstimateQueue } from "../Transactions/EstChip";
import { DepositRow } from "./DepositRow";
import { activeCount, FilterBar, NO_FILTERS, PROVIDER_FILTER_OPTIONS, ToggleChip, type ConversionFilters } from "./Filters";
import { Fold } from "./Fold";
import {
  buildSections,
  groupByMonth,
  inPeriod,
  monthLabel,
  newestMonths,
  PERIOD_ALL,
  periodOptions,
  validPeriod,
  type MonthGroup,
} from "./grouping";
import { PinDialog } from "./PinDialog";
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

const FOLDS_KEY = "conversions.folds";
const isFolds = (v: unknown): v is Record<string, boolean> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "boolean");

type Folds = Record<string, boolean>;

/**
 * Month folds (and year folds for years before this one) around any dated list. Only the
 * open groups render their rows. `prefix` keeps the remembered open/closed state of the
 * conversions and of the deposits apart.
 */
function FoldedList<T>({
  prefix,
  items,
  dateOf,
  thisYear,
  filtered,
  folds,
  setFolds,
  meta,
  children,
}: {
  prefix: string;
  items: readonly T[];
  dateOf: (item: T) => string;
  thisYear: string;
  /** While a filter is on, every group opens so the matches are all in view. */
  filtered: boolean;
  folds: Folds;
  setFolds: (update: (prev: Folds) => Folds) => void;
  meta: (items: readonly T[]) => ReactNode;
  children: (items: readonly T[]) => ReactNode;
}) {
  const groups = groupByMonth(items, dateOf);
  const sections = buildSections(groups, thisYear);
  const recent = newestMonths(groups.map((g) => g.key));
  const isOpen = (key: string, fallback: boolean) => folds[key] ?? (filtered ? true : fallback);
  const toggle = (key: string, now: boolean) => setFolds((prev) => ({ ...prev, [key]: !now }));
  const month = (g: MonthGroup<T>, nested = false) => {
    const key = `${prefix}:${g.key}`;
    const open = isOpen(key, recent.has(g.key));
    return (
      <Fold
        key={key}
        nested={nested}
        open={open}
        onToggle={() => toggle(key, open)}
        title={monthLabel(g.key)}
        meta={meta(g.items)}
      >
        {children(g.items)}
      </Fold>
    );
  };
  return (
    <div className="conversions__folds">
      {sections.map((s) => {
        if (s.kind === "month") return month(s.group);
        const key = `${prefix}:y${s.block.year}`;
        const open = isOpen(key, s.block.months.some((g) => recent.has(g.key)));
        return (
          <Fold
            key={key}
            open={open}
            onToggle={() => toggle(key, open)}
            title={s.block.year}
            meta={meta(s.block.months.flatMap((g) => g.items))}
          >
            {s.block.months.map((g) => month(g, true))}
          </Fold>
        );
      })}
    </div>
  );
}

const sumOf = (rows: readonly FxConversion[], pick: (c: FxConversion) => string) =>
  rows.reduce((total, c) => total + Number(pick(c)), 0);

export function CurrencyConversions() {
  const list = useFxConversions();
  const pool = useFxPool();
  const est = useEstimateQueue("fx_conversion");
  const del = useDeleteConversion();
  const { toast } = useToast();
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [dialog, setDialog] = useState<{ editing: FxConversion | null; prefill?: Partial<FormState> } | null>(null);
  const [confirm, setConfirm] = useState<FxConversion | null>(null);
  const [pinning, setPinning] = useState<DepositMatch | null>(null);
  const [folds, setFolds] = usePersistentState<Folds>(FOLDS_KEY, {}, isFolds);
  const [openDeposits, setOpenDeposits] = useState<ReadonlySet<number>>(new Set());
  const [pending, setPending] = useState<string | null>(null);

  const today = todayIn(getFormatPrefs().timeZone);
  const conversions = list.data ?? [];
  const deposits = pool.data?.deposits ?? [];
  const byId = new Map(conversions.map((c) => [c.id, c]));
  const periods = periodOptions([...conversions.map((c) => c.date), ...deposits.map((d) => d.date)], today);

  // The filters live in the address (?period=&provider=&pool=1&needs=1) so a view can be linked.
  const providerParam = params.get("provider");
  const filters: ConversionFilters = {
    period: validPeriod(params.get("period"), periods),
    provider: PROVIDER_FILTER_OPTIONS.some((o) => o.value === providerParam) ? (providerParam as string) : "all",
    pool: params.get("pool") === "1",
  };
  const needs = params.get("needs") === "1";
  const writeParams = (next: ConversionFilters, nextNeeds: boolean) => {
    const out = new URLSearchParams();
    if (next.period !== PERIOD_ALL) out.set("period", next.period);
    if (next.provider !== "all") out.set("provider", next.provider);
    if (next.pool) out.set("pool", "1");
    if (nextNeeds) out.set("needs", "1");
    setParams(out, { replace: true });
  };

  const shownConversions = conversions.filter(
    (c) =>
      inPeriod(c.date, filters.period, today) &&
      (filters.provider === "all" || c.provider === filters.provider) &&
      (!filters.pool || Number(c.remaining_usd) > 0.005),
  );
  const shownDeposits = deposits.filter(
    (d) => inPeriod(d.date, filters.period, today) && (!needs || d.status !== "matched"),
  );
  const conversionsFiltered = activeCount(filters) > 0;
  const depositsFiltered = filters.period !== PERIOD_ALL || needs;

  // Follow a #conversion-<id> / #deposit-<id> link: show the row (clearing filters that hide it,
  // opening its folds), then scroll to it.
  const ready = Boolean(list.data && pool.data);
  const latest = useRef({ byId, deposits, shownConversions, shownDeposits });
  useEffect(() => {
    latest.current = { byId, deposits, shownConversions, shownDeposits };
  });
  useEffect(() => {
    const id = location.hash.slice(1);
    const m = /^(conversion|deposit)-(\d+)$/.exec(id);
    if (!ready || !m) return;
    // Next frame: the lists are on screen, and state is set from the callback, not the effect body.
    const frame = requestAnimationFrame(() => {
      const cur = latest.current;
      const n = Number(m[2]);
      const isConversion = m[1] === "conversion";
      const item = isConversion ? cur.byId.get(n) : cur.deposits.find((d) => d.transaction_id === n);
      if (!item) return;
      const visible = isConversion
        ? cur.shownConversions.includes(item as FxConversion)
        : cur.shownDeposits.includes(item as DepositMatch);
      if (!visible) {
        navigate({ search: "", hash: location.hash }, { replace: true });
        return;
      }
      const month = item.date.slice(0, 7);
      const prefix = isConversion ? "c" : "d";
      setFolds((prev) => ({ ...prev, [`${prefix}:${month}`]: true, [`${prefix}:y${month.slice(0, 4)}`]: true }));
      if (!isConversion) setOpenDeposits((prev) => new Set(prev).add(n));
      setPending(id);
    });
    return () => cancelAnimationFrame(frame);
  }, [location.hash, location.key, ready, navigate, setFolds]);
  useEffect(() => {
    if (!pending) return;
    const frame = requestAnimationFrame(() => {
      const el = document.getElementById(pending);
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.classList.add("conversions__target");
        window.setTimeout(() => el.classList.remove("conversions__target"), 1800);
      }
      setPending(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [pending]);

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
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  return (
    <div className="conversions">
      <SettleSheet rows={est.queue} onClose={est.close} />
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
                value: conversions.length,
                note: (
                  <>
                    <Money amount={sumOf(conversions, (c) => c.eur_sent)} currency="EUR" digits={0} /> sent
                  </>
                ),
              },
              {
                key: "ecb",
                label: "On the ECB rate",
                tip: "Deposits that use the ECB rate for all or part of their dollars, because no conversion of yours covers them.",
                value: pool.data ? deposits.filter((d) => d.status !== "matched").length : "–",
                note: pool.data ? `of ${deposits.length} deposits` : undefined,
              },
            ]}
          />
          <Card title="Conversions" flush>
            <div className="conversions__toolbar">
              <FilterBar
                value={filters}
                onChange={(next) => writeParams(next, needs)}
                periods={periods}
                shown={shownConversions.length}
                total={conversions.length}
              />
            </div>
          </Card>
          {shownConversions.length === 0 ? (
            <Card flush>
              <p className="conversions__muted conversions__empty">No conversion matches these filters.</p>
            </Card>
          ) : (
                <FoldedList
                  prefix="c"
                  items={shownConversions}
                  dateOf={(c) => c.date}
                  thisYear={today.slice(0, 4)}
                  filtered={conversionsFiltered}
                  folds={folds}
                  setFolds={setFolds}
                  meta={(rows) => (
                    <>
                      {plural(rows.length, "conversion", "conversions")} ·{" "}
                      <Money amount={sumOf(rows, (c) => c.eur_sent)} currency="EUR" digits={0} /> →{" "}
                      <Money amount={sumOf(rows, (c) => c.usd_received)} currency="USD" digits={0} />
                    </>
                  )}
                >
                  {(rows) => (
                    <>
                      <ConversionHead />
                      <ul className="conversions__list" aria-label="Currency conversions">
                        {rows.map((c) => (
                          <ConversionRow key={c.id} c={c} menu={menuFor(c)} onSettle={() => est.open(c.id)} />
                        ))}
                      </ul>
                    </>
                  )}
                </FoldedList>
          )}
          <Card
            title="How each deposit was paid for"
            subtitle="Pinned conversions first, then the oldest conversions first, then the ECB rate for the rest."
            flush
          >
            {deposits.length > 0 && (
              <div className="conversions__toolbar conversions__toolbar--deposits">
                <ToggleChip pressed={needs} onPressedChange={(on) => writeParams(filters, on)}>
                  Needs attention
                </ToggleChip>
                <p className="filter-bar__count">
                  {depositsFiltered
                    ? `Showing ${shownDeposits.length} of ${deposits.length}`
                    : plural(deposits.length, "deposit", "deposits")}
                  {depositsFiltered && (
                    <>
                      {" · "}
                      <button type="button" className="filter-bar__clear" onClick={() => writeParams(NO_FILTERS, false)}>
                        Clear filters
                      </button>
                    </>
                  )}
                </p>
              </div>
            )}
          </Card>
          {pool.isError && !pool.data ? (
            <ErrorState onRetry={() => void pool.refetch()} />
          ) : pool.isPending ? (
            <Skeleton height="120px" />
          ) : deposits.length === 0 ? (
            <Card flush>
              <p className="conversions__muted conversions__empty">No USD deposits to match yet.</p>
            </Card>
          ) : shownDeposits.length === 0 ? (
            <Card flush>
              <p className="conversions__muted conversions__empty">No deposit matches these filters.</p>
            </Card>
          ) : (
            <FoldedList
              prefix="d"
              items={shownDeposits}
              dateOf={(d) => d.date}
              thisYear={today.slice(0, 4)}
              filtered={depositsFiltered}
              folds={folds}
              setFolds={setFolds}
              meta={(rows) => {
                const attention = rows.filter((d) => d.status !== "matched").length;
                return (
                  <>
                    {plural(rows.length, "deposit", "deposits")} ·{" "}
                    <Money amount={rows.reduce((t, d) => t + Number(d.usd), 0)} currency="USD" digits={0} />
                    {attention > 0 && ` · ${attention} need attention`}
                  </>
                );
              }}
            >
              {(rows) => (
                <ul className="conversions__deposits" aria-label="Deposits">
                  {rows.map((d) => (
                    <DepositRow
                      key={d.transaction_id}
                      d={d}
                      conversions={byId}
                      open={openDeposits.has(d.transaction_id)}
                      onToggle={() =>
                        setOpenDeposits((prev) => {
                          const next = new Set(prev);
                          if (!next.delete(d.transaction_id)) next.add(d.transaction_id);
                          return next;
                        })
                      }
                      onAdd={(m) => setDialog({ editing: null, prefill: { date: m.date, usd: m.fallback_usd ?? "" } })}
                      onPin={setPinning}
                    />
                  ))}
                </ul>
              )}
            </FoldedList>
          )}
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
