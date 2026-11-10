import { Undo2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { DataTable, type Column } from "../../components/DataTable";
import { Dialog } from "../../components/Dialog";
import { ErrorState } from "../../components/ErrorState";
import { Field } from "../../components/Field";
import { Input } from "../../components/Input";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { ApiError } from "../../lib/api";
import { formatDate, formatDateTime } from "../../lib/format";
import {
  useImportBatches,
  useUndoBatch,
  useUndoPreview,
  type ImportBatch,
  type ImportUndoPreview,
} from "../../lib/queries/imports";
import { formatQuantity } from "../Transactions/numbers";

const statusLabel = (b: ImportBatch) => (b.status === "undone" ? "Undone" : b.can_undo ? "Active" : "Active (locked)");

/** What a failed undo means, in plain words (403 = needs a fresh browser sign-in). */
export function undoErrorMessage(error: unknown): { text: string; reauth: boolean } {
  if (error instanceof ApiError && error.status === 403)
    return {
      text: "Undo needs a recent sign-in in this browser (the API token is not enough). Sign in again, then retry.",
      reauth: true,
    };
  if (error instanceof ApiError && error.status === 409)
    return { text: `${error.message} Nothing was deleted.`, reauth: false };
  return { text: error instanceof Error ? error.message : "Undo failed", reauth: false };
}

function UndoDialog({ batchId, onClose }: { batchId: number; onClose: () => void }) {
  const { toast } = useToast();
  const preview = useUndoPreview(batchId);
  const undo = useUndoBatch();
  const [typed, setTyped] = useState("");
  const word = preview.data?.confirm_word ?? "UNDO";
  const failure = undo.isError ? undoErrorMessage(undo.error) : null;

  const run = () =>
    undo.mutate(
      { id: batchId, confirm: typed.trim() },
      {
        onSuccess: (r) => {
          toast({
            title: `Undid import - ${r.deleted} transactions removed`,
            description: r.backup ? `A backup was taken first (${r.backup}).` : undefined,
            tone: "success",
          });
          onClose();
        },
      },
    );

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Undo import?"
      description="This deletes every transaction this import added. A backup is taken first; history from the earliest date is recalculated."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={undo.isPending}
            disabled={!preview.data || typed.trim() !== word || !preview.data.batch.can_undo}
            onClick={run}
          >
            Undo import
          </Button>
        </>
      }
    >
      {preview.isPending ? (
        <Skeleton height="8rem" />
      ) : preview.isError && !preview.data ? (
        <ErrorState title="Could not load the preview" message={preview.error.message} onRetry={() => void preview.refetch()} />
      ) : (
        <UndoPreviewBody preview={preview.data} />
      )}
      {preview.data && (
        <Field label={`Type ${word} to confirm`} error={undo.isError && !failure?.reauth ? failure?.text : undefined}>
          {(c) => (
            <Input
              id={c.id}
              aria-describedby={c["aria-describedby"]}
              autoComplete="off"
              value={typed}
              invalid={c.invalid}
              onChange={(e) => setTyped(e.target.value)}
            />
          )}
        </Field>
      )}
      {failure?.reauth && (
        <p className="import-page__error" role="alert">
          {failure.text}{" "}
          <Link to="/login" className="import-page__link">
            Sign in again
          </Link>
        </p>
      )}
    </Dialog>
  );
}

function UndoPreviewBody({ preview }: { preview: ImportUndoPreview }) {
  const b = preview.batch;
  return (
    <div className="import-page__undo">
      <p className="import-page__note">
        {preview.total} transactions in {b.account_label ?? `account ${b.account_id}`} from {b.filename}
        {preview.earliest_date &&
          ` (${formatDate(preview.earliest_date)} - ${formatDate(preview.latest_date ?? preview.earliest_date, "short")})`}
        .
        {preview.detached > 0 && ` ${preview.detached} rows were edited since and are removed too.`}
      </p>
      {!b.can_undo && <p className="import-page__error">This import can no longer be undone.</p>}
      <ul className="import-page__undo-rows" aria-label="Rows to delete">
        {preview.rows.map((r) => (
          <li key={r.id} className="import-page__undo-row">
            <span>{formatDate(r.date)}</span>
            <span>{r.kind}</span>
            <span>{r.symbol || "—"}</span>
            <span className="import-page__num">{r.quantity ? formatQuantity(r.quantity) : ""}</span>
          </li>
        ))}
      </ul>
      {preview.rows_truncated && <p className="import-page__note">Showing the first {preview.rows.length} rows.</p>}
    </div>
  );
}

export function ImportHistory({ highlight }: { highlight?: number | null }) {
  const batches = useImportBatches();
  const [undoing, setUndoing] = useState<number | null>(null);

  const columns: Column<ImportBatch>[] = [
    { key: "created", header: "Imported", cell: (b) => formatDateTime(b.created_at), nowrap: true },
    { key: "file", header: "File", primary: true, cell: (b) => <span className="import-page__file-name">{b.filename}</span> },
    { key: "account", header: "Account", cell: (b) => b.account_label ?? `#${b.account_id}`, phone: "hide" },
    { key: "broker", header: "Broker", cell: (b) => b.broker, phone: "hide" },
    {
      key: "rows",
      header: "Rows",
      align: "right",
      cell: (b) => (b.status === "undone" ? `${b.undone_rows ?? 0} removed` : `${b.current_rows} of ${b.row_count}`),
    },
    { key: "dups", header: "Duplicates", align: "right", cell: (b) => b.duplicate_count, phone: "hide" },
    {
      key: "status",
      header: "Status",
      cell: (b) => (
        <span className={`import-page__status import-page__status--${b.status}`} title={b.undone_at ? `Undone ${formatDateTime(b.undone_at)}` : undefined}>
          {statusLabel(b)}
        </span>
      ),
    },
    {
      key: "undo",
      header: "",
      cell: (b) =>
        b.can_undo ? (
          <Button size="sm" variant="ghost" leftIcon={<Undo2 aria-hidden />} onClick={() => setUndoing(b.id)} aria-label={`Undo import ${b.filename}`}>
            Undo
          </Button>
        ) : null,
    },
  ];

  return (
    <Card title="Import history" subtitle={batches.data?.note} collapsibleId="import.history" flush>
      {batches.isPending ? (
        <Skeleton height="6rem" />
      ) : batches.isError && !batches.data ? (
        <ErrorState title="Could not load import history" message={batches.error.message} onRetry={() => void batches.refetch()} />
      ) : (
        <DataTable
          caption="Import history"
          columns={columns}
          rows={batches.data.batches}
          rowKey={(b) => String(b.id)}
          rowClassName={(b) => b.id === highlight && "import-page__batch--new"}
          emptyMessage="No imports recorded yet."
        />
      )}
      {undoing !== null && <UndoDialog batchId={undoing} onClose={() => setUndoing(null)} />}
    </Card>
  );
}
