import { useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Input } from "../../components/Input";
import { useToast } from "../../components/Toast";
import { ApiError } from "../../lib/api";
import { formatDate, formatMoney } from "../../lib/format";
import { toApiDecimal } from "../../lib/parseDecimal";
import { useSetPins, useUnpin, type DepositMatch, type FxConversion } from "../../lib/queries/manage";
import { conversionName, pinCandidates, validatePins, type PinDraft } from "./matching";

export interface PinDialogProps {
  deposit: DepositMatch;
  conversions: readonly FxConversion[];
  onClose: () => void;
}

/** "Use this conversion…": choose which conversions pay for a deposit, and how many dollars each. */
export function PinDialog({ deposit, conversions, onClose }: PinDialogProps) {
  const setPins = useSetPins();
  const unpin = useUnpin();
  const { toast } = useToast();
  const candidates = pinCandidates(deposit, conversions);
  const [amounts, setAmounts] = useState<Record<number, string>>(() =>
    Object.fromEntries(deposit.slices.filter((s) => s.pinned).map((s) => [s.conversion_id, s.usd])),
  );
  const [error, setError] = useState<string | null>(null);

  const drafts = (): PinDraft[] =>
    Object.entries(amounts)
      .filter(([, v]) => v.trim() !== "")
      .map(([id, v]) => ({ conversion_id: Number(id), usd: toApiDecimal(v) ?? v }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const list = drafts();
    if (list.length === 0) {
      setError("Enter a USD amount for at least one conversion, or use Unpin.");
      return;
    }
    const problem = validatePins(deposit, list, conversions);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setPins.mutate(
      { depositId: deposit.transaction_id, pins: list.map((p) => ({ conversion_id: p.conversion_id, usd: p.usd })) },
      {
        onSuccess: () => {
          toast({ title: "Deposit pinned", tone: "success" });
          onClose();
        },
        onError: (err) => setError(err instanceof ApiError ? err.message : "Could not save the pin."),
      },
    );
  };

  const doUnpin = () =>
    unpin.mutate(deposit.transaction_id, {
      onSuccess: () => {
        toast({ title: "Deposit unpinned", tone: "success" });
        onClose();
      },
      onError: (err) => setError(err instanceof ApiError ? err.message : "Could not unpin."),
    });

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Use this conversion"
      description={`Deposit of ${formatMoney(Number(deposit.usd), "USD")} on ${formatDate(deposit.date)}. Conversions up to 7 days after it can be chosen. Dollars you do not pin are matched oldest first.`}
      footer={
        <>
          {deposit.pinned && (
            <Button variant="ghost" onClick={doUnpin} loading={unpin.isPending}>
              Unpin
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" form="pin-form" loading={setPins.isPending}>
            Save pin
          </Button>
        </>
      }
    >
      <form id="pin-form" className="pin-form" onSubmit={submit} noValidate>
        {candidates.length === 0 ? (
          <p className="conversions__muted">No conversion is dated within 7 days after this deposit.</p>
        ) : (
          <ul className="pin-form__list">
            {candidates.map((c) => (
              <li key={c.id} className="pin-form__row">
                <span className="pin-form__name">{conversionName(c)}</span>
                <Input
                  aria-label={`USD from conversion ${conversionName(c)}`}
                  inputMode="decimal"
                  placeholder="USD"
                  value={amounts[c.id] ?? ""}
                  onChange={(e) => setAmounts((a) => ({ ...a, [c.id]: e.target.value }))}
                />
              </li>
            ))}
          </ul>
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
