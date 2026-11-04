import { AlertTriangle, Check, Undo2 } from "lucide-react";
import type { ImportPreview } from "../../lib/queries/ledger";
import type { RowFix } from "../../lib/queries/imports";
import { formatQuantity } from "../Transactions/numbers";

type PreviewRow = ImportPreview["rows"][number];

const FIX_LABELS: Record<RowFix, string> = {
  keep: "Keep as is",
  fix_price: "Fix price",
  skip: "Skip row",
};

const DONE_LABELS: Record<RowFix, string> = {
  keep: "Kept as in the file",
  fix_price: "Price recalculated from the amount",
  skip: "Skipped, not imported",
};

const FIX_HINTS: Record<RowFix, string> = {
  keep: "Import the row exactly as the file has it",
  fix_price: "Keep amount and quantity, work the price out from them",
  skip: "Leave this row out of the import",
};

const RECONCILE = /^amount (-?[\d.]+) does not reconcile with quantity\*price \((-?[\d.]+)\*(-?[\d.]+)=(-?[\d.]+)\)$/;

/** A number from the message in the app's locale, without its sign. */
const plain = (s: string) => formatQuantity(s.replace(/^-/, ""));

/** The server's check message in plain words ("Amount 1,300 doesn't match 5 × 220 = 1,100"). */
export function describeWarning(message: string): string {
  const m = RECONCILE.exec(message);
  if (m) {
    const [, amount, qty, price, product] = m;
    return `Amount ${plain(amount)} doesn't match ${plain(qty)} × ${plain(price)} = ${plain(product)}`;
  }
  return message.charAt(0).toUpperCase() + message.slice(1);
}

export const isFlagged = (r: PreviewRow) => (r.warnings ?? []).length > 0;
export const isOpen = (r: PreviewRow) => isFlagged(r) && !r.resolution;

export interface RowCheckProps {
  row: PreviewRow;
  busy: boolean;
  onResolve: (fix: RowFix | null) => void;
}

/** The warning for one preview row, right in the table, with the ways to resolve it. */
export function RowCheck({ row, busy, onResolve }: RowCheckProps) {
  if (!isFlagged(row)) return null;
  const warnings = row.warnings ?? [];
  if (row.resolution) {
    return (
      <span className="import-page__check import-page__check--done">
        <Check className="import-page__check-icon" aria-hidden />
        <span className="import-page__check-text">{DONE_LABELS[row.resolution]}</span>
        <button
          type="button"
          className="import-page__check-undo"
          disabled={busy}
          onClick={() => onResolve(null)}
          aria-label={`Undo the choice for row ${row.index}`}
        >
          <Undo2 className="import-page__check-undo-icon" aria-hidden /> Undo
        </button>
      </span>
    );
  }
  return (
    <span className="import-page__check">
      <span className="import-page__check-head">
        <AlertTriangle className="import-page__check-icon import-page__check-icon--warn" aria-hidden />
        <span className="import-page__check-text">
          <span className="u-sr-only">Warning: </span>
          {warnings.map(describeWarning).join("; ")}
        </span>
      </span>
      <span className="import-page__check-fixes">
        {(row.fixes ?? []).map((fix) => (
          <button
            key={fix}
            type="button"
            className={`import-page__fix import-page__fix--${fix}`}
            title={FIX_HINTS[fix]}
            disabled={busy}
            onClick={() => onResolve(fix)}
          >
            {FIX_LABELS[fix]}
          </button>
        ))}
      </span>
    </span>
  );
}
