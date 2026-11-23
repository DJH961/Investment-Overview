import { useMemo, useState, type ReactNode } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Sheet } from "../../components/Sheet";
import { useSuggestions, type PlanKind, type PlanSuggestion, type RecurringPlanInput } from "../../lib/queries/recurring";
import { useIsPhone } from "../../lib/useMediaQuery";
import { PlanForm } from "./PlanForm";

interface Step {
  kind: PlanKind;
  title: string;
  initial?: Partial<RecurringPlanInput>;
  suggested: boolean;
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

const FORM_ID = "recurring-setup-form";

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

/**
 * "Set up your routine": the conversion, the monthly deposit and the regular buys, one step
 * each. Each form is prefilled from what the last months of the ledger look like (a muted
 * line says so, with a Clear); nothing is created until you press Next. Every step can be
 * skipped, and each plan stays editable afterwards on its own.
 */
export function SetupFlow({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: suggestions } = useSuggestions(open);
  const steps = useMemo<Step[]>(() => {
    const of = (kind: PlanKind) => (suggestions ?? []).filter((s) => s.kind === kind);
    const one = (kind: PlanKind, title: string): Step => {
      const s = of(kind)[0];
      return { kind, title, initial: s && initialOf(s), suggested: Boolean(s) };
    };
    const buys = of("buy");
    return [
      one("conversion", "Your EUR to USD conversion"),
      one("deposit", "Your monthly deposit"),
      ...(buys.length > 0
        ? buys.map((b): Step => ({ kind: "buy", title: "Your regular buys", initial: initialOf(b), suggested: true }))
        : [{ kind: "buy", title: "Your regular buys", suggested: false } as Step]),
    ];
  }, [suggestions]);
  const [index, setIndex] = useState(0);
  const [cleared, setCleared] = useState<Record<number, boolean>>({});
  const step = steps[index];
  const last = index >= steps.length - 1;
  const advance = () => {
    if (last) {
      setIndex(0);
      setCleared({});
      onClose();
    } else setIndex(index + 1);
  };
  const isCleared = Boolean(cleared[index]);
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
  return (
    <Shell open={open} onClose={onClose} footer={footer}>
      {step && (
        <div className="recurring-page__setup">
          <ol className="recurring-page__steps" aria-label={`Step ${index + 1} of ${steps.length}`}>
            {steps.map((_, i) => (
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
            Step {index + 1} of {steps.length}: {step.title}
          </h3>
          {step.suggested && !isCleared && (
            <p className="recurring-page__setup-note">
              Suggested from your last 3 months.{" "}
              <button type="button" className="recurring-page__linklike" onClick={() => setCleared({ ...cleared, [index]: true })}>
                Clear
              </button>
            </p>
          )}
          <PlanForm
            key={`${index}-${suggestions ? "s" : "w"}-${isCleared ? "c" : "p"}`}
            kind={step.kind}
            hideKind
            hideActions
            formId={FORM_ID}
            initial={isCleared ? undefined : step.initial}
            onSaved={advance}
          />
        </div>
      )}
    </Shell>
  );
}
