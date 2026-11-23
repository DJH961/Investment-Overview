import { Ban, CheckCircle2, CopyCheck, EyeOff, FileUp, TriangleAlert } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Chip } from "../../components/Chip";
import { DataTable, type Column } from "../../components/DataTable";
import { Input } from "../../components/Input";
import { Money } from "../../components/Money";
import { Select, type SelectOption } from "../../components/Select";
import { useToast } from "../../components/Toast";
import { formatDate } from "../../lib/format";
import { parseDecimal, toApiDecimal } from "../../lib/parseDecimal";
import {
  useConfirmWise,
  useDiscardWise,
  useUploadWiseStatement,
  useWiseLayout,
  type WiseConfirmResult,
  type WisePreview,
  type WisePreviewRow,
} from "../../lib/queries/wiseImport";
import "./WiseStatement.scss";

type Row = WisePreviewRow;

const NOT_FOUND = "__none__";
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A row the owner can import: a conversion not already in the ledger. */
export const isImportable = (r: Row) => r.status === "conversion" && !r.is_duplicate;

/** Why a row is not importable, as an icon chip (never colour alone). */
function RowStatus({ row }: { row: Row }) {
  if (row.is_duplicate) {
    return (
      <Chip size="sm" outline icon={<CopyCheck aria-hidden />} title="Already imported before">
        Already imported
      </Chip>
    );
  }
  if (row.status === "unsupported") {
    return (
      <Chip size="sm" tone="warn" icon={<TriangleAlert aria-hidden />} title={row.reason ?? undefined}>
        Not supported
      </Chip>
    );
  }
  if (row.status === "ignored") {
    return (
      <Chip size="sm" outline icon={<EyeOff aria-hidden />} title={row.reason ?? undefined}>
        Ignored
      </Chip>
    );
  }
  return (
    <Chip size="sm" outline icon={<Ban aria-hidden />} title={row.reason ?? undefined}>
      Skipped
    </Chip>
  );
}

function Mapping({ preview, onApply, busy }: { preview: WisePreview; onApply: (c: Record<string, number | null>) => void; busy: boolean }) {
  const [cols, setCols] = useState<Record<string, number | null>>(() =>
    Object.fromEntries(preview.fields.map((f) => [f.id, f.column])),
  );
  const options: SelectOption[] = [
    { value: NOT_FOUND, label: "Not in this file" },
    ...preview.headers.map((h, i) => ({ value: String(i), label: h || `Column ${i + 1}` })),
  ];
  return (
    <section className="wise-import__mapping" aria-label="Column mapping">
      <p className="wise-import__text">
        {preview.missing.length > 0
          ? "This file does not look like the usual Wise statement layout. Tell us which column holds what."
          : "Adjust which column holds what."}
      </p>
      <div className="wise-import__mapping-grid">
        {preview.fields.map((f) => (
          <label key={f.id} className="wise-import__mapping-field">
            <span className="wise-import__mapping-label">
              {f.label}
              {f.required ? " *" : ""}
            </span>
            <Select
              ariaLabel={f.label}
              options={options}
              value={cols[f.id] === null || cols[f.id] === undefined ? NOT_FOUND : String(cols[f.id])}
              onValueChange={(v) => setCols((c) => ({ ...c, [f.id]: v === NOT_FOUND ? null : Number(v) }))}
            />
          </label>
        ))}
      </div>
      <Button size="sm" variant="secondary" loading={busy} onClick={() => onApply(cols)}>
        Apply columns
      </Button>
    </section>
  );
}

