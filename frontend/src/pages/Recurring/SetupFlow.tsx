import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Sheet } from "../../components/Sheet";
import { formatMoney } from "../../lib/format";
import {
  useSetupPlan,
  useSuggestions,
  type PlanKind,
  type PlanSuggestion,
  type RecurringPlanInput,
} from "../../lib/queries/recurring";
import { useIsPhone } from "../../lib/useMediaQuery";
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

/** The wizard's frame: a centred dialog with a scrolling body on desktop, a bottom sheet on phones. */
function Shell({ open, onClose, children, footer }: { open: boolean; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  const phone = useIsPhone();
  if (phone) {
    return (
      <Sheet open={open} onOpenChange={(o) => !o && onClose()} title="Set up your routine">
        {children}
        <div className="recurring-page__setup-footer">{footer}</div>
      </Sheet>
    );
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title="Set up your routine" footer={footer}>
      {children}
    </Dialog>
  );
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
  // What each step created (undefined when skipped): the next step inherits from it.
  const [saved, setSaved] = useState<Record<number, RecurringPlanInput | undefined>>({});

  const history = useMemo(() => {
    const of = (kind: PlanKind) => (suggestions ?? []).filter((s) => s.kind === kind);
    return { conversion: of("conversion")[0], deposit: of("deposit")[0], buy: of("buy")[0] };
  }, [suggestions]);

  // Step 1 -> step 2: the dollars the conversion yields.
  const conv = saved[0];
  const flow2 = useSetupPlan({
    eur: conv?.amount ? String(conv.amount) : undefined,
    provider: conv?.provider ?? undefined,
    fee: conv?.expected_fee != null ? String(conv.expected_fee) : undefined,
  });
  const flowUsd = flow2.data?.conversion?.usd;

  // Step 2 -> step 3: the deposit total, split across the account's holdings.
  const deposit = saved[1];
  const depositAmount = deposit?.amount != null ? String(deposit.amount) : undefined;
  const buyAccount = deposit?.account_id ?? history.buy?.account_id ?? null;
  const historicalTotal = history.buy ? String(history.buy.amount) : undefined;
  const flow3 = useSetupPlan({ total: depositAmount ?? historicalTotal, accountId: buyAccount });
  const split = flow3.data?.split ?? null;

  const kind: PlanKind = index === 0 ? "conversion" : index === 1 ? "deposit" : "buy";
  const last = index >= 2;
  const isCleared = Boolean(cleared[index]);

  let initial: Initial | undefined;
  let notes: ReactNode = null;
  let depositTotal: number | undefined;
  if (index === 0 && history.conversion) {
    initial = initialOf(history.conversion);
    notes = <>Suggested from your last 3 months. </>;
  } else if (index === 1) {
    const flowInitial: Initial | undefined = flowUsd
      ? {
          unit: "months",
          every: 1,
          // The day after the conversion's day (the dollars have landed by then).
          anchor: conv?.anchor != null ? Math.min(conv.anchor + 1, 28) : null,
          amount: flowUsd,
          account_id: history.buy?.account_id ?? history.deposit?.account_id ?? null,
        }
      : undefined;
    if (history.deposit && !useFlow[1]) {
      initial = initialOf(history.deposit);
      const differs = flowUsd && Number(flowUsd) !== Number(history.deposit.amount);
      notes = (
        <>
          Suggested from your last 3 months.{" "}
          {differs && (
            <>
              Matches your conversion: {usd(flowUsd)}.{" "}
              <button type="button" className="recurring-page__linklike" onClick={() => setUseFlow({ ...useFlow, 1: true })}>
                Use {usd(flowUsd)}
              </button>{" "}
            </>
          )}
        </>
      );
    } else if (flowInitial) {
      initial = { ...(history.deposit ? initialOf(history.deposit) : {}), ...flowInitial };
      notes = <>Starts from your conversion: about {usd(flowUsd!)}. Change it to what you deposit. </>;
    }
  } else if (index === 2) {
    const base = history.buy ? initialOf(history.buy) : {};
    // With a deposit the split is always used; without one only an allocation-plan split is.
    const useSplit = split && split.legs.length > 0 && (Boolean(depositAmount) || split.method === "allocation");
    if (useSplit && split) {
      initial = { ...base, account_id: buyAccount, legs: split.legs.map((l) => ({ instrument_id: l.instrument_id, amount: l.amount })) };
      if (depositAmount) depositTotal = Number(depositAmount);
      notes = (
        <>
          {split.method === "allocation" ? (
            <>
              Split by your allocation plan{split.allocation_name ? ` (${split.allocation_name})` : ""}.{" "}
              <Link to="/allocations" className="recurring-page__linklike">
                Allocations
              </Link>{" "}
            </>
          ) : split.method === "history" ? (
            <>Split like your recent buys. </>
          ) : (
            <>Split equally across the holdings of this account. </>
          )}
          {!split.has_allocation_plan && (
            <span className="recurring-page__setup-hint">
              Set an allocation plan to split this automatically.{" "}
              <Link to="/allocations" className="recurring-page__linklike">
                Allocations
              </Link>{" "}
            </span>
          )}
        </>
      );
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
  const remountKey = [index, suggestions ? "s" : "w", isCleared ? "c" : "p", useFlow[1] ? "f" : "", flowUsd ?? "", split ? `${split.method}${split.legs.map((l) => l.amount).join("-")}` : ""].join("|");
  return (
    <Shell open={open} onClose={onClose} footer={footer}>
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
        <PlanForm
          key={remountKey}
          kind={kind}
          hideKind
          hideActions
          formId={FORM_ID}
          initial={isCleared ? undefined : initial}
          depositTotal={isCleared ? undefined : depositTotal}
          onSaved={(body) => {
            setSaved({ ...saved, [index]: body });
            advance();
          }}
        />
      </div>
    </Shell>
  );
}
