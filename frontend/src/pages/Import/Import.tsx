import { AlertTriangle, CheckCircle2, FileUp } from "lucide-react";
import { useMemo, useRef, useState, type DragEvent } from "react";
import { Link } from "react-router";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { DataTable, type Column } from "../../components/DataTable";
import { ErrorState } from "../../components/ErrorState";
import { Field } from "../../components/Field";
import { Money } from "../../components/Money";
import { PageHeader } from "../../components/PageHeader";
import { Select, type SelectOption } from "../../components/Select";
import { useToast } from "../../components/Toast";
import {
  useConfirmImport,
  useDiscardImport,
  useUploadImport,
  type ImportConfirmResult,
  type ImportPreview,
} from "../../lib/queries/ledger";
import { useAccounts, useImportBrokers } from "../../lib/queries/accounts";
import { formatDate } from "../../lib/format";
import { useLeaveGuard } from "../../lib/useLeaveGuard";
import { useResolveImport, type RowFix } from "../../lib/queries/imports";
import { useShellStatus } from "../../lib/shell";
import { formatPrice, formatQuantity, num } from "../Transactions/numbers";
import { AccountEditor } from "../Settings/AccountsCard";
import { ColumnMapping } from "./ColumnMapping";
import { ImportHistory } from "./ImportHistory";
import { isFlagged, isOpen, RowCheck } from "./RowCheck";
import { UnknownActions } from "./UnknownActions";
import "./Import.scss";

type PreviewRow = ImportPreview["rows"][number];

const AUTO = "auto";
const NEW_ACCOUNT = "__new__";
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const dash = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? "—" : v);

function previewColumns(busy: boolean, onResolve: (row: PreviewRow, fix: RowFix | null) => void): Column<PreviewRow>[] {
  return [
  { key: "index", header: "#", cell: (r) => r.index, sortValue: (r) => r.index, phone: "hide" },
  { key: "date", header: "Date", cell: (r) => formatDate(r.date), sortValue: (r) => r.date, nowrap: true },
  { key: "symbol", header: "Symbol", primary: true, cell: (r) => dash(r.symbol), sortValue: (r) => r.symbol },
  { key: "kind", header: "Kind", cell: (r) => r.kind },
  { key: "quantity", header: "Qty", align: "right", cell: (r) => (r.quantity ? formatQuantity(r.quantity) : "–") },
  {
    key: "price",
    header: "Price",
    align: "right",
    cell: (r) => <span className="money">{formatPrice(r.price_native, r.currency)}</span>,
  },
  {
    key: "net",
    header: "Net",
    align: "right",
    cell: (r) => <Money amount={num(r.net_native)} currency={r.currency} signed colored />,
    sortValue: (r) => num(r.net_native),
  },
  {
    key: "status",
    header: "Status",
    cell: (r) => {
      const status = r.skipped ? "skipped" : r.is_duplicate ? "duplicate" : "new";
      return (
        <span className={`import-page__status import-page__status--${status}`}>
          {r.skipped ? "Skipped" : r.is_duplicate ? "Duplicate" : "New"}
        </span>
      );
    },
    sortValue: (r) => (isOpen(r) ? 0 : r.skipped ? 3 : r.is_duplicate ? 2 : 1),
  },
  {
    key: "check",
    header: "Check",
    phone: "inline",
    cell: (r) => <RowCheck row={r} busy={busy} onResolve={(fix) => onResolve(r, fix)} />,
  },
  ];
}

