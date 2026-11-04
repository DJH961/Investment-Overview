import { useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Field } from "../../components/Field";
import { Input } from "../../components/Input";
import { Select } from "../../components/Select";
import { useToast } from "../../components/Toast";
import { ApiError } from "../../lib/api";
import { useSaveTarget, type TargetOut } from "../../lib/queries/allocations";
import { isOff, totalWeight } from "./builderState";

export interface SaveItem {
  instrument_id: number;
  /** Weight in percent (the server normalises). */
  weight_pct: string;
  no_buy: boolean;
}

export interface SaveTargetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targets: TargetOut[];
  activeId: number | null;
  items: SaveItem[];
  allowSell: boolean;
  symbolOf: (id: number) => string;
}

const NEW = "new";

export function SaveTargetDialog({ open, onOpenChange, targets, activeId, items, allowSell, symbolOf }: SaveTargetDialogProps) {
  const save = useSaveTarget();
  const { toast } = useToast();
  // Mounted only while open (see Builder), so the initial state is fresh each time.
  const start = activeId !== null ? String(activeId) : NEW;
  const [targetKey, setTargetKey] = useState<string>(start);
  const [name, setName] = useState(() => targets.find((t) => String(t.id) === start)?.name ?? "Target");
  const [activate, setActivate] = useState(true);

  const pick = (key: string) => {
    setTargetKey(key);
    const t = targets.find((x) => String(x.id) === key);
    setName(t?.name ?? "Target");
    setActivate(t ? t.active : activeId === null);
  };

  const sums = !isOff(totalWeight(items.map((i) => ({ weight: i.weight_pct }))));

  const submit = () =>
    save.mutate(
      {
        id: targetKey === NEW ? null : Number(targetKey),
        name: name.trim() || "Target",
        active: activate,
        allow_sell: allowSell,
        items: items.map((i) => ({ instrument_id: i.instrument_id, weight_pct: i.weight_pct, no_buy: i.no_buy })),
      },
      {
        onSuccess: () => {
          toast({ title: activate ? "Target saved and activated" : "Target saved", tone: "success" });
          onOpenChange(false);
        },
        onError: (e) =>
          toast({ title: "Could not save", description: e instanceof ApiError ? e.message : undefined, tone: "error" }),
      },
    );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Save as target"
      description={`${items.length} fund${items.length === 1 ? "" : "s"} · ${sums ? "sums to 100 %" : "will be normalised to 100 %"}`}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} loading={save.isPending} disabled={items.length === 0}>
            Save
          </Button>
        </>
      }
    >
      <div className="allocations__step">
        <Field label="Save to">
          {(c) => (
            <Select
              id={c.id}
              value={targetKey}
              onValueChange={pick}
              options={[
                { value: NEW, label: "New target" },
                ...targets.map((t) => ({ value: String(t.id), label: t.active ? `${t.name} (active)` : t.name })),
              ]}
            />
          )}
        </Field>
        <Field label="Name">{(c) => <Input {...c} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <label className="allocations__check">
          <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} />
          Activate (drift and the saved-target plan use the active target)
        </label>
        <p className="allocations__plan-note">{items.map((i) => symbolOf(i.instrument_id)).join(", ")}</p>
      </div>
    </Dialog>
  );
}
