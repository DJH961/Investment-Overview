import { RefreshCw } from "lucide-react";
import { Button } from "../../components/Button";
import { Select, type SelectOption } from "../../components/Select";
import { useToast } from "../../components/Toast";
import type { ImportPreview } from "../../lib/queries/ledger";
import { useReparseImport, useSetActionOverride, useUnknownActions } from "../../lib/queries/imports";

const UNMAPPED = "__unmapped__";

const targetLabel = (t: string) => (t === "ignore" ? "Ignore (skip these rows)" : t.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()));

/**
 * Map broker actions the importer did not recognise to a transaction kind
 * (saved per broker in `import.action_overrides.<broker>`), then parse the
 * staged file again so the preview picks the mapping up.
 */
export function UnknownActions({ preview, onReparsed }: { preview: ImportPreview; onReparsed: (p: ImportPreview) => void }) {
  const { toast } = useToast();
  const info = useUnknownActions(preview.import_id);
  const setOverride = useSetActionOverride();
  const reparse = useReparseImport();

  if (!info.data || info.data.actions.length === 0 || !info.data.broker) return null;
  const broker = info.data.broker;
  const overrides = info.data.overrides;
  const options: SelectOption[] = [
    { value: UNMAPPED, label: "Not mapped" },
    ...info.data.targets.map((t) => ({ value: t, label: targetLabel(t) })),
  ];
  const mapped = info.data.actions.filter((a) => overrides[a.action]).length;

  const change = (action: string, value: string) =>
    setOverride.mutate(
      { broker, action, kind: value === UNMAPPED ? null : value },
      { onError: (e) => toast({ title: "Could not save the mapping", description: e.message, tone: "error" }) },
    );

  const rerun = () =>
    reparse.mutate(preview.import_id, {
      onSuccess: (p) => {
        toast({ title: "Preview updated with your mappings", tone: "success" });
        onReparsed(p);
      },
      onError: (e) => toast({ title: "Re-parse failed", description: e.message, tone: "error" }),
    });

  return (
    <section className="import-page__unknown" aria-label="Unknown actions">
      <h3 className="import-page__unknown-title">Unknown actions</h3>
      <p className="import-page__note">
        These {broker} actions are not recognised, so their rows are skipped. Map each one to a kind (saved for future
        imports from this broker), then re-parse.
      </p>
      <ul className="import-page__unknown-list">
        {info.data.actions.map((a) => (
          <li key={a.action} className="import-page__unknown-row">
            <span className="import-page__unknown-action">
              {a.action} <span className="import-page__note">({a.count})</span>
            </span>
            <Select
              ariaLabel={`Kind for ${a.action}`}
              options={options}
              value={overrides[a.action] ?? UNMAPPED}
              onValueChange={(v) => change(a.action, v)}
            />
          </li>
        ))}
      </ul>
      <div className="import-page__actions">
        <Button variant="secondary" leftIcon={<RefreshCw aria-hidden />} loading={reparse.isPending} disabled={mapped === 0} onClick={rerun}>
          Re-parse with these mappings
        </Button>
      </div>
    </section>
  );
}
