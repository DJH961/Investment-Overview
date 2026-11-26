import { Coins, Copy, FileUp, MoreHorizontal, Pencil, Plus, Trash2, Undo2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { Button, LinkButton } from "../../components/Button";
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
import { SegmentedControl } from "../../components/SegmentedControl";
import { Select } from "../../components/Select";
import { Skeleton } from "../../components/Skeleton";
import { StatStrip } from "../../components/StatStrip";
import { useToast } from "../../components/Toast";
import { ApiError } from "../../lib/api";
import { formatDate, formatMoney, formatNumber, getFormatPrefs, todayIn } from "../../lib/format";
import { toApiDecimal } from "../../lib/parseDecimal";
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
import { costStatItems, PeriodRate, useCostsAll } from "./CostBits";
import { ConversionHead, ConversionRow, directionOf } from "./ConversionRow";
import { BackFundingRow, backStatItems } from "./BackToEuros";
import { useJourney } from "../../lib/queries/journey";
import { SettleSheet } from "../../components/SettleSheet";
import { useEstimateQueue } from "../Transactions/EstChip";
import { DepositRow } from "./DepositRow";
import { activeCount, DIRECTION_FILTER_OPTIONS, FilterBar, NO_FILTERS, PROVIDER_FILTER_OPTIONS, ToggleChip, type ConversionFilters, type DirectionFilter } from "./Filters";
import { Fold } from "./Fold";
import {
  groupByYear,
  inPeriod,
  PERIOD_ALL,
  periodOptions,
  validPeriod,
} from "./grouping";
import { PinDialog } from "./PinDialog";
import "./CurrencyConversions.scss";

interface FormState {
  date: string;
  eur: string;
  usd: string;
  fees: string;
  /** Dollars kept in the USD account, not sent on to the broker ("" = none). */
  kept: string;
  note: string;
  /** "" = not set. */
  provider: FxProvider | "";
}

const EMPTY: FormState = { date: "", eur: "", usd: "", fees: "", kept: "", note: "", provider: "" };

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
    kept: Number(c.kept_usd) > 0 ? trimDecimal(c.kept_usd) : "",
    note: c.note ?? "",
    provider: c.provider ?? "",
  };
}

/** Duplicate: every figure carried over, the date left empty for the new day. */
function duplicateOf(c: FxConversion): Partial<FormState> {
  return { ...fromConversion(c), date: "" };
}

type ConversionDirection = "to_usd" | "to_eur";

const DIRECTION_OPTIONS: { value: ConversionDirection; label: string }[] = [
  { value: "to_usd", label: "EUR \u2192 USD" },
  { value: "to_eur", label: "USD \u2192 EUR" },
];

type EurFeeMode = "excluding" | "including";

const EUR_FEE_MODE_OPTIONS: { value: EurFeeMode; label: string }[] = [
  { value: "excluding", label: "Excluding fees" },
  { value: "including", label: "Including fees" },
];

function decimalScale(a: string, b: string): number {
  const fracLen = (s: string) => (s.includes(".") ? s.split(".")[1].length : 0);
  return Math.max(2, fracLen(a), fracLen(b));
}

function parseScaledDecimal(canonical: string, scale: number): bigint {
  const [wholeRaw, fracRaw = ""] = canonical.split(".");
  const whole = wholeRaw || "0";
  const frac = fracRaw.padEnd(scale, "0").slice(0, scale);
  return BigInt(`${whole}${frac}`);
}