/** Wise statement import: conversions, with a tick and a "kept" field per row. */
export function WiseStatement() {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<WisePreview | null>(null);
  const [result, setResult] = useState<WiseConfirmResult | null>(null);
  const [skip, setSkip] = useState<Record<number, boolean>>({});
  const [kept, setKept] = useState<Record<number, string>>({});
  const [showMapping, setShowMapping] = useState(false);
  const upload = useUploadWiseStatement();
  const layout = useWiseLayout();
  const confirm = useConfirmWise();
  const discard = useDiscardWise();

  const reset = () => {
    setFile(null);
    setPreview(null);
    setResult(null);
    setSkip({});
    setKept({});
    setShowMapping(false);
    upload.reset();
    confirm.reset();
  };

  const rows = preview?.rows ?? [];
  const keptValue = (r: Row): number | null => {
    const raw = kept[r.line] ?? "";
    if (raw.trim() === "") return 0;
    const n = parseDecimal(raw);
    return n !== null && n >= 0 ? n : null;
  };
  const keptError = (r: Row): string | null => {
    const n = keptValue(r);
    if (n === null) return "Enter an amount, like 250 or 250,50.";
    if (n > Number(r.usd_received) + 1e-9) return "More than the dollars received.";
    return null;
  };
  const ticked = rows.filter((r) => isImportable(r) && !skip[r.line]);
  const invalid = ticked.some((r) => keptError(r) !== null);

  const start = () => {
    if (!file) return;
    upload.mutate(file, {
      onSuccess: (p) => {
        setPreview(p);
        setShowMapping(p.missing.length > 0);
      },
    });
  };

  const apply = (columns: Record<string, number | null>) => {
    if (!preview) return;
    layout.mutate(
      { importId: preview.import_id, columns },
      {
        onSuccess: (p) => {
          setPreview(p);
          setSkip({});
          setKept({});
          setShowMapping(p.missing.length > 0);
        },
        onError: (e) => toast({ title: "Could not apply those columns", description: e.message, tone: "error" }),
      },
    );
  };

  const doConfirm = () => {
    if (!preview) return;
    const choices = rows.filter(isImportable).map((r) => ({
      line: r.line,
      skip: Boolean(skip[r.line]),
      kept_usd: toApiDecimal(kept[r.line] ?? "") ?? "0",
    }));
    confirm.mutate(
      { importId: preview.import_id, rows: choices },
      {
        onSuccess: (r) => {
          setResult(r);
          setPreview(null);
          toast({ title: `Imported ${plural(r.imported, "conversion", "conversions")}`, tone: "success" });
        },
      },
    );
  };

  const discardPreview = () => {
    if (preview) discard.mutate(preview.import_id, { onSettled: reset });
    else reset();
  };

  const columns = useMemo<Column<Row>[]>(
    () => [
      {
        key: "import",
        header: "Import",
        phone: "inline",
        cell: (r) =>
          isImportable(r) ? (
            <input
              type="checkbox"
              className="wise-import__check"
              checked={!skip[r.line]}
              onChange={(e) => setSkip((s) => ({ ...s, [r.line]: !e.target.checked }))}
              aria-label={`Import the conversion of ${r.date ? formatDate(r.date) : `line ${r.line}`}`}
            />
          ) : (
            <RowStatus row={r} />
          ),
      },
      {
        key: "date",
        header: "Date",
        primary: true,
        nowrap: true,
        cell: (r) => (r.date ? formatDate(r.date) : "–"),
        sortValue: (r) => r.date,
      },
      {
        key: "what",
        header: "What",
        phone: "sub",
        cell: (r) =>
          isImportable(r) ? (r.sent_on ? "Sent on to the broker" : r.fee_stated ? "Fee on the statement" : "Fee worked out from the rate") : (r.reason ?? ""),
      },
      {
        key: "eur",
        header: "Sent",
        align: "right",
        cell: (r) => (r.eur_sent ? <Money amount={Number(r.eur_sent)} currency="EUR" /> : "–"),
      },
      {
        key: "fee",
        header: "Fee",
        align: "right",
        phone: "hide",
        cell: (r) => (r.fees_eur && Number(r.fees_eur) > 0 ? <Money amount={Number(r.fees_eur)} currency="EUR" /> : "–"),
      },
      {
        key: "usd",
        header: "Received",
        align: "right",
        phone: "headline",
        cell: (r) => (r.usd_received ? <Money amount={Number(r.usd_received)} currency="USD" /> : "–"),
      },
      {
        key: "kept",
        header: "Kept in your USD account",
        phone: "inline",
        cell: (r) => {
          if (!isImportable(r)) return "";
          const err = skip[r.line] ? null : keptError(r);
          return (
            <span className="wise-import__kept">
              <Input
                inputMode="decimal"
                value={kept[r.line] ?? ""}
                placeholder="0"
                disabled={Boolean(skip[r.line])}
                invalid={err !== null}
                aria-label={`Dollars kept in your USD account for line ${r.line}`}
                onChange={(e) => setKept((k) => ({ ...k, [r.line]: e.target.value }))}
              />
              {err && <span className="wise-import__error">{err}</span>}
            </span>
          );
        },
      },
      {
        key: "check",
        header: "Status",
        phone: "inline",
        cell: (r) =>
          isImportable(r) ? (
            (r.warnings ?? []).length > 0 ? (
              <Chip size="sm" tone="warn" icon={<TriangleAlert aria-hidden />} title={(r.warnings ?? []).join(" ")}>
                Check
              </Chip>
            ) : (
              <Chip size="sm" outline icon={<CheckCircle2 aria-hidden />}>
                New
              </Chip>
            )
          ) : (
            <RowStatus row={r} />
          ),
      },
    ],
    // keptError depends on skip / kept, both listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [skip, kept],
  );

  if (result) {
    return (
      <Card title="Wise statement imported">
        <p className="wise-import__done">
          <CheckCircle2 aria-hidden /> Imported {plural(result.imported, "conversion", "conversions")} ({result.skipped} left out,{" "}
          {result.duplicates} already imported).
        </p>
        <div className="wise-import__actions">
          <Button variant="ghost" onClick={reset}>
            Import another statement
          </Button>
          <Link to="/conversions" className="wise-import__link">
            View conversions
          </Link>
        </div>
      </Card>
    );
  }

  if (!preview) {
    return (
      <Card
        title="Wise statement (conversions)"
        subtitle="Upload a Wise account statement (CSV) to add your EUR to USD conversions, fees included. Deposits, card payments and plain transfers are left out; you can still untick any conversion."
      >
        <div className="wise-import__upload">
          <p className="wise-import__text">{file ? file.name : "No file chosen"}</p>
          <Button variant="secondary" leftIcon={<FileUp aria-hidden />} onClick={() => inputRef.current?.click()}>
            Choose statement
          </Button>
          <input
            ref={inputRef}
            className="wise-import__file"
            type="file"
            tabIndex={-1}
            accept=".csv,.tsv,.txt,.xlsx"
            aria-label="Wise statement file"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <Button variant="primary" disabled={!file} loading={upload.isPending} onClick={start}>
            Preview conversions
          </Button>
        </div>
        {upload.isError && (
          <p className="wise-import__error" role="alert">
            {upload.error.message}
          </p>
        )}
      </Card>
    );
  }

  const c = preview.counts;
  return (
    <Card title={`Preview: ${preview.filename}`} subtitle="Wise statement. Nothing is written until you confirm.">
      <div className="wise-import__chips">
        <span className="wise-import__chip">New {c.new}</span>
        <span className="wise-import__chip">Already imported {c.duplicates}</span>
        <span className="wise-import__chip">Left out {c.skipped}</span>
      </div>
      <p className="wise-import__text">
        Untick any conversion that was not an investment (for example one that paid a card purchase). Enter the dollars you kept in
        your USD account instead of sending them to the broker.
        {preview.ignore_non_usd ? " Conversions into other currencies are ignored (see Settings)." : ""}
      </p>
      {showMapping ? (
        <Mapping key={preview.import_id} preview={preview} onApply={apply} busy={layout.isPending} />
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setShowMapping(true)}>
          Adjust columns
        </Button>
      )}
      {confirm.isError && (
        <p className="wise-import__error" role="alert">
          {confirm.error.message}
        </p>
      )}
      <DataTable
        caption="Statement rows"
        columns={columns}
        rows={rows}
        rowKey={(r) => String(r.line)}
        rowClassName={(r) => (!isImportable(r) || skip[r.line] ? "wise-import__row--off" : undefined)}
        emptyMessage="No rows were read from this file. Check the column mapping above."
      />
      <div className="wise-import__actions">
        <Button variant="ghost" loading={discard.isPending} onClick={discardPreview}>
          Discard
        </Button>
        <Button
          variant="primary"
          loading={confirm.isPending}
          disabled={ticked.length === 0 || invalid || preview.missing.length > 0}
          onClick={doConfirm}
        >
          {`Import ${plural(ticked.length, "conversion", "conversions")}`}
        </Button>
      </div>
    </Card>
  );
}
