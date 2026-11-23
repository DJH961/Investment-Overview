import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Button } from "../../components/Button";
import { formatMoney } from "../../lib/format";
import {
  useSetupPlan,
  useSuggestions,
  type PlanKind,
  type PlanSuggestion,
  type RecurringPlanInput,
} from "../../lib/queries/recurring";
import { FormShell } from "./FormShell";
import { PlanForm } from "./PlanForm";

type Initial = Partial<RecurringPlanInput>;

function initialOf(s: PlanSuggestion): Initial {
  return {
    unit: s.unit,
    every: s.every,
    anchor: s.anchor,
    amount: s.amount,
    account_id: s.account_id,
    legs: (s.legs ?? []).map((l) => ({ instrument_id: l.instrument_id, amount: l.amount })),
    provider: s.provider,
  };
}

const FORM_ID = "recurring-setup-form";
const usd = (v: string | number) => formatMoney(Number(v), "USD", { digits: 0 });

type Cadence = { unit: string; every: number; anchor: number | null };

const ONE: Record<string, string> = { days: "day", weeks: "week", months: "month" };
const ADJ: Record<string, string> = { days: "daily", weeks: "weekly", months: "monthly" };

/** "a week" / "every 2 weeks". */
function perRun(c: { unit: string; every: number }): string {
  return c.every === 1 ? `a ${ONE[c.unit]}` : `every ${c.every} ${ONE[c.unit]}s`;
}

/** "weekly" / "every 2 weeks" (as in "your weekly conversion"). */
function adjective(c: { unit: string; every: number }): string {
  return c.every === 1 ? ADJ[c.unit]! : `every ${c.every} ${ONE[c.unit]}s`;
}

const TITLES = ["Your EUR to USD conversion", "Your monthly deposit", "Your regular buys"];

/**
 * "Set up your routine": the conversion, the monthly deposit and the regular buys, one step
 * each. Forms are prefilled from the last months of the ledger (a muted line says so, with
 * a Clear). Defaults also flow forward, each step from the one directly before it: the
 * deposit starts from the dollars the conversion yields, the buys from the deposit amount
 * (split by your allocation plan, else like your recent buys, else equally). The server does
 * all of that arithmetic; this only shows it. Nothing is created until you press Next.
 */
