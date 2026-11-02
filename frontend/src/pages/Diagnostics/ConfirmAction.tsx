import { useState, type ReactNode } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Field } from "../../components/Field";
import { Input } from "../../components/Input";

export interface ConfirmActionProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  danger: "confirm" | "typed";
  /** The word to type for `typed` (server-checked too). */
  confirmWord?: string | null;
  backupFirst?: boolean;
  confirmLabel?: string;
  loading?: boolean;
  error?: ReactNode;
  /** Gets "yes" (confirm) or the typed word. */
  onConfirm: (confirm: string) => void;
}

/** "Are you sure?" dialog; `typed` needs the action word typed exactly. */
export function ConfirmAction({
  open,
  onOpenChange,
  title,
  description,
  danger,
  confirmWord,
  backupFirst,
  confirmLabel = "Run",
  loading,
  error,
  onConfirm,
}: ConfirmActionProps) {
  const [typed, setTyped] = useState("");
  const word = confirmWord ?? "RESET";
  const ok = danger === "confirm" || typed.trim() === word;
  const close = (o: boolean) => {
    if (!o) setTyped("");
    onOpenChange(o);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!ok}
            loading={loading}
            onClick={() => onConfirm(danger === "typed" ? typed.trim() : "yes")}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {backupFirst && (
        <p className="repair__note">A sealed backup of the database is taken automatically before this runs.</p>
      )}
      {danger === "typed" && (
        <Field label={`Type ${word} to confirm`}>
          {(c) => (
            <Input {...c} autoComplete="off" autoCapitalize="characters" value={typed} onChange={(e) => setTyped(e.target.value)} />
          )}
        </Field>
      )}
      {error && (
        <p className="repair__error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
