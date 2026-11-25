import clsx from "clsx";
import { ArrowLeft, Check } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { CashOutCard } from "../../components/CashOutCard";
import { Field } from "../../components/Field";
import { Input } from "../../components/Input";
import { Money } from "../../components/Money";
import { MoneyTrail } from "../../components/MoneyTrail";
import { PageHeader } from "../../components/PageHeader";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Select, type SelectOption } from "../../components/Select";
import { useToast } from "../../components/Toast";
import { formatDate, formatMoney, formatNumber, getFormatPrefs, todayIn } from "../../lib/format";
import type { CashOutOut, TrailStep } from "../../lib/journey-types";
import { useCreateTransaction, type TransactionOut } from "../../lib/queries/ledger";
import { useLedgerAll } from "../../lib/queries/ledgerAll";
import { useCashOutPreview } from "../../lib/queries/journey";
import { useFxReference, useSaveConversion, type FxConversionInput } from "../../lib/queries/manage";
import { parseDecimal } from "../../lib/parseDecimal";
import "./CashOut.scss";

const STEPS = ["Sold", "Withdrawn", "Converted back"] as const;
const PROVIDERS: SelectOption[] = [
  { value: "revolut", label: "Revolut" },
  { value: "wise", label: "Wise" },
  { value: "other", label: "Other" },
];

type SaleMode = "pick" | "enter" | "cash";

interface Form {
  saleMode: SaleMode;
  saleId: string;
  saleDate: string;
  saleUsd: string;
  withdrawalId: string;
  withdrawalDate: string;
  withdrawalUsd: string;
  date: string;
  usdSent: string;
  eurReceived: string;
  feesEur: string;
  provider: string;
}

const num = (v: string) => {
  const p = parseDecimal(v);
  return p === null ? null : Number(p);
};
const abs = (v: string | null | undefined) => Math.abs(Number(v ?? 0));

/** Sales of real holdings (not money-market sweeps) and broker withdrawals, newest first. */
function candidates(rows: readonly TransactionOut[]) {
  const trail = (r: TransactionOut) => (r as TransactionOut & { trail_kind?: string | null }).trail_kind;
  const sells = rows.filter((r) => r.kind === "sell" && r.currency === "USD" && trail(r) !== null && trail(r) !== undefined);
  const withdrawals = rows.filter((r) => r.kind === "withdrawal" && r.currency === "USD");
  const desc = (a: TransactionOut, b: TransactionOut) => b.date.localeCompare(a.date);
  return { sells: [...sells].sort(desc).slice(0, 30), withdrawals: [...withdrawals].sort(desc).slice(0, 30) };
}

/**
 * Cash out to euros (7.4): sold → withdrawn to the USD account → converted back, one step
 * each, like the routine set-up. Each step is prefilled from the one before; the last one
 * checks your rate against the ECB's and ends on the result card, worked out by the server
 * (a preview, nothing saved) until you press Save.
 */