export function Import() {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [broker, setBroker] = useState(AUTO);
  const [account, setAccount] = useState(AUTO);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [progress, setProgress] = useState(0);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportConfirmResult | null>(null);

  const upload = useUploadImport();
  const confirm = useConfirmImport();
  const discard = useDiscardImport();
  const resolve = useResolveImport();
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const accountList = useAccounts();
  const brokerList = useImportBrokers();

  useShellStatus("closed", "Import", undefined, upload.isPending || confirm.isPending);

  const accounts = useMemo<SelectOption[]>(
    () => [
      { value: AUTO, label: "Detect from file" },
      ...(accountList.data ?? []).map((a) => ({ value: String(a.id), label: `${a.account_label} (${a.native_currency})` })),
      { value: NEW_ACCOUNT, label: "Create account..." },
    ],
    [accountList.data],
  );
  const brokers = useMemo<SelectOption[]>(
    () => [{ value: AUTO, label: "Detect from file" }, ...(brokerList.data ?? []).map((b) => ({ value: b.id, label: b.label }))],
    [brokerList.data],
  );

  const pick = (f: File | undefined) => {
    if (f) setFile(f);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    pick(e.dataTransfer.files[0]);
  };

  const startUpload = () => {
    if (!file) return;
    setProgress(0);
    upload.mutate(
      {
        file,
        broker: broker === AUTO ? undefined : broker,
        accountId: account === AUTO || account === NEW_ACCOUNT ? undefined : Number(account),
        onProgress: setProgress,
      },
      { onSuccess: setPreview },
    );
  };

  const reset = () => {
    setFile(null);
    setPreview(null);
    setResult(null);
    upload.reset();
    confirm.reset();
  };

  const discardPreview = () => {
    if (!preview) return;
    discard.mutate(preview.import_id, {
      onSettled: () => {
        toast({ title: "Import discarded" });
        reset();
      },
    });
  };

  const confirmImport = () => {
    if (!preview) return;
    confirm.mutate(preview.import_id, {
      onSuccess: (r) => {
        setResult(r);
        setPreview(null);
        toast({ title: `Imported ${plural(r.inserted, "transaction", "transactions")}`, tone: "success" });
      },
    });
  };

  const resolveRows = (rows: { index: number; action: RowFix | null }[]) => {
    if (!preview || rows.length === 0) return;
    resolve.mutate(
      { importId: preview.import_id, rows },
      {
        onSuccess: setPreview,
        onError: (e) => toast({ title: "Could not apply that", description: e.message, tone: "error" }),
      },
    );
  };
  const columns = previewColumns(resolve.isPending, (row, fix) => resolveRows([{ index: row.index, action: fix }]));

  const open = preview?.rows.filter(isOpen) ?? [];
  const unresolved = preview?.counts.unresolved ?? 0;
  const flaggedShown = preview?.rows.filter(isFlagged).length ?? 0;
  const fileWarnings = preview?.warnings.filter((w) => w.line == null) ?? [];
  const tableRows = preview ? (onlyFlagged && flaggedShown > 0 ? preview.rows.filter(isFlagged) : preview.rows) : [];

  const step = result ? 3 : preview ? 2 : 1;

  // A staged preview lives on the server: leaving asks first and cancels it there.
  const leaveGuard = useLeaveGuard({
    when: preview !== null && result === null && !confirm.isPending,
    title: "Leave this import?",
    description: "The preview and the choices you made are not saved. Leaving cancels this import; nothing is written.",
    leaveLabel: "Cancel import and leave",
    onLeave: () => {
      if (preview) discard.mutate(preview.import_id);
    },
  });

  return (
    <div className="import-page">
      {leaveGuard}
      <PageHeader title="Import" subtitle="Upload a broker export, preview, then confirm." />
      <ol className="import-page__steps" aria-label="Progress">
        {["Upload", "Preview", "Done"].map((label, i) => (
          <li key={label} className={`import-page__step${step === i + 1 ? " import-page__step--active" : ""}`}>
            {i + 1}. {label}
          </li>
        ))}
      </ol>

      {step === 1 && (
        <Card title="Upload" subtitle="Drop your file first, then pick the broker and account. The import only runs when you press Import.">
          <div className="import-page__upload">
            <div
              className={`import-page__drop${dragging ? " import-page__drop--active" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragEnter={() => {
                dragDepth.current += 1;
                setDragging(true);
              }}
              onDragLeave={() => {
                dragDepth.current = Math.max(0, dragDepth.current - 1);
                if (dragDepth.current === 0) setDragging(false);
              }}
              onDrop={onDrop}
            >
              <FileUp aria-hidden />
              <p className="import-page__drop-text">{file ? file.name : "Drag a CSV, TSV or Excel file here"}</p>
              <Button variant="secondary" onClick={() => inputRef.current?.click()}>
                Choose file
              </Button>
              <input
                ref={inputRef}
                className="import-page__file"
                type="file"
                accept=".csv,.tsv,.txt,.xlsx,.xlsm,.xls"
                aria-label="Broker file"
                onChange={(e) => pick(e.target.files?.[0])}
              />
            </div>
            <div className="import-page__fields">
              <Field label="Broker" hint="Detected from the file when left on auto.">
                {(c) => <Select id={c.id} options={brokers} value={broker} onValueChange={setBroker} />}
              </Field>
              <Field label="Account">
                {(c) => <Select id={c.id} options={accounts} value={account} onValueChange={setAccount} />}
              </Field>
            </div>
            {account === NEW_ACCOUNT && (
              <AccountEditor
                onDone={(saved) => setAccount(saved ? String(saved.id) : AUTO)}
              />
            )}
            {upload.isPending && <progress className="import-page__progress" max={1} value={progress} aria-label="Upload progress" />}
            {upload.isError && (
              <ErrorState title="Could not read that file" message={upload.error.message} onRetry={startUpload} />
            )}
            <div className="import-page__actions">
              <Button variant="primary" disabled={!file || account === NEW_ACCOUNT} loading={upload.isPending} onClick={startUpload}>
                Import
              </Button>
            </div>
          </div>
        </Card>
      )}

      {step === 2 && preview && (
        <Card title={`Preview: ${preview.filename}`} subtitle={`Broker: ${preview.broker}. Nothing is written until you confirm.`}>
          <div className="import-page__chips">
            <span className="import-page__chip">New {preview.counts.new}</span>
            <span className="import-page__chip">Duplicate {preview.counts.duplicates}</span>
            <span className="import-page__chip">Sweeps dropped {preview.counts.sweeps_dropped}</span>
            <span className={`import-page__chip${preview.counts.warnings > 0 ? " import-page__chip--warn" : ""}`}>
              Warnings {preview.counts.warnings}
            </span>
            {(preview.counts.skipped ?? 0) > 0 && <span className="import-page__chip">Skipped {preview.counts.skipped}</span>}
            <span className={`import-page__chip${preview.counts.errors > 0 ? " import-page__chip--error" : ""}`}>
              Errors {preview.counts.errors}
            </span>
            {preview.parser === "flexible" && <span className="import-page__chip">Read with the flexible importer</span>}
          </div>
          {preview.layout && (
            <ColumnMapping
              key={preview.import_id}
              preview={preview}
              layout={preview.layout}
              onReparsed={setPreview}
              onCancel={discardPreview}
            />
          )}
          {preview.errors.length > 0 && (
            <ul className="import-page__issues import-page__issues--error" aria-label="Errors">
              {preview.errors.map((i, n) => (
                <li key={n}>
                  {i.line != null && `Line ${i.line}: `}
                  {i.message}
                </li>
              ))}
            </ul>
          )}
          {flaggedShown > 0 && (
            <section
              className={`import-page__flagged${unresolved === 0 ? " import-page__flagged--done" : ""}`}
              aria-label="Rows that don't add up"
            >
              {unresolved > 0 ? (
                <AlertTriangle className="import-page__flagged-icon" aria-hidden />
              ) : (
                <CheckCircle2 className="import-page__flagged-icon" aria-hidden />
              )}
              <div className="import-page__flagged-body">
                <p className="import-page__flagged-title">
                  {unresolved > 0
                    ? `${unresolved} ${unresolved === 1 ? "row doesn't" : "rows don't"} add up`
                    : "All flagged rows are resolved"}
                </p>
                <p className="import-page__flagged-text">
                  {unresolved > 0
                    ? "They are marked in the table below. Keep each one, fix its price, or skip it. Rows you leave alone are imported as they are."
                    : "Your choices are applied when you import. Undo any of them in the table below."}
                  {preview.rows_truncated && " Only the first rows are shown here."}
                </p>
                <div className="import-page__flagged-actions">
                  {open.some((r) => r.fixes?.includes("fix_price")) && (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={resolve.isPending}
                      onClick={() =>
                        resolveRows(
                          open.filter((r) => r.fixes?.includes("fix_price")).map((r) => ({ index: r.index, action: "fix_price" })),
                        )
                      }
                    >
                      Fix all prices
                    </Button>
                  )}
                  {open.length > 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={resolve.isPending}
                      onClick={() => resolveRows(open.map((r) => ({ index: r.index, action: "keep" })))}
                    >
                      Keep all as they are
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" aria-pressed={onlyFlagged} onClick={() => setOnlyFlagged((v) => !v)}>
                    {onlyFlagged ? "Show all rows" : "Show only these rows"}
                  </Button>
                </div>
              </div>
            </section>
          )}
          {(fileWarnings.length > 0 || preview.unknown_actions.length > 0) && (
            <ul className="import-page__issues import-page__issues--warn" aria-label="Warnings">
              {fileWarnings.map((i, n) => (
                <li key={n}>{i.message}</li>
              ))}
              {preview.unknown_actions.length > 0 && <li>Unknown actions: {preview.unknown_actions.join(", ")}</li>}
            </ul>
          )}
          {preview.unknown_actions.length > 0 && <UnknownActions preview={preview} onReparsed={setPreview} />}
          {confirm.isError && <p className="import-page__error" role="alert">{confirm.error.message}</p>}
          <DataTable
            caption="Parsed rows"
            columns={columns}
            rows={tableRows}
            rowKey={(r) => String(r.index)}
            rowClassName={(r) =>
              r.skipped ? "import-page__row--skipped" : isOpen(r) ? "import-page__row--flagged" : isFlagged(r) && "import-page__row--resolved"
            }
            emptyMessage={
              preview.layout
                ? "No rows were parsed from this file. Check the column assignments above (use Adjust columns) and apply."
                : "No rows were parsed from this file."
            }
          />
          {preview.rows_truncated && <p className="import-page__note">Only the first rows are shown; all are imported on confirm.</p>}
          <div className="import-page__actions">
            {!preview.can_confirm && <span className="import-page__note">Answer the questions above first</span>}
            <Button variant="ghost" loading={discard.isPending} onClick={discardPreview}>
              Discard
            </Button>
            <Button
              variant="primary"
              loading={confirm.isPending}
              disabled={preview.counts.new === 0 || !preview.can_confirm}
              onClick={confirmImport}
            >
              {`Import ${plural(preview.counts.new, "transaction", "transactions")}`}
            </Button>
          </div>
        </Card>
      )}

      {step === 3 && result && (
        <Card title="Import complete">
          <p className="import-page__done">
            <CheckCircle2 aria-hidden /> Imported {plural(result.inserted, "transaction", "transactions")} ({result.duplicates} duplicates skipped).
          </p>
          {result.import_batch_id != null && (
            <p className="import-page__note">
              Saved as import #{result.import_batch_id}. It is highlighted in Import history below, where you can undo it.
            </p>
          )}
          <ul className="import-page__summary">
            {result.sweeps_dropped > 0 && <li>{result.sweeps_dropped} settlement sweeps dropped</li>}
            {result.unresolved_symbols.length > 0 && <li>
                Unresolved symbols: {result.unresolved_symbols.join(", ")}.{" "}
                <Link to="/instruments" className="import-page__link">
                  Map them in Instruments
                </Link>
              </li>}
            {result.unknown_actions.length > 0 && <li>Unknown actions: {result.unknown_actions.join(", ")}</li>}
            {result.fx_missing_dates.length > 0 && <li>
                FX missing on: {result.fx_missing_dates.join(", ")}.{" "}
                <Link to="/diagnostics?tab=repair" className="import-page__link">
                  Back-fill in Health &amp; Repair
                </Link>
              </li>}
            {result.errors.map((e, n) => (
              <li key={`e${n}`}>{e.message}</li>
            ))}
            {result.warnings.map((w, n) => (
              <li key={`w${n}`}>{w.message}</li>
            ))}
          </ul>
          <div className="import-page__actions">
            <Button variant="ghost" onClick={reset}>
              Import another file
            </Button>
            <Link to="/transactions" className="import-page__link">
              View transactions
            </Link>
          </div>
        </Card>
      )}

      <ImportHistory highlight={result?.import_batch_id ?? null} />
    </div>
  );
}
