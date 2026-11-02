import clsx from "clsx";
import { History, KeyRound, RotateCcw, Undo2 } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { Input } from "../../components/Input";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Select } from "../../components/Select";
import { formatPercent } from "../../lib/format";
import type { SettingField as FieldDef, SettingJson, SettingValue } from "../../lib/queries/settings";

/** A draft entry: the editor text for typed-in fields, or the chosen value for choices. */
export type DraftValue = { text: string } | { value: SettingJson };

const CHOICE_LABELS: Record<string, string> = {
  auto: "Auto",
  light: "Light",
  dark: "Dark",
  "12h": "12-hour",
  "24h": "24-hour",
  ytd: "YTD",
  all: "All",
  true: "On",
  false: "Off",
};
const choiceLabel = (c: string) => CHOICE_LABELS[c] ?? (/^\d+[dwmy]$/.test(c) ? c.toUpperCase() : c);

const TEXT_TYPES = new Set<FieldDef["type"]>([
  "int",
  "decimal",
  "percent",
  "string",
  "symbol",
  "symbol_list",
  "percent_list",
  "time_hm",
  "duration_s",
  "json_map",
]);

export const TIMEZONE_KEY = "display_timezone";

/** Fields whose control is a free-text editor (the draft keeps the raw text). */
export function isTextField(f: FieldDef): boolean {
  return !f.secret && f.key !== TIMEZONE_KEY && TEXT_TYPES.has(f.type) && f.choices.length === 0;
}

/** The current value as editor text. */
export function toText(f: FieldDef, v: SettingJson | undefined): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return JSON.stringify(v, null, 2);
  void f;
  return String(v);
}

const INT_RE = /^-?\d+$/;
const DEC_RE = /^-?\d+(\.\d+)?$/;

function checkBounds(f: FieldDef, n: number): string | null {
  const min = f.min === null || f.min === undefined ? null : Number(f.min);
  const max = f.max === null || f.max === undefined ? null : Number(f.max);
  if (min !== null && n < min) return `At least ${f.min}`;
  if (max !== null && n > max) return `At most ${f.max}`;
  return null;
}

/** Editor text → the JSON value the API takes, or a message. Mirrors the server checks; the server has the last word. */
export function parseText(f: FieldDef, text: string): { value: SettingJson } | { error: string } {
  const t = text.trim();
  if (t === "") return f.nullable ? { value: null } : { error: "A value is needed" };
  switch (f.type) {
    case "int":
    case "duration_s": {
      if (!INT_RE.test(t)) return { error: "Enter a whole number" };
      const err = checkBounds(f, Number(t));
      return err ? { error: err } : { value: Number(t) };
    }
    case "decimal":
    case "percent": {
      const n = t.replace(",", ".");
      if (!DEC_RE.test(n)) return { error: f.type === "percent" ? "Enter a fraction, e.g. 0.04" : "Enter a number" };
      const err = checkBounds(f, Number(n));
      return err ? { error: err } : { value: n };
    }
    case "symbol":
      return /^[A-Z0-9^][A-Z0-9.\-=^]{0,19}$/.test(t.toUpperCase()) ? { value: t.toUpperCase() } : { error: "Not a valid symbol" };
    case "symbol_list": {
      const items = t.split(/[\s,]+/).filter(Boolean).map((s) => s.toUpperCase());
      return { value: [...new Set(items)] };
    }
    case "percent_list": {
      const items = t.split(/[\s,;]+/).filter(Boolean);
      for (const i of items) {
        if (!DEC_RE.test(i)) return { error: `${i} is not a number` };
        const err = checkBounds(f, Number(i));
        if (err) return { error: `${i}: ${err}` };
      }
      return { value: items };
    }
    case "time_hm":
      return /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? { value: t } : { error: "Use HH:MM" };
    case "json_map": {
      try {
        const parsed: unknown = JSON.parse(t);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "Expected a JSON object" };
        const entries = Object.entries(parsed as Record<string, unknown>);
        if (entries.some(([, v]) => typeof v !== "string")) return { error: "Values must be text" };
        return { value: Object.fromEntries(entries) as Record<string, string> };
      } catch {
        return { error: "Not valid JSON" };
      }
    }
    default:
      return { value: t };
  }
}

