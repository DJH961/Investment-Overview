import { AlertTriangle, Check, RefreshCw, Undo2 } from "lucide-react";
import type { ImportPreview } from "../../lib/queries/ledger";
import type { RowFix } from "../../lib/queries/imports";
import { formatDate, formatMoney } from "../../lib/format";
import { formatPrice, formatQuantity, num } from "../Transactions/numbers";

type PreviewRow = ImportPreview["rows"][number];

const FIX_LABELS: Record<RowFix, string> = {
  keep: "Keep as is",
  fix_price: "Fix price",
  skip: "Skip row",
  import_new: "Import as new",
};

const DONE_LABELS: Record<RowFix, string> = {
  keep: "Kept as in the file",
  fix_price: "Price recalculated from the amount",
  skip: "Skipped, not imported",
  import_new: "Will be imported as a new row, not an update",
};

const FIX_HINTS: Record<RowFix, string> = {
  keep: "Import the row exactly as the file has it",
  fix_price: "Keep amount and quantity, work the price out from them",
  skip: "Leave this row out of the import",
  import_new: "Add it as a new transaction and keep the existing one unchanged",
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

/** "$20.00": the size of an amount (the sign is the kind's business). */
const absMoney = (v: string | null | undefined, currency: string) => {
  const n = num(v);
  return n === null ? "–" : formatMoney(Math.abs(n), currency, { unmasked: true });
};

/** "Update $20.00 → $19.99": the headline of a near-match row. */
export function updateHeadline(row: PreviewRow): string {
  const figures = `${absMoney(row.existing?.net_native, row.currency)} → ${absMoney(row.net_native, row.currency)}`;
  return row.existing?.estimated ? `Est. → confirmed ${figures}` : `Update ${figures}`;
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
  const update = row.existing && row.status !== "skipped" ? <UpdateFigures row={row} busy={busy} onResolve={onResolve} /> : null;
  const check = <FlagCheck row={row} busy={busy} onResolve={onResolve} />;
  if (!update) return check;
  return (
    <span className="import-page__check-stack">
      {update}
      {check}
    </span>
  );
}

/** Old and new figures of a row that would update an existing transaction. */
function UpdateFigures({ row, busy, onResolve }: RowCheckProps) {
  const old = row.existing;
  if (!old) return null;
  const asNew = row.status !== "update";
  const figures: [string, string, string][] = [
    ["Date", formatDate(old.date), formatDate(row.date)],
    ["Qty", old.quantity ? formatQuantity(old.quantity) : "–", row.quantity ? formatQuantity(row.quantity) : "–"],
    ["Price", formatPrice(old.price_native, row.currency), formatPrice(row.price_native, row.currency)],
    ["Net", absMoney(old.net_native, row.currency), absMoney(row.net_native, row.currency)],
  ];
  return (
    <span className="import-page__update">
      <span className="import-page__update-head">
        <RefreshCw className="import-page__check-icon" aria-hidden />
        <span className="import-page__check-text">
          {asNew ? "Matches an existing transaction, imported as new" : updateHeadline(row)}
        </span>
      </span>
      <span className="import-page__update-figures">
        {figures.map(([label, was, now]) => (
          <span key={label} className="import-page__update-figure">
            {label} {was} → {now}
          </span>
        ))}
      </span>
      {asNew ? (
        <button type="button" className="import-page__fix" disabled={busy} onClick={() => onResolve(null)}>
          Update instead
        </button>
      ) : (
        !row.resolution && (
          <span className="import-page__check-fixes">
            {(["skip", "import_new"] as const)
              .filter((fix) => (row.fixes ?? []).includes(fix))
              .map((fix) => (
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
        )
      )}
    </span>
  );
}

/** The warning for one preview row (consistency checks) and a resolved skip/new choice. */
function FlagCheck({ row, busy, onResolve }: RowCheckProps) {
  const resolved = row.resolution && (row.status === "skipped" || isFlagged(row));
  if (!isFlagged(row) && !resolved) return null;
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
