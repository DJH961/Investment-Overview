import { CheckCircle2, FileUp } from "lucide-react";
import { useMemo, useRef, useState, type DragEvent } from "react";
import { Link } from "react-router";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { DataTable, type Column } from "../../components/DataTable";
import { ErrorState } from "../../components/ErrorState";
import { Field } from "../../components/Field";
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
import { useShellStatus } from "../../lib/shell";
import { AccountEditor } from "../Settings/AccountsCard";
import "./Import.scss";

type PreviewRow = ImportPreview["rows"][number];

const AUTO = "auto";
const NEW_ACCOUNT = "__new__";
const dash = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? "—" : v);

const columns: Column<PreviewRow>[] = [
  { key: "index", header: "#", cell: (r) => r.index, sortValue: (r) => r.index },
  { key: "date", header: "Date", cell: (r) => r.date, sortValue: (r) => r.date },
  { key: "symbol", header: "Symbol", primary: true, cell: (r) => dash(r.symbol), sortValue: (r) => r.symbol },
  { key: "kind", header: "Kind", cell: (r) => r.kind },
  { key: "quantity", header: "Qty", align: "right", cell: (r) => dash(r.quantity) },
  { key: "price", header: "Price", align: "right", cell: (r) => dash(r.price_native) },
  { key: "net", header: "Net", align: "right", cell: (r) => `${dash(r.net_native)} ${r.currency}` },
  {
    key: "status",
    header: "Status",
    cell: (r) => (
      <span className={`import-page__status import-page__status--${r.is_duplicate ? "duplicate" : "new"}`}>
        {r.is_duplicate ? "Duplicate" : "New"}
      </span>
    ),
  },
];

export function Import() {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [broker, setBroker] = useState(AUTO);
  const [account, setAccount] = useState(AUTO);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportConfirmResult | null>(null);

  const upload = useUploadImport();
  const confirm = useConfirmImport();
  const discard = useDiscardImport();
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
        toast({ title: `Imported ${r.inserted} transactions`, tone: "success" });
      },
    });
  };

  const step = result ? 3 : preview ? 2 : 1;

  return (
    <div className="import-page">
      <PageHeader title="Import" subtitle="Upload a broker export, preview, then confirm." />
      <ol className="import-page__steps" aria-label="Progress">
        {["Upload", "Preview", "Done"].map((label, i) => (
          <li key={label} className={`import-page__step${step === i + 1 ? " import-page__step--active" : ""}`}>
            {i + 1}. {label}
          </li>
        ))}
      </ol>

      {step === 1 && (
        <Card title="Upload" subtitle="Drop your file first, then pick the broker and account - the import only runs when you press Import.">
          <div className="import-page__upload">
            <div
              className={`import-page__drop${dragging ? " import-page__drop--active" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <FileUp aria-hidden />
              <p className="import-page__drop-text">{file ? file.name : "Drag a CSV or XLSX file here"}</p>
              <Button variant="secondary" onClick={() => inputRef.current?.click()}>
                Choose file
              </Button>
              <input
                ref={inputRef}
                className="import-page__file"
                type="file"
                accept=".csv,.xlsx"
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
        <Card title={`Preview - ${preview.filename}`} subtitle={`Broker: ${preview.broker}. Nothing is written until you confirm.`}>
          <div className="import-page__chips">
            <span className="import-page__chip">New {preview.counts.new}</span>
            <span className="import-page__chip">Duplicate {preview.counts.duplicates}</span>
            <span className="import-page__chip">Sweeps dropped {preview.counts.sweeps_dropped}</span>
            <span className="import-page__chip import-page__chip--warn">Warnings {preview.counts.warnings}</span>
            <span className="import-page__chip import-page__chip--error">Errors {preview.counts.errors}</span>
          </div>
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
          {(preview.warnings.length > 0 || preview.unknown_actions.length > 0) && (
            <ul className="import-page__issues import-page__issues--warn" aria-label="Warnings">
              {preview.warnings.map((i, n) => (
                <li key={n}>
                  {i.line != null && `Line ${i.line}: `}
                  {i.message}
                </li>
              ))}
              {preview.unknown_actions.length > 0 && <li>Unknown actions: {preview.unknown_actions.join(", ")}</li>}
            </ul>
          )}
          {confirm.isError && <p className="import-page__error" role="alert">{confirm.error.message}</p>}
          <DataTable
            caption="Parsed rows"
            columns={columns}
            rows={preview.rows}
            rowKey={(r) => String(r.index)}
            emptyMessage="No rows were parsed from this file."
          />
          {preview.rows_truncated && <p className="import-page__note">Only the first rows are shown; all are imported on confirm.</p>}
          <div className="import-page__actions">
            <Button variant="ghost" loading={discard.isPending} onClick={discardPreview}>
              Discard
            </Button>
            <Button variant="primary" loading={confirm.isPending} disabled={preview.counts.new === 0} onClick={confirmImport}>
              {`Import ${preview.counts.new} transactions`}
            </Button>
          </div>
        </Card>
      )}

      {step === 3 && result && (
        <Card title="Import complete">
          <p className="import-page__done">
            <CheckCircle2 aria-hidden /> Imported {result.inserted} transactions ({result.duplicates} duplicates skipped).
          </p>
          <ul className="import-page__summary">
            {result.sweeps_dropped > 0 && <li>{result.sweeps_dropped} settlement sweeps dropped</li>}
            {result.unresolved_symbols.length > 0 && <li>Unresolved symbols: {result.unresolved_symbols.join(", ")}</li>}
            {result.unknown_actions.length > 0 && <li>Unknown actions: {result.unknown_actions.join(", ")}</li>}
            {result.fx_missing_dates.length > 0 && <li>FX missing on: {result.fx_missing_dates.join(", ")}</li>}
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
    </div>
  );
}
