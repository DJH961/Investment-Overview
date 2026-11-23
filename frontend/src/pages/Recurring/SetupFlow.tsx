import { useMemo, useState } from "react";
import { Sheet } from "../../components/Sheet";
import { useSuggestions, type PlanKind, type PlanSuggestion, type RecurringPlanInput } from "../../lib/queries/recurring";
import { PlanForm } from "./PlanForm";

interface Step {
  kind: PlanKind;
  title: string;
  initial?: Partial<RecurringPlanInput>;
  note?: string;
}

function initialOf(s: PlanSuggestion): Partial<RecurringPlanInput> {
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

/**
 * "Set up your routine": the conversion, the monthly deposit and the weekly buys, one step
 * each, every step skippable, each plan editable afterwards on its own. The forms are
 * prefilled from what the last months of the ledger look like; nothing is created until
 * you press the step's Add button.
 */
export function SetupFlow({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: suggestions } = useSuggestions(open);
  const steps = useMemo<Step[]>(() => {
    const of = (kind: PlanKind) => (suggestions ?? []).filter((s) => s.kind === kind);
    const note = (s?: PlanSuggestion) => (s ? `Suggested from your last ${s.occurrences} entries.` : undefined);
    const conv = of("conversion")[0];
    const dep = of("deposit")[0];
    const buys = of("buy");
    return [
      { kind: "conversion", title: "Your EUR to USD conversion", initial: conv && initialOf(conv), note: note(conv) },
      { kind: "deposit", title: "Your monthly deposit", initial: dep && initialOf(dep), note: note(dep) },
      ...(buys.length > 0
        ? buys.map((b): Step => ({ kind: "buy", title: `Buys of ${(b.legs ?? []).map((l) => l.symbol).join(", ")}`, initial: initialOf(b), note: note(b) }))
        : [{ kind: "buy", title: "Your regular buys" } as Step]),
    ];
  }, [suggestions]);
  const [index, setIndex] = useState(0);
  const step = steps[index];
  const advance = () => {
    if (index >= steps.length - 1) {
      setIndex(0);
      onClose();
    } else setIndex(index + 1);
  };
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()} title="Set up your routine">
      {step && (
        <div className="recurring-page__setup">
          <p className="recurring-page__setup-step">
            Step {index + 1} of {steps.length}: {step.title}
          </p>
          {step.note && <p className="recurring-page__setup-note">{step.note}</p>}
          <PlanForm
            key={`${index}-${suggestions ? "s" : "w"}`}
            kind={step.kind}
            hideKind
            initial={step.initial}
            saveLabel="Add plan"
            skipLabel={index >= steps.length - 1 ? "Skip and finish" : "Skip this step"}
            onSaved={advance}
            onSkip={advance}
          />
        </div>
      )}
    </Sheet>
  );
}
