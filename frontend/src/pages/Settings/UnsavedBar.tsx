import type { ReactNode } from "react";
import { Button } from "../../components/Button";

export interface UnsavedBarProps {
  count: number;
  /** A client-side check failed: saving is blocked until it is fixed. */
  invalid: boolean;
  saving: boolean;
  note?: ReactNode;
  onSave: () => void;
  onDiscard: () => void;
}

/** Sticky "n unsaved changes · Discard · Save" bar; one PATCH per save. */
export function UnsavedBar({ count, invalid, saving, note, onSave, onDiscard }: UnsavedBarProps) {
  if (count === 0 && !note) return null;
  return (
    <section className="unsaved-bar" aria-label="Unsaved changes">
      <div className="unsaved-bar__text">
        <strong className="unsaved-bar__count">
          {count === 0 ? "No unsaved changes" : `${count} unsaved change${count === 1 ? "" : "s"}`}
        </strong>
        {invalid && <span className="unsaved-bar__note">Fix the marked fields first.</span>}
        {note && (
          <span className="unsaved-bar__note" role="alert">
            {note}
          </span>
        )}
      </div>
      {count > 0 && (
        <div className="unsaved-bar__actions">
          <Button variant="ghost" onClick={onDiscard} disabled={saving}>
            Discard
          </Button>
          <Button variant="primary" onClick={onSave} loading={saving} disabled={invalid}>
            Save
          </Button>
        </div>
      )}
    </section>
  );
}
