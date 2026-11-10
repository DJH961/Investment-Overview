import { useId, useMemo, useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Field } from "../../components/Field";
import { Input } from "../../components/Input";
import { Select } from "../../components/Select";
import { Switch } from "../../components/Switch";
import { useToast } from "../../components/Toast";
import { ApiError } from "../../lib/api";
import { formatPercent } from "../../lib/format";
import { useSaveTarget, type TargetOut } from "../../lib/queries/allocations";
import { isOff, totalWeight, type SavedBuilder } from "./builderState";
import "./SaveTargetDialog.scss";

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
  /** The calculator mix to save with the target (mode, category selection, ETF-only). */
  builder?: SavedBuilder;
  symbolOf: (id: number) => string;
}

const NEW = "new";

/** What is wrong with a target name, or null when it can be saved. */
export function nameError(name: string, targets: TargetOut[], targetKey: string): string | null {
  const clean = name.trim();
  if (!clean) return "Give the target a name.";
  if (clean.length > 80) return "Keep the name under 80 characters.";
  const clash = targets.find((t) => t.name.trim().toLowerCase() === clean.toLowerCase() && String(t.id) !== targetKey);
  if (clash) return `"${clash.name}" already exists: pick it under "Save to" to replace it, or use another name.`;
  return null;
}

/** A free default name ("Target", "Target 2", …) for a new target. */
export function freeName(targets: TargetOut[]): string {
  const taken = new Set(targets.map((t) => t.name.trim().toLowerCase()));
  if (!taken.has("target")) return "Target";
  let n = 2;
  while (taken.has(`target ${n}`)) n += 1;
  return `Target ${n}`;
}

/**
 * Saves the builder's mix as a new target or over an existing one. A real
 * form: Enter saves, the name is checked (required, unique), replacing a
 * target says so, and the funds and weights being saved are listed.
 */
export function SaveTargetDialog({
  open,
  onOpenChange,
  targets,
  activeId,
  items,
  allowSell,
  builder,
  symbolOf,
}: SaveTargetDialogProps) {
  const save = useSaveTarget();
  const { toast } = useToast();
  const formId = useId();
  // Mounted only while open (see Builder), so the initial state is fresh each time.
  const start = activeId !== null && targets.some((t) => t.id === activeId) ? String(activeId) : NEW;
  const [targetKey, setTargetKey] = useState<string>(start);
  const [name, setName] = useState(() => targets.find((t) => String(t.id) === start)?.name ?? freeName(targets));
  const [activate, setActivate] = useState(true);
  const [touched, setTouched] = useState(false);

  const existing = targets.find((t) => String(t.id) === targetKey);
  const pick = (key: string) => {
    setTargetKey(key);
    const t = targets.find((x) => String(x.id) === key);
    setName(t?.name ?? freeName(targets));
    setActivate(t ? t.active || activeId === null : true);
  };

  const total = totalWeight(items.map((i) => ({ weight: i.weight_pct })));
  const sums = !isOff(total);
  const error = nameError(name, targets, targetKey);
  const sorted = useMemo(() => [...items].sort((a, b) => Number(b.weight_pct) - Number(a.weight_pct)), [items]);

  const submit = () => {
    setTouched(true);
    if (error || items.length === 0 || save.isPending) return;
    save.mutate(
      {
        id: existing ? existing.id : null,
        name: name.trim(),
        active: activate,
        allow_sell: allowSell,
        builder: builder ?? null,
        items: items.map((i) => ({ instrument_id: i.instrument_id, weight_pct: i.weight_pct, no_buy: i.no_buy })),
      },
      {
        onSuccess: () => {
          toast({
            title: `${existing ? "Updated" : "Saved"} "${name.trim()}"${activate ? " and made it active" : ""}`,
            tone: "success",
          });
          onOpenChange(false);
        },
        onError: (e) =>
          toast({ title: "Could not save", description: e instanceof ApiError ? e.message : undefined, tone: "error" }),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={existing ? "Update target" : "Save as target"}
      description={`${items.length} fund${items.length === 1 ? "" : "s"} · ${
        sums ? "weights sum to 100 %" : `weights sum to ${formatPercent(total / 100, { digits: 1 })}, saved scaled to 100 %`
      }`}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            loading={save.isPending}
            disabled={items.length === 0 || (touched && error !== null)}
          >
            {existing ? "Replace target" : "Save target"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="save-target"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field
          label="Save to"
          hint={existing ? `Replaces the funds and weights of "${existing.name}".` : "Creates a new target."}
        >
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
        <Field label="Name" error={touched ? error : null}>
          {(c) => (
            <Input
              {...c}
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setTouched(true)}
              onFocus={(e) => e.currentTarget.select()}
            />
          )}
        </Field>
        <Switch
          label="Make it the active target"
          hint="Drift and the saved-target plan follow the active target."
          checked={activate}
          onCheckedChange={setActivate}
        />
        <section className="save-target__items" aria-label="Funds to save">
          <header className="save-target__items-head">
            <span>Fund</span>
            <span>Weight</span>
          </header>
          <ul className="save-target__list">
            {sorted.map((i) => (
              <li key={i.instrument_id} className="save-target__item">
                <span className="save-target__symbol">
                  {symbolOf(i.instrument_id)}
                  {i.no_buy && <span className="save-target__tag">no buy</span>}
                </span>
                <span className="save-target__weight">{formatPercent(Number(i.weight_pct) / 100, { digits: 1 })}</span>
              </li>
            ))}
          </ul>
          <p className="save-target__note">
            {allowSell ? "Plans for this target may sell (rebalance)." : "Plans for this target only buy."}
            {builder?.mode === "category" &&
              ` The category mix and which funds get new money${builder.etf_only ? " (only ETFs)" : ""} are saved too.`}
          </p>
        </section>
      </form>
    </Dialog>
  );
}