function formatScaledDecimal(units: bigint, scale: number): string {
  const sign = units < 0n ? "-" : "";
  const abs = units < 0n ? -units : units;
  const digits = abs.toString().padStart(scale + 1, "0");
  return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

/** Exact decimal addition `a + b` via scaled BigInt (at least 2 fractional digits). */
function addDecimals(a: string, b: string): string {
  const scale = decimalScale(a, b);
  return formatScaledDecimal(parseScaledDecimal(a, scale) + parseScaledDecimal(b, scale), scale);
}

/** Exact decimal subtraction `a - b` via scaled BigInt (at least 2 fractional digits). */
function subtractDecimals(a: string, b: string): string {
  const scale = decimalScale(a, b);
  return formatScaledDecimal(parseScaledDecimal(a, scale) - parseScaledDecimal(b, scale), scale);
}

/** Compare two canonical non-negative decimal strings: >0 if a > b, 0 if equal, <0 if a < b. */
function compareDecimals(a: string, b: string): number {
  const scale = decimalScale(a, b);
  const da = parseScaledDecimal(a, scale);
  const db = parseScaledDecimal(b, scale);
  return da > db ? 1 : da < db ? -1 : 0;
}

interface EurPreview {
  convertedEur: string | null;
  totalPaidEur: string | null;
  hasFees: boolean;
  feesTooLarge: boolean;
  convertedRate: number | null;
  allInRate: number | null;
}

function computeEurPreview(form: FormState, feeMode: EurFeeMode): EurPreview {
  const eurDec = toApiDecimal(form.eur);
  const usdDec = toApiDecimal(form.usd);
  const feesDec = form.fees.trim() === "" ? "0" : toApiDecimal(form.fees);

  const eurValid = eurDec !== null && !eurDec.startsWith("-") && Number(eurDec) > 0;
  const usdValid = usdDec !== null && !usdDec.startsWith("-") && Number(usdDec) > 0;
  const feesValid = feesDec !== null && !feesDec.startsWith("-") && Number(feesDec) >= 0;
  const hasFees = feesValid && Number(feesDec) > 0;

  if (!eurValid || !feesValid) {
    return {
      convertedEur: null,
      totalPaidEur: null,
      hasFees,
      feesTooLarge: false,
      convertedRate: null,
      allInRate: null,
    };
  }

  let convertedEur: string | null;
  let totalPaidEur: string;
  let feesTooLarge = false;

  if (feeMode === "excluding") {
    convertedEur = eurDec;
    totalPaidEur = hasFees ? addDecimals(eurDec, feesDec) : eurDec;
  } else {
    feesTooLarge = compareDecimals(eurDec, feesDec) <= 0;
    convertedEur = feesTooLarge ? null : subtractDecimals(eurDec, feesDec);
    totalPaidEur = eurDec;
  }

  const usdNum = usdValid ? Number(usdDec) : null;
  const convertedNum = convertedEur !== null ? Number(convertedEur) : null;
  const totalNum = Number(totalPaidEur);
  const convertedRate = usdNum !== null && convertedNum !== null && convertedNum > 0 ? usdNum / convertedNum : null;
  const allInRate = usdNum !== null && convertedEur !== null && totalNum > 0 ? usdNum / totalNum : null;

  return {
    convertedEur,
    totalPaidEur,
    hasFees,
    feesTooLarge,
    convertedRate,
    allInRate,
  };
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
  const [feeMode, setFeeMode] = useState<EurFeeMode>("excluding");
  const [direction, setDirection] = useState<ConversionDirection>(
    editing?.from_ccy === "USD" && editing?.to_ccy === "EUR" ? "to_eur" : "to_usd",
  );
  const back = direction === "to_eur";
  const [error, setError] = useState<string | null>(null);
  const reference = useFxReference(form.date);
  const preview = computeEurPreview(form, back ? "excluding" : feeMode);
  const ecb = reference.data?.published && reference.data.ecb_rate ? Number(reference.data.ecb_rate) : null;
  const usedBy = editing?.used_by.length ?? 0;
  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) =>
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
    if (form.fees.trim() !== "" && (fees === null || fees.startsWith("-") || Number(fees) < 0)) {
      setError("Fees must be a number, like 2,50 or 2.50.");
      return;
    }
    if (!back && feeMode === "including" && fees !== null && compareDecimals(eur, fees) <= 0) {
      setError("Fees must be less than the total EUR paid.");
      return;
    }
    const eurSent = !back && feeMode === "including" && fees !== null && Number(fees) > 0 ? subtractDecimals(eur, fees) : eur;
    if (back && fees !== null && compareDecimals(eur, fees) <= 0) {
      setError("Fees must be less than the EUR received.");
      return;
    }
    const kept = back || form.kept.trim() === "" ? "0" : toApiDecimal(form.kept);
    if (kept === null || Number(kept) < 0 || Number(kept) > Number(usd)) {
      setError("Kept dollars must be between 0 and the USD received.");
      return;
    }
    setError(null);
    save.mutate(
      {
        id: editing?.id,
        body: {
          date: form.date,
          eur_sent: eurSent,
          usd_received: usd,
          fees_eur: fees,
          kept_usd: kept,
          note: form.note || null,
          provider: form.provider || null,
          // to_eur rows store eur_sent = euros received, usd_received = dollars sent.
          from_ccy: back ? "USD" : "EUR",
          to_ccy: back ? "EUR" : "USD",
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
      description={
        back
          ? "Record dollars you converted back to euros (Wise, Revolut, your bank). Fees are taken out of the euros received."
          : "Record a real EUR to USD exchange (Wise, Revolut, your bank). EUR returns use the rate you actually got."
      }
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
        {!editing && (
          <div className="conversion-form__mode">
            <span className="conversion-form__mode-label">Direction</span>
            <SegmentedControl<ConversionDirection>
              size="sm"
              ariaLabel="Conversion direction"
              options={DIRECTION_OPTIONS}
              value={direction}
              onChange={(next) => {
                setDirection(next);
                setError(null);
              }}
            />
          </div>
        )}
        <Field label="Date">{(c) => <Input {...c} type="date" value={form.date} onChange={set("date")} />}</Field>
        {back ? (
          <>
            <Field label="USD sent">
              {(c) => <Input {...c} inputMode="decimal" value={form.usd} onChange={set("usd")} />}
            </Field>
            <Field label="EUR received (before fees)">
              {(c) => <Input {...c} inputMode="decimal" value={form.eur} onChange={set("eur")} />}
            </Field>
          </>
        ) : (
        <>
        <div className="conversion-form__eur-group">
          <div className="conversion-form__mode">
            <span className="conversion-form__mode-label">EUR amount is</span>
            <SegmentedControl<EurFeeMode>
              size="sm"
              ariaLabel="EUR amount mode"
              options={EUR_FEE_MODE_OPTIONS}
              value={feeMode}
              onChange={(next) => {
                setFeeMode(next);
                setError(null);
              }}
            />
          </div>
          <Field
            label={feeMode === "excluding" ? "EUR sent" : "Total EUR paid (incl. fees)"}
            hint={feeMode === "including" ? "Fees are subtracted to store the EUR converted." : undefined}
          >
            {(c) => <Input {...c} inputMode="decimal" value={form.eur} onChange={set("eur")} />}
          </Field>
        </div>
        <Field label="USD received">
          {(c) => <Input {...c} inputMode="decimal" value={form.usd} onChange={set("usd")} />}
        </Field>
        </>
        )}
        <Field label="Fees (EUR, optional)">
          {(c) => <Input {...c} inputMode="decimal" value={form.fees} onChange={set("fees")} />}
        </Field>
        {!back && (
          <Field label="Kept in your USD account (optional)" hint="Dollars you did not send on to the broker.">
            {(c) => <Input {...c} inputMode="decimal" value={form.kept} onChange={set("kept")} />}
          </Field>
        )}
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
        {!back && feeMode === "including" && (preview.convertedEur !== null || preview.feesTooLarge) && (
          <p className="conversion-form__rate" data-testid="eur-breakdown">
            {preview.feesTooLarge ? (
              <>
                Converted EUR: <strong>–</strong> (fees must be less than total paid)
              </>
            ) : (
              <>
                Converted EUR: <strong>{formatMoney(Number(preview.convertedEur), "EUR")}</strong>
                {preview.hasFees ? " (excl. fees)" : ""}
              </>
            )}
          </p>
        )}
        {!back && feeMode === "excluding" && preview.hasFees && preview.totalPaidEur !== null && (
          <p className="conversion-form__rate" data-testid="eur-breakdown">
            Total paid (incl. fees): <strong>{formatMoney(Number(preview.totalPaidEur), "EUR")}</strong>
          </p>
        )}
        {back && (
          <p className="conversion-form__rate" data-testid="rate-line">
            Effective rate: <strong>{preview.convertedRate !== null ? formatNumber(preview.convertedRate, 4) : "\u2013"}</strong> USD
            per EUR
          </p>
        )}
        {!back && (<p className="conversion-form__rate" data-testid="rate-line">
          {preview.hasFees && preview.convertedRate !== null && preview.allInRate !== null ? (
            <>
              Converted rate: <strong>{formatNumber(preview.convertedRate, 4)}</strong> · All-in rate:{" "}
              <strong>{formatNumber(preview.allInRate, 4)}</strong> USD per EUR
            </>
          ) : (
            <>
              Effective rate: <strong>{preview.convertedRate !== null ? formatNumber(preview.convertedRate, 4) : "–"}</strong> USD
              per EUR
            </>
          )}
        </p>)}
        {/^\d{4}-\d{2}-\d{2}$/.test(form.date) && reference.data && (
          <p className="conversion-form__rate" data-testid="ecb-line">
            {ecb !== null
              ? [
                  reference.data.ecb_rate_date && reference.data.ecb_rate_date !== form.date
                    ? `ECB ${formatNumber(ecb, 4)} (${weekdayDate(reference.data.ecb_rate_date)}, the last fixing before this day)`
                    : `ECB on ${formatDate(form.date)}: ${formatNumber(ecb, 4)}`,
                  offEcbText(back ? preview.convertedRate : preview.allInRate, ecb),
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
 * One fold per year (the running year included, open at first) around any dated list. Only
 * open years render their rows. `prefix` keeps the remembered open/closed state of the
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
  const blocks = groupByYear(items, dateOf);
  return (
    <div className="conversions__folds">
      {blocks.map((b) => {
        const key = `${prefix}:y${b.year}`;
        const open = folds[key] ?? (filtered ? true : b.year >= thisYear);
        return (
          <Fold
            key={key}
            open={open}
            onToggle={() => setFolds((prev) => ({ ...prev, [key]: !open }))}
            title={b.year}
            meta={meta(b.items)}
          >
            {children(b.items)}
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
  const costs = useCostsAll();
  // 7.4: cash-outs (conversions back to euros) and their results, from the journey (euro view).
  const journey = useJourney("EUR");
  const cashOuts = new Map((journey.data?.cash_outs ?? []).map((o) => [o.conversion_id, o]));
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
    direction: DIRECTION_FILTER_OPTIONS.some((o) => o.value === params.get("direction")) ? (params.get("direction") as DirectionFilter) : "all",
  };
  const needs = params.get("needs") === "1";
  const writeParams = (next: ConversionFilters, nextNeeds: boolean) => {
    const out = new URLSearchParams();
    if (next.period !== PERIOD_ALL) out.set("period", next.period);
    if (next.provider !== "all") out.set("provider", next.provider);
    if (next.pool) out.set("pool", "1");
    if (next.direction !== "all") out.set("direction", next.direction);
    if (nextNeeds) out.set("needs", "1");
    setParams(out, { replace: true });
  };

  const shownConversions = conversions.filter(
    (c) =>
      inPeriod(c.date, filters.period, today) &&
      (filters.provider === "all" || c.provider === filters.provider) &&
      (!filters.pool || Number(c.remaining_usd) > 0.005) &&
      (filters.direction === "all" || directionOf(c) === filters.direction),
  );
  const toUsd = conversions.filter((c) => directionOf(c) === "to_usd");
  const backs = conversions.filter((c) => directionOf(c) === "to_eur");
  const shownDeposits = deposits.filter(
    (d) => inPeriod(d.date, filters.period, today) && (!needs || (d.status !== "matched" && d.status !== "received_usd")),
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
      const prefix = isConversion ? "c" : "d";
      setFolds((prev) => ({ ...prev, [`${prefix}:y${item.date.slice(0, 4)}`]: true }));
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
    <Button leftIcon={<Plus aria-hidden />} aria-label="Add conversion" onClick={() => setDialog({ editing: null })}>
      <span className="conversions__label--long">Add conversion</span>
      <span className="conversions__label--short">Add</span>
    </Button>
  );
  // The Wise statement import lives on the Import page; this goes straight to it.
  const importButton = (
    <LinkButton
      variant="secondary"
      leftIcon={<FileUp aria-hidden />}
      to={{ pathname: "/import", hash: "#wise-statement" }}
      aria-label="Import statement"
    >
      <span className="conversions__label--long">Import statement</span>
      <span className="conversions__label--short">Import</span>
    </LinkButton>
  );
  const cashOutButton = (
    <LinkButton variant="secondary" leftIcon={<Undo2 aria-hidden />} to="/cash-out" aria-label="Cash out to euros">
      <span className="conversions__label--long">Cash out</span>
      <span className="conversions__label--short">Cash out</span>
    </LinkButton>
  );
  const actions = (
    <div className="conversions__actions">
      {cashOutButton}
      {importButton}
      {addButton}
    </div>
  );
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  return (
    <div className="conversions">
      <SettleSheet rows={est.queue} onClose={est.close} />
      <PageHeader
        title="Currency conversions"
        subtitle="What your conversions really cost, both ways, and which one paid for each deposit."
        actions={actions}
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
          action={actions}
        />
      ) : (
        <>
          <StatStrip
            label="Conversions at a glance"
            six
            eight
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
                value: toUsd.length,
                note: (
                  <>
                    <Money amount={sumOf(toUsd, (c) => c.eur_sent)} currency="EUR" digits={0} /> sent
                  </>
                ),
              },
              {
                key: "ecb",
                label: "On the ECB rate",
                tip: "Deposits that use the ECB rate for all or part of their dollars, because no conversion of yours covers them.",
                value: pool.data ? deposits.filter((d) => d.status !== "matched" && d.status !== "received_usd").length : "–",
                note: pool.data ? `of ${deposits.length} deposits` : undefined,
              },
              ...costStatItems(costs),
              ...backStatItems(journey.data?.back_in_euros ?? null),
            ]}
          />
          <Card title="Conversions" flush>
            <div className="conversions__toolbar">
              <FilterBar
                value={filters}
                onChange={(next) => writeParams(next, needs)}
                periods={periods}
                directions={backs.length > 0}
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
                      <PeriodRate rows={rows} costs={costs} filtered={conversionsFiltered} />
                    </>
                  )}
                >
                  {(rows) => (
                    <>
                      <ConversionHead />
                      <ul className="conversions__list" aria-label="Currency conversions">
                        {rows.map((c) => (
                          <ConversionRow key={c.id} c={c} menu={menuFor(c)} onSettle={() => est.open(c.id)} cashOut={cashOuts.get(c.id) ?? null} initialTrail={params.get("trail") === String(c.id)} />
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
                const attention = rows.filter((d) => d.status !== "matched" && d.status !== "received_usd").length;
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
          {backs.length > 0 && (
            <Card
              title="How each conversion back was funded"
              subtitle="Withdrawals pinned to a conversion first, then the oldest withdrawals, then the rest of the USD account at what it cost."
              flush
            >
              <ul className="conversions__backs" aria-label="Conversions back to euros">
                {backs.map((c) => (
                  <BackFundingRow key={c.id} c={c} />
                ))}
              </ul>
            </Card>
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