export function CashOut() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const today = todayIn(getFormatPrefs().timeZone);
  const ledger = useLedgerAll();
  const { sells, withdrawals } = useMemo(() => candidates(ledger.data?.rows ?? []), [ledger.data]);
  const fromSell = params.get("sell") ?? "";
  const fromWithdrawal = params.get("withdrawal") ?? "";
  const [step, setStep] = useState(fromWithdrawal ? 2 : fromSell ? 1 : 0);
  const [form, setForm] = useState<Form>(() => ({
    saleMode: fromSell ? "pick" : "pick",
    saleId: fromSell,
    saleDate: today,
    saleUsd: "",
    withdrawalId: fromWithdrawal,
    withdrawalDate: today,
    withdrawalUsd: "",
    date: today,
    usdSent: "",
    eurReceived: "",
    feesEur: "",
    provider: "revolut",
  }));
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const preview = useCashOutPreview();
  const createTxn = useCreateTransaction();
  const saveConversion = useSaveConversion();
  const [result, setResult] = useState<CashOutOut | null>(null);

  const sale = sells.find((r) => String(r.id) === form.saleId);
  const pickedWithdrawal = withdrawals.find((r) => String(r.id) === form.withdrawalId);
  const saleUsd = form.saleMode === "pick" ? (sale ? abs(sale.net_native) : null) : form.saleMode === "enter" ? num(form.saleUsd) : null;
  const withdrawalUsd = pickedWithdrawal ? abs(pickedWithdrawal.net_native) : (num(form.withdrawalUsd) ?? saleUsd);
  const usdSent = num(form.usdSent) ?? withdrawalUsd;
  const eurReceived = num(form.eurReceived);
  const fees = num(form.feesEur) ?? 0;
  const ref = useFxReference(form.date);
  const ecb = ref.data?.ecb_rate ? Number(ref.data.ecb_rate) : null;
  const yourRate = usdSent && eurReceived ? usdSent / eurReceived : null;

  const stepOk = [
    form.saleMode === "cash" || (saleUsd !== null && saleUsd > 0),
    withdrawalUsd !== null && withdrawalUsd > 0,
    usdSent !== null && usdSent > 0 && eurReceived !== null && eurReceived > 0,
  ];

  const next = () => {
    if (step === 1 && !form.usdSent && withdrawalUsd) set({ usdSent: withdrawalUsd.toFixed(2) });
    if (step < 2) {
      setStep(step + 1);
      return;
    }
    preview.mutate(
      {
        withdrawal_id: pickedWithdrawal ? pickedWithdrawal.id : null,
        usd_sent: String(usdSent),
        eur_received: String(eurReceived),
        fees_eur: String(fees),
        date: form.date,
      },
      { onSuccess: setResult, onError: () => toast({ title: "Could not work out the result", tone: "error" }) },
    );
  };

  const save = async () => {
    try {
      if (!pickedWithdrawal && withdrawalUsd) {
        await createTxn.mutateAsync({
          kind: "withdrawal",
          date: form.withdrawalDate,
          account_id: sale?.account_id ?? withdrawals[0]?.account_id ?? 1,
          net_native: String(-withdrawalUsd),
          currency: "USD",
        } as unknown as Parameters<typeof createTxn.mutateAsync>[0]);
      }
      // A conversion back: the amounts keep their currency (dollars sent, euros received).
      const body = {
        date: form.date,
        from_ccy: "USD",
        to_ccy: "EUR",
        direction: "to_eur",
        eur_sent: String(eurReceived),
        usd_received: String(usdSent),
        fees_eur: fees ? String(fees) : null,
        provider: form.provider as FxConversionInput["provider"],
        kept_usd: "0",
        note: null,
      } as FxConversionInput;
      await saveConversion.mutateAsync({ body });
      toast({ title: "Cash-out saved", tone: "success" });
      navigate("/conversions?direction=to_eur");
    } catch (e) {
      toast({ title: "Could not save the cash-out", description: e instanceof Error ? e.message : undefined, tone: "error" });
    }
  };

  const trail: TrailStep[] = result
    ? [
        ...(form.saleMode !== "cash" && saleUsd
          ? [stepOf("sold", form.saleMode === "pick" ? (sale?.date ?? null) : form.saleDate, "Sold", saleUsd, "USD", sale?.symbol ?? "a holding")]
          : []),
        stepOf("withdrawn", pickedWithdrawal?.date ?? form.withdrawalDate, "Withdrawn", withdrawalUsd ?? 0, "USD", "to the USD account"),
        { ...stepOf("back", form.date, "Back in euros", Number(result.eur_received), "EUR", yourRate ? `at ${formatNumber(yourRate, 4)}` : null), change: result.eur.realised },
      ]
    : [];

  return (
    <div className="cash-out">
      <PageHeader
        title="Cash out to euros"
        subtitle="Sell, withdraw to your USD account, convert back: see what you really made in euros."
        actions={
          <Link to="/conversions" className="cash-out__back">
            <ArrowLeft aria-hidden className="cash-out__back-icon" />
            Conversions
          </Link>
        }
      />
      {result ? (
        <div className="cash-out__result">
          <Card title="The trail" className="cash-out__trail">
            <MoneyTrail steps={trail} label="Where these dollars went" />
          </Card>
          <CashOutCard out={result} />
          <div className="cash-out__actions">
            <Button variant="ghost" onClick={() => setResult(null)}>
              Change
            </Button>
            <Button variant="primary" loading={createTxn.isPending || saveConversion.isPending} onClick={() => void save()}>
              Save the cash-out
            </Button>
          </div>
        </div>
      ) : (
        <Card className="cash-out__flow">
          <ol className="cash-out__steps" aria-label={`Step ${step + 1} of 3`}>
            {STEPS.map((label, i) => (
              <li key={label} className={clsx("cash-out__step", i === step && "cash-out__step--current", i < step && "cash-out__step--done")} aria-current={i === step ? "step" : undefined}>
                <span className="cash-out__dot" aria-hidden>
                  {i < step ? <Check className="cash-out__dot-icon" /> : i + 1}
                </span>
                <span className="cash-out__step-label">{label}</span>
              </li>
            ))}
          </ol>

          {step === 0 && (
            <div className="cash-out__body">
              <h2 className="cash-out__heading">What did you sell?</h2>
              <SegmentedControl<SaleMode>
                ariaLabel="Where the dollars come from"
                value={form.saleMode}
                onChange={(v) => set({ saleMode: v })}
                options={[
                  { value: "pick", label: "Pick a sale" },
                  { value: "enter", label: "Enter it" },
                  { value: "cash", label: "Cash only" },
                ]}
              />
              {form.saleMode === "pick" && (
                <Field label="Sale">
                  {(c) => (
                    <Select
                      id={c.id}
                      value={form.saleId}
                      onValueChange={(v) => set({ saleId: v })}
                      placeholder={sells.length ? "Choose a sale" : "No sales in the ledger"}
                      disabled={sells.length === 0}
                      options={sells.map((r) => ({ value: String(r.id), label: `${formatDate(r.date)} · ${r.symbol} · ${formatMoney(abs(r.net_native), "USD")}` }))}
                    />
                  )}
                </Field>
              )}
              {form.saleMode === "enter" && (
                <div className="cash-out__pair">
                  <Field label="Date">{(c) => <Input {...c} type="date" value={form.saleDate} onChange={(e) => set({ saleDate: e.target.value })} />}</Field>
                  <Field label="Proceeds (USD)">
                    {(c) => <Input {...c} inputMode="decimal" value={form.saleUsd} onChange={(e) => set({ saleUsd: e.target.value })} placeholder="2,400.00" />}
                  </Field>
                </div>
              )}
              {form.saleMode === "cash" && <p className="cash-out__note">The dollars come from cash already at the broker, such as the money-market fund.</p>}
            </div>
          )}

          {step === 1 && (
            <div className="cash-out__body">
              <h2 className="cash-out__heading">Withdrawn to your USD account</h2>
              {withdrawals.length > 0 && (
                <Field label="A withdrawal you already recorded" hint="Or leave it empty and enter it below.">
                  {(c) => (
                    <Select
                      id={c.id}
                      value={form.withdrawalId}
                      onValueChange={(v) => set({ withdrawalId: v })}
                      placeholder="None, enter it"
                      options={withdrawals.map((r) => ({ value: String(r.id), label: `${formatDate(r.date)} · ${formatMoney(abs(r.net_native), "USD")}` }))}
                    />
                  )}
                </Field>
              )}
              {!pickedWithdrawal && (
                <div className="cash-out__pair">
                  <Field label="Date">{(c) => <Input {...c} type="date" value={form.withdrawalDate} onChange={(e) => set({ withdrawalDate: e.target.value })} />}</Field>
                  <Field label="Amount (USD)" hint={saleUsd ? "Prefilled from the sale." : undefined}>
                    {(c) => (
                      <Input
                        {...c}
                        inputMode="decimal"
                        value={form.withdrawalUsd || (saleUsd ? saleUsd.toFixed(2) : "")}
                        onChange={(e) => set({ withdrawalUsd: e.target.value })}
                      />
                    )}
                  </Field>
                </div>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="cash-out__body">
              <h2 className="cash-out__heading">Converted back to euros</h2>
              <div className="cash-out__pair">
                <Field label="Date">{(c) => <Input {...c} type="date" value={form.date} onChange={(e) => set({ date: e.target.value })} />}</Field>
                <Field label="Provider">
                  {(c) => <Select id={c.id} value={form.provider} onValueChange={(v) => set({ provider: v })} options={PROVIDERS} />}
                </Field>
                <Field label="Dollars sent">
                  {(c) => (
                    <Input {...c} inputMode="decimal" value={form.usdSent || (withdrawalUsd ? withdrawalUsd.toFixed(2) : "")} onChange={(e) => set({ usdSent: e.target.value })} />
                  )}
                </Field>
                <Field label="Euros received">
                  {(c) => <Input {...c} inputMode="decimal" value={form.eurReceived} onChange={(e) => set({ eurReceived: e.target.value })} placeholder="2,201.30" />}
                </Field>
                <Field label="Fees (EUR)">
                  {(c) => <Input {...c} inputMode="decimal" value={form.feesEur} onChange={(e) => set({ feesEur: e.target.value })} placeholder="0.00" />}
                </Field>
              </div>
              <p className="cash-out__check" aria-live="polite">
                {yourRate && ecb ? (
                  <>
                    Your rate {formatNumber(yourRate, 4)} · ECB {formatNumber(ecb, 4)}: at the ECB rate you would have received{" "}
                    <Money amount={usdSent! / ecb} currency="EUR" />.
                  </>
                ) : ecb ? (
                  <>ECB rate that day: {formatNumber(ecb, 4)}.</>
                ) : (
                  <>Enter the euros received to compare your rate with the ECB's.</>
                )}
              </p>
            </div>
          )}

          <div className="cash-out__actions">
            {step > 0 && (
              <Button variant="ghost" onClick={() => setStep(step - 1)}>
                Back
              </Button>
            )}
            <Button variant="primary" disabled={!stepOk[step]} loading={preview.isPending} onClick={next}>
              {step < 2 ? "Next" : "See the result"}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function stepOf(key: TrailStep["key"], date: string | null, label: string, figure: number, ccy: string, detail: string | null): TrailStep {
  return { key, date, label, figure: figure.toFixed(2), figure_ccy: ccy, detail, link: null, change: null };
}
