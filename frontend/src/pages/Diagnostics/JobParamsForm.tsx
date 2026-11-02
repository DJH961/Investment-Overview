import { Field } from "../../components/Field";
import { Input } from "../../components/Input";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Select } from "../../components/Select";
import { useBackups, useInstrumentList, type JobParam } from "../../lib/queries/maintenance";

export type JobParams = Record<string, unknown>;

export function defaultParams(params: JobParam[], preset: JobParams = {}): JobParams {
  const out: JobParams = {};
  for (const p of params) {
    if (p.name in preset) out[p.name] = preset[p.name];
    else if (p.default !== undefined && p.default !== null) out[p.name] = p.default;
  }
  return out;
}

/** Required params that are still empty. */
export function missingParams(params: JobParam[], values: JobParams): string[] {
  return params.filter((p) => p.required && (values[p.name] === undefined || values[p.name] === "")).map((p) => p.label);
}

function InstrumentSelect({ id, value, onChange }: { id: string; value: unknown; onChange: (v: number) => void }) {
  const q = useInstrumentList();
  const options = (q.data ?? []).map((i) => ({ value: String(i.id), label: i.name ? `${i.symbol} · ${i.name}` : i.symbol }));
  return (
    <Select
      id={id}
      ariaLabel="Instrument"
      placeholder={q.isPending ? "Loading…" : "Choose an instrument"}
      options={options}
      value={value === undefined ? "" : String(value)}
      onValueChange={(v) => onChange(Number(v))}
    />
  );
}

function BackupSelect({ id, value, onChange }: { id: string; value: unknown; onChange: (v: string) => void }) {
  const q = useBackups();
  const options = (q.data?.snapshots ?? []).map((s) => ({ value: s.name, label: s.name }));
  return (
    <Select
      id={id}
      ariaLabel="Snapshot"
      placeholder={q.isPending ? "Loading…" : options.length ? "Choose a snapshot" : "No snapshots yet"}
      options={options}
      value={typeof value === "string" ? value : ""}
      onValueChange={onChange}
    />
  );
}

/** Generic form for a job's param schema (bool / int / date / enum / string). */
export function JobParamsForm({
  jobId,
  params,
  values,
  errors = {},
  onChange,
}: {
  jobId: string;
  params: JobParam[];
  values: JobParams;
  errors?: Record<string, string>;
  onChange: (next: JobParams) => void;
}) {
  if (params.length === 0) return null;
  const set = (name: string, v: unknown) => onChange({ ...values, [name]: v });
  return (
    <div className="repair__params">
      {params.map((p) => (
        <Field key={p.name} label={p.label + (p.required ? "" : " (optional)")} hint={p.help || undefined} error={errors[p.name]}>
          {(c) => {
            const v = values[p.name];
            if (p.type === "bool")
              return (
                <SegmentedControl
                  size="sm"
                  ariaLabel={p.label}
                  options={[
                    { value: "true", label: "Yes" },
                    { value: "false", label: "No" },
                  ]}
                  value={String(Boolean(v))}
                  onChange={(x) => set(p.name, x === "true")}
                />
              );
            if (p.type === "enum")
              return p.choices.length <= 4 ? (
                <SegmentedControl
                  size="sm"
                  ariaLabel={p.label}
                  options={p.choices.map((ch) => ({ value: ch, label: ch }))}
                  value={String(v ?? "")}
                  onChange={(x) => set(p.name, x)}
                />
              ) : (
                <Select id={c.id} options={p.choices.map((ch) => ({ value: ch, label: ch }))} value={String(v ?? "")} onValueChange={(x) => set(p.name, x)} />
              );
            if (p.name === "instrument_id") return <InstrumentSelect id={c.id} value={v} onChange={(x) => set(p.name, x)} />;
            if (jobId === "backup.verify" && p.name === "name")
              return <BackupSelect id={c.id} value={v} onChange={(x) => set(p.name, x)} />;
            return (
              <Input
                {...c}
                type={p.type === "date" ? "date" : "text"}
                inputMode={p.type === "int" ? "numeric" : undefined}
                value={v === undefined || v === null ? "" : String(v)}
                onChange={(e) => {
                  const raw = e.target.value;
                  set(p.name, raw === "" ? undefined : p.type === "int" && /^-?\d+$/.test(raw) ? Number(raw) : raw);
                }}
              />
            );
          }}
        </Field>
      ))}
    </div>
  );
}