export function SetupFlow({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: suggestions } = useSuggestions(open);
  const [index, setIndex] = useState(0);
  const [cleared, setCleared] = useState<Record<number, boolean>>({});
  const [useFlow, setUseFlow] = useState<Record<number, boolean>>({});
  // The cadence of the step being edited, as typed: the per-run figures follow it.
  const [cad, setCad] = useState<Record<number, Cadence>>({});
  // What each step created (undefined when skipped): the next step inherits from it.
  const [saved, setSaved] = useState<Record<number, RecurringPlanInput | undefined>>({});

  const history = useMemo(() => {
    const of = (kind: PlanKind) => (suggestions ?? []).filter((s) => s.kind === kind);
    return { conversion: of("conversion")[0], deposit: of("deposit")[0], buy: of("buy")[0] };
  }, [suggestions]);
  const asCad = (x: { unit: string; every: number; anchor?: number | null }): Cadence => ({ unit: x.unit, every: x.every, anchor: x.anchor ?? null });

  // Step 1 -> step 2: the dollars the conversion yields, per deposit run.
  const conv = saved[0];
  const convCadence: Cadence | null = conv ? asCad(conv) : null;
  const depositNow: Cadence = cad[1] ?? (history.deposit ? asCad(history.deposit) : (convCadence ?? { unit: "months", every: 1, anchor: null }));
  const flow2 = useSetupPlan({
    eur: conv?.amount ? String(conv.amount) : undefined,
    provider: conv?.provider ?? undefined,
    fee: conv?.expected_fee != null ? String(conv.expected_fee) : undefined,
    conversionCadence: convCadence,
    depositCadence: depositNow,
  });
  const flowUsd = flow2.data?.conversion?.deposit_usd;
  const convUsd = flow2.data?.conversion?.usd;

  // Step 2 -> step 3: the deposit amount, spread over the buy runs and split across holdings.
  const deposit = saved[1];
  const depositAmount = deposit?.amount != null ? String(deposit.amount) : undefined;
  const buyAccount = deposit?.account_id ?? history.buy?.account_id ?? null;
  const historicalTotal = history.buy ? String(history.buy.amount) : undefined;
  const depositCadence = deposit ? asCad(deposit) : { unit: "months", every: 1, anchor: null };
  const buyNow: Cadence = cad[2] ?? (history.buy ? asCad(history.buy) : { unit: "weeks", every: 1, anchor: null });
  const flow3 = useSetupPlan({
    total: depositAmount ?? historicalTotal,
    accountId: buyAccount,
    // Only a real deposit is spread over the buy runs; a historical buy total already is per run.
    depositCadence: depositAmount ? depositCadence : null,
    buyCadence: depositAmount ? buyNow : null,
  });
  const split = flow3.data?.split ?? null;

  const kind: PlanKind = index === 0 ? "conversion" : index === 1 ? "deposit" : "buy";
  const last = index >= 2;
  const isCleared = Boolean(cleared[index]);

  let initial: Initial | undefined;
  let notes: ReactNode = null;
  let hint: ReactNode = null;
  let depositTotal: number | undefined;
  if (index === 0 && history.conversion) {
    initial = initialOf(history.conversion);
    notes = <>Suggested from your last 3 months. </>;
  } else if (index === 1) {
    const sameCadence = !convCadence || (convCadence.unit === depositNow.unit && convCadence.every === depositNow.every);
    const flowInitial: Initial | undefined = flowUsd
      ? {
          unit: depositNow.unit as RecurringPlanInput["unit"],
          every: depositNow.every,
          // On a monthly rhythm: the day after the conversion's day (the dollars have landed by then).
          anchor:
            depositNow.unit === "months" && convCadence?.unit === "months" && conv?.anchor != null
              ? Math.min(conv.anchor + 1, 28)
              : depositNow.anchor,
          amount: flowUsd,
          account_id: history.buy?.account_id ?? history.deposit?.account_id ?? null,
        }
      : undefined;
    const spread =
      flowUsd && convCadence && !sameCadence ? (
        <>
          ≈ {usd(flowUsd)} {perRun(depositNow)}, so your {adjective(convCadence)} conversion ({convUsd ? usd(convUsd) : ""}) is
          deposited across the {ONE[convCadence.unit]}.{" "}
        </>
      ) : null;
    if (history.deposit && !useFlow[1]) {
      initial = initialOf(history.deposit);
      const differs = flowUsd && Number(flowUsd) !== Number(history.deposit.amount);
      notes = (
        <>
          Suggested from your last 3 months.{" "}
          {differs && (
            <>
              {spread ?? <>Matches your conversion: {usd(flowUsd)}. </>}
              <button type="button" className="recurring-page__linklike" onClick={() => setUseFlow({ ...useFlow, 1: true })}>
                Use {usd(flowUsd)}
              </button>{" "}
            </>
          )}
        </>
      );
    } else if (flowInitial) {
      initial = { ...(history.deposit ? initialOf(history.deposit) : {}), ...flowInitial };
      notes = spread ?? <>Starts from your conversion: about {usd(flowUsd!)}. Change it to what you deposit. </>;
    }
  } else if (index === 2) {
    const base: Initial = { ...(history.buy ? initialOf(history.buy) : {}), unit: buyNow.unit as RecurringPlanInput["unit"], every: buyNow.every, anchor: buyNow.anchor };
    // With a deposit the split is always used; without one only an allocation-plan split is.
    const useSplit = split && split.legs.length > 0 && (Boolean(depositAmount) || split.method === "allocation");
    if (useSplit && split) {
      initial = { ...base, account_id: buyAccount, legs: split.legs.map((l) => ({ instrument_id: l.instrument_id, amount: l.amount })) };
      if (depositAmount) depositTotal = Number(split.total);
      const how =
        split.method === "allocation" ? (
          <>
            Split by your allocation plan{split.allocation_name ? ` (${split.allocation_name})` : ""}.{" "}
            <Link to="/allocations" className="recurring-page__linklike">
              Allocations
            </Link>
          </>
        ) : split.method === "history" ? (
          <>Split like your recent buys.</>
        ) : (
          <>Split equally across the holdings of this account.</>
        );
      notes = (
        <>
          {depositAmount && Number(split.total) !== Number(split.deposit_total) && (
            <>
              ≈ {usd(split.total)} {perRun(buyNow)}, so your{" "}
              {depositCadence.every === 1
                ? `${adjective(depositCadence)} ${usd(split.deposit_total)} deposit`
                : `${usd(split.deposit_total)} deposit ${perRun(depositCadence)}`}{" "}
              is invested in full.{" "}
            </>
          )}
          {how}{" "}
        </>
      );
      if (!split.has_allocation_plan) {
        hint = (
          <>
            Set an allocation plan to split this automatically.{" "}
            <Link to="/allocations" className="recurring-page__linklike">
              Allocations
            </Link>
          </>
        );
      }
    } else if (history.buy) {
      initial = { ...base, account_id: buyAccount };
      notes = <>Suggested from your last 3 months. </>;
    } else if (buyAccount) {
      initial = { account_id: buyAccount };
    }
  }

  const advance = () => {
    if (last) {
      setIndex(0);
      setCleared({});
      setUseFlow({});
      setCad({});
      setSaved({});
      onClose();
    } else setIndex(index + 1);
  };
  const footer = (
    <>
      <Button variant="ghost" onClick={advance}>
        Skip this step
      </Button>
      <Button type="submit" form={FORM_ID} variant="primary">
        {last ? "Finish" : "Next"}
      </Button>
    </>
  );
  // The form restarts only when what it is prefilled from changes (never on a typed edit): the
  // deposit amount follows the conversion only when it is the flow that fills it.
  const followsFlow = index === 1 && (Boolean(useFlow[1]) || !history.deposit);
  const remountKey = [index, suggestions ? "s" : "w", isCleared ? "c" : "p", useFlow[1] ? "f" : "", followsFlow ? (flowUsd ?? "") : "", index === 2 && split ? `${split.method}${split.legs.map((l) => l.amount).join("-")}` : ""].join("|");
  return (
    <FormShell open={open} onClose={onClose} title="Set up your routine" footer={footer}>
      <div className="recurring-page__setup">
        <ol className="recurring-page__steps" aria-label={`Step ${index + 1} of 3`}>
          {TITLES.map((_, i) => (
            <li
              key={i}
              className={`recurring-page__steps-dot${i === index ? " recurring-page__steps-dot--current" : ""}${i < index ? " recurring-page__steps-dot--done" : ""}`}
              aria-current={i === index ? "step" : undefined}
            >
              {i + 1}
            </li>
          ))}
        </ol>
        <h3 className="recurring-page__setup-step">
          Step {index + 1} of 3: {TITLES[index]}
        </h3>
        {notes && !isCleared && (
          <p className="recurring-page__setup-note">
            {notes}
            {initial && (
              <button type="button" className="recurring-page__linklike" onClick={() => setCleared({ ...cleared, [index]: true })}>
                Clear
              </button>
            )}
          </p>
        )}
        {hint && !isCleared && <p className="recurring-page__setup-hint">{hint}</p>}
        <PlanForm
          key={remountKey}
          kind={kind}
          hideKind
          hideActions
          formId={FORM_ID}
          initial={isCleared ? undefined : initial}
          depositTotal={isCleared ? undefined : depositTotal}
          onCadenceChange={index > 0 ? (c) => setCad((p) => (p[index] && p[index]!.unit === c.unit && p[index]!.every === c.every && p[index]!.anchor === c.anchor ? p : { ...p, [index]: c })) : undefined}
          onSaved={(body) => {
            setSaved({ ...saved, [index]: body });
            advance();
          }}
        />
      </div>
    </FormShell>
  );
}