export function draftToValue(f: FieldDef, d: DraftValue): { value: SettingJson } | { error: string } {
  return "text" in d ? parseText(f, d.text) : { value: d.value };
}

function timezoneOptions(current: string): { value: string; label: string }[] {
  let zones: string[] = [];
  try {
    zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    zones = [];
  }
  const all = [...new Set([...zones, current].filter((z) => z && !["Browser", "Local", "UTC"].includes(z)))].sort();
  return [
    { value: "Browser", label: "Browser (this device)" },
    { value: "Local", label: "Local (this device)" },
    { value: "UTC", label: "UTC" },
    ...all.map((z) => ({ value: z, label: z.replace(/_/g, " ") })),
  ];
}

function humanDuration(seconds: number): string {
  if (seconds < 120) return `${seconds} s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172800) return `${+(seconds / 3600).toFixed(1)} h`;
  return `${+(seconds / 86400).toFixed(1)} days`;
}

const SOURCE_LABEL: Record<SettingValue["source"], string> = { db: "App", env: "Env", default: "Default" };
const SOURCE_TIP: Record<SettingValue["source"], string> = {
  db: "Set in the app (wins over the server env file)",
  env: "From the server env file",
  default: "Built-in default",
};

export interface SettingFieldProps {
  field: FieldDef;
  value: SettingValue | undefined;
  draft: DraftValue | undefined;
  /** Client-side or server (422) message. */
  error?: string;
  onDraft: (d: DraftValue | undefined) => void;
  onReset: () => void;
  onHistory: () => void;
  resetting?: boolean;
}

export function SettingField({ field: f, value, draft, error, onDraft, onReset, onHistory, resetting }: SettingFieldProps) {
  const id = useId();
  const [replacing, setReplacing] = useState(false);
  const current = value?.value ?? null;
  const dirty = draft !== undefined;
  const source = value?.source ?? "default";

  const shown: SettingJson = draft === undefined ? current : "value" in draft ? draft.value : null;
  const text = draft && "text" in draft ? draft.text : toText(f, current);
  const setChoice = (v: SettingJson) => onDraft(JSON.stringify(v) === JSON.stringify(current) ? undefined : { value: v });
  const setText = (t: string) => onDraft(t === toText(f, current) ? undefined : { text: t });

  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const aria = { id, "aria-describedby": error ? `${errId} ${hintId}` : hintId, invalid: Boolean(error) };

  let control;
  if (f.secret) {
    control = (
      <div className="setting-field__secret">
        <span className={clsx("setting-field__secret-state", value?.is_set && "setting-field__secret-state--set")}>
          <KeyRound aria-hidden size={14} /> {value?.is_set ? "Set" : "Not set"}
          {!value?.is_set && value?.env_value_present ? " (env value in use)" : ""}
        </span>
        {replacing || dirty ? (
          <Input
            {...aria}
            type="password"
            autoComplete="off"
            placeholder="New value"
            value={draft && "text" in draft ? draft.text : ""}
            onChange={(e) => onDraft(e.target.value ? { text: e.target.value } : undefined)}
          />
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setReplacing(true)}>
            {value?.is_set ? "Replace" : "Set"}
          </Button>
        )}
        {source === "db" && !dirty && (
          <Button size="sm" variant="ghost" loading={resetting} onClick={onReset}>
            Clear
          </Button>
        )}
      </div>
    );
  } else if (f.type === "bool") {
    control = (
      <SegmentedControl
        ariaLabel={f.label}
        options={[
          { value: "true", label: "On" },
          { value: "false", label: "Off" },
        ]}
        value={String(Boolean(shown))}
        onChange={(v) => setChoice(v === "true")}
      />
    );
  } else if (f.key === TIMEZONE_KEY) {
    control = (
      <Select
        id={id}
        ariaLabel={f.label}
        invalid={Boolean(error)}
        options={timezoneOptions(String(shown ?? ""))}
        value={String(shown ?? "Browser")}
        onValueChange={(v) => setChoice(v)}
      />
    );
  } else if (f.choices.length > 0) {
    const options = f.choices.map((c) => ({ value: c, label: choiceLabel(c) }));
    control =
      options.length <= 4 ? (
        <SegmentedControl ariaLabel={f.label} options={options} value={String(shown ?? "")} onChange={(v) => setChoice(v)} />
      ) : (
        <Select
          id={id}
          ariaLabel={f.label}
          invalid={Boolean(error)}
          options={options}
          value={String(shown ?? "")}
          onValueChange={(v) => setChoice(v)}
        />
      );
  } else if (f.type === "json_map") {
    control = (
      <textarea
        id={id}
        aria-describedby={aria["aria-describedby"]}
        aria-invalid={error ? true : undefined}
        className={clsx("setting-field__textarea", error && "setting-field__textarea--invalid")}
        rows={Math.min(10, Math.max(3, text.split("\n").length))}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    );
  } else {
    const numeric = ["int", "duration_s", "decimal", "percent"].includes(f.type);
    control = (
      <Input
        {...aria}
        type={f.type === "time_hm" ? "time" : "text"}
        inputMode={f.type === "int" || f.type === "duration_s" ? "numeric" : numeric ? "decimal" : undefined}
        placeholder={f.nullable ? "Empty = automatic" : undefined}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    );
  }

  // A small live reading of numeric values ("= 5.00%", "= 2 min").
  let reading: string | null = null;
  if (!error && !f.secret) {
    const parsed = draft ? draftToValue(f, draft) : { value: current };
    const v = "value" in parsed ? parsed.value : null;
    if (f.type === "percent" && v !== null && v !== "") reading = `= ${formatPercent(Number(v))}`;
    if (f.type === "duration_s" && typeof v === "number") reading = `= ${humanDuration(v)}`;
  }
  const bounds =
    f.min !== null && f.min !== undefined && f.max !== null && f.max !== undefined ? `${f.min}–${f.max}` : null;

  return (
    <div className={clsx("setting-field", dirty && "setting-field--dirty", error && "setting-field--invalid")} data-key={f.key}>
      <div className="setting-field__head">
        <label className="setting-field__label" htmlFor={id}>
          {f.label}
        </label>
        <span className="setting-field__badges">
          {dirty ? (
            <span className="setting-field__badge setting-field__badge--dirty">Unsaved</span>
          ) : (
            <span className={`setting-field__badge setting-field__badge--${source}`} title={SOURCE_TIP[source]}>
              {SOURCE_LABEL[source]}
            </span>
          )}
          {f.level === "advanced" && <span className="setting-field__badge">Advanced</span>}
          {f.restart_required && <span className="setting-field__badge setting-field__badge--warn">Restart needed</span>}
        </span>
        <span className="setting-field__tools">
          {dirty && (
            <IconButton size="sm" label={`Undo change to ${f.label}`} icon={<Undo2 aria-hidden />} onClick={() => { setReplacing(false); onDraft(undefined); }} />
          )}
          {!dirty && source === "db" && !f.secret && (
            <IconButton
              size="sm"
              label={`Reset ${f.label} to ${value?.env_value_present ? "the env value" : "default"}`}
              icon={<RotateCcw aria-hidden />}
              disabled={resetting}
              onClick={onReset}
            />
          )}
          <IconButton size="sm" label={`History of ${f.label}`} icon={<History aria-hidden />} onClick={onHistory} />
        </span>
      </div>
      <div className="setting-field__control">
        {control}
        {(f.unit || reading) && (
          <span className="setting-field__unit">
            {f.unit && !reading ? f.unit : null}
            {reading}
          </span>
        )}
      </div>
      {error && (
        <p className="setting-field__error" id={errId} role="alert">
          {error}
        </p>
      )}
      <p className="setting-field__help" id={hintId}>
        {f.help}
        {bounds && <span className="setting-field__meta"> Range {bounds}{f.unit ? ` ${f.unit}` : ""}.</span>}
        {!f.secret && source !== "default" && (
          <span className="setting-field__meta"> Default: {toText(f, f.default) || "empty"}.</span>
        )}
        {value?.env_value_present && source === "db" && (
          <span className="setting-field__meta"> Overrides the server env value.</span>
        )}
        {f.env_bound && <span className="setting-field__meta"> The server env sets the {f.env_bound === "ceiling" ? "maximum" : "minimum"}.</span>}
        {f.danger && <span className="setting-field__danger"> {f.danger}</span>}
        {value?.stored_invalid && (
          <span className="setting-field__danger"> The stored value was invalid, so the default is used.</span>
        )}
      </p>
    </div>
  );
}
