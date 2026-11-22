import { useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Input } from "../../components/Input";
import { useToast } from "../../components/Toast";
import { ApiError } from "../../lib/api";
import { formatDate, formatMoney } from "../../lib/format";
import { toApiDecimal } from "../../lib/parseDecimal";
import { useSetPins, useUnpin, type DepositMatch, type FxConversion } from "../../lib/queries/manage";
import { conversionTitle, pinCandidates, validatePins, type PinDraft } from "./matching";

export interface PinDialogProps {
  deposit: DepositMatch;
  conversions: readonly FxConversion[];
  onClose: () => void;
}

/** "Pin a conversion…": choose which conversions pay for a deposit, and how many dollars each. */
export function PinDialog({ deposit, conversions, onClose }: PinDialogProps) {
  const setPins = useSetPins();
  const unpin = useUnpin();
  const { toast } = useToast();
  const candidates = pinCandidates(deposit, conversions);
  const [amounts, setAmounts] = useState<Record<number, string>>(() =>
    Object.fromEntries(deposit.slices.filter((s) => s.pinned).map((s) => [s.conversion_id, s.usd])),
  );
  const [error, setError] = useState<string | null>(null);

  // "$X free", or which deposit a used-up conversion pays for. This deposit's own pin counts as free.
  const availability = (c: FxConversion): string => {
    const own = Number(deposit.slices.find((s) => s.pinned && s.conversion_id === c.id)?.usd ?? 0);
    const free = Number(c.remaining_usd) + own;
    if (free > 0.005) return `${formatMoney(free, "USD")} free`;
    const others = c.used_by.filter((u) => u.deposit_id !== deposit.transaction_id);
    return others.length > 0 ? `pays the ${formatDate(others[0].date)} deposit` : "no dollars left";
  };

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
      title="Pin a conversion"
      description={`Deposit of ${formatMoney(Number(deposit.usd), "USD")} on ${formatDate(deposit.date)}. Pick the conversions that paid for it; the rest is matched oldest first.`}
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
          <p className="conversions__muted">No conversion is dated up to 7 days after this deposit.</p>
        ) : (
          <ul className="pin-form__list">
            {candidates.map((c) => (
              <li key={c.id} className="pin-form__row">
                <span className="pin-form__name">
                  <span className="pin-form__title">{conversionTitle(c)}</span>
                  <span className="pin-form__free">
                    {formatMoney(Number(c.eur_sent), "EUR")} → {formatMoney(Number(c.usd_received), "USD")}
                  </span>
                  <span className="pin-form__free">{availability(c)}</span>
                </span>
                <Input
                  aria-label={`USD from the ${conversionTitle(c)} conversion`}
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
