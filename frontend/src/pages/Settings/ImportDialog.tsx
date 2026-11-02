import { useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { useToast } from "../../components/Toast";
import {
  errorMessage,
  fieldErrors,
  useImportSettings,
  type SettingField,
  type SettingJson,
  type SettingsImportResult,
} from "../../lib/queries/settings";

const show = (v: SettingJson) =>
  v === null || v === undefined ? "default" : typeof v === "object" ? JSON.stringify(v) : String(v);

/** Import a settings JSON: a dry run shows the diff first, then Apply writes it. */
export function ImportDialog({
  open,
  onOpenChange,
  fields,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fields: Record<string, SettingField>;
}) {
  const imp = useImportSettings();
  const { toast } = useToast();
  const [payload, setPayload] = useState<unknown>(null);
  const [diff, setDiff] = useState<SettingsImportResult["diff"] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const close = (o: boolean) => {
    if (!o) {
      setPayload(null);
      setDiff(null);
      setError(null);
    }
    onOpenChange(o);
  };

  const onFile = async (file: File | undefined) => {
    setDiff(null);
    setError(null);
    if (!file) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setError("That file is not valid JSON.");
      return;
    }
    setPayload(parsed);
    imp.mutate(
      { payload: parsed, dryRun: true },
      {
        onSuccess: (r) => setDiff(r.diff),
        onError: (e) => {
          const errs = Object.entries(fieldErrors(e));
          setError(errs.length ? errs.map(([k, m]) => `${fields[k]?.label ?? k}: ${m}`).join(" · ") : (errorMessage(e) ?? "Could not read the file."));
        },
      },
    );
  };

  const apply = () =>
    imp.mutate(
      { payload, dryRun: false },
      {
        onSuccess: (r) => {
          toast({ title: `Imported ${r.diff.length} setting(s)`, tone: "success" });
          close(false);
        },
        onError: (e) => setError(errorMessage(e) ?? "Import failed."),
      },
    );

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="Import settings"
      description="Choose a settings file exported from this app. You will see what changes before anything is saved."
      footer={
        <>
          <Button variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!diff || diff.length === 0} loading={imp.isPending && payload !== null && diff !== null} onClick={apply}>
            Apply {diff ? diff.length : ""} change(s)
          </Button>
        </>
      }
    >
      <input
        className="settings__file"
        type="file"
        accept="application/json,.json"
        aria-label="Settings file"
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      {error && (
        <p className="settings__error" role="alert">
          {error}
        </p>
      )}
      {diff && diff.length === 0 && <p className="settings__muted">Nothing would change.</p>}
      {diff && diff.length > 0 && (
        <ul className="settings-diff">
          {diff.map((d) => (
            <li key={d.key} className="settings-diff__row">
              <span className="settings-diff__key">{fields[d.key]?.label ?? d.key}</span>
              <span className="settings-diff__values">
                <code className="settings-diff__value">{show(d.current)}</code> →{" "}
                <code className="settings-diff__value">{show(d.new)}</code>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
