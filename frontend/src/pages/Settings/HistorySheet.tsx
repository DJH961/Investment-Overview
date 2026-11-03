import { RotateCcw } from "lucide-react";
import { Button } from "../../components/Button";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { Sheet } from "../../components/Sheet";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { formatDateTime } from "../../lib/format";
import {
  errorMessage,
  useRevertSetting,
  useSettingsHistory,
  type SettingField,
} from "../../lib/queries/settings";

export interface HistorySheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** One setting's history, or every change (`null`). */
  settingKey: string | null;
  fields: Record<string, SettingField>;
}

const ACTION_LABEL = { set: "Changed", reset: "Reset", import: "Imported", revert: "Reverted" } as const;
const show = (v: string | null) => (v === null || v === "" ? "default" : v);

export function HistorySheet({ open, onOpenChange, settingKey, fields }: HistorySheetProps) {
  const q = useSettingsHistory(settingKey, open);
  const revert = useRevertSetting();
  const { toast } = useToast();
  const title = settingKey ? `History: ${fields[settingKey]?.label ?? settingKey}` : "Settings history";

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title}>
      {q.isError && !q.data ? (
        <ErrorState onRetry={() => void q.refetch()} />
      ) : q.isPending ? (
        <Skeleton height="160px" />
      ) : q.data.length === 0 ? (
        <EmptyState title="No changes yet" description="Every change made in the app is listed here." />
      ) : (
        <ol className="settings-history">
          {q.data.map((row) => {
            const field = fields[row.key];
            return (
              <li key={row.id} className="settings-history__row">
                <div className="settings-history__main">
                  <span className="settings-history__key">{field?.label ?? row.key}</span>
                  <span className="settings-history__change">
                    {ACTION_LABEL[row.action]}: <code className="settings-history__value">{show(row.old_value)}</code> →{" "}
                    <code className="settings-history__value">{show(row.new_value)}</code>
                  </span>
                  <span className="settings-history__meta">
                    {formatDateTime(row.changed_at)} · {row.actor}
                  </span>
                </div>
                {!field?.secret && (
                  <Button
                    size="sm"
                    variant="ghost"
                    leftIcon={<RotateCcw aria-hidden />}
                    loading={revert.isPending && revert.variables === row.id}
                    onClick={() =>
                      revert.mutate(row.id, {
                        onSuccess: () => {
                          toast({ title: `Reverted ${field?.label ?? row.key}`, tone: "success" });
                          void q.refetch();
                        },
                        onError: (e) => toast({ title: "Could not revert", description: errorMessage(e), tone: "error" }),
                      })
                    }
                  >
                    Revert
                  </Button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Sheet>
  );
}
