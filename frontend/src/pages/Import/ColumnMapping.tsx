import { Wand2 } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/Button";
import { Select, type SelectOption } from "../../components/Select";
import { Switch } from "../../components/Switch";
import { useToast } from "../../components/Toast";
import type { ImportPreview } from "../../lib/queries/ledger";
import { useSetImportLayout, type ImportLayoutIn } from "../../lib/queries/imports";
import "./ColumnMapping.scss";

type Layout = NonNullable<ImportPreview["layout"]>;
type Column = Layout["columns"][number];
type Question = Layout["questions"][number];
type DateOrder = "MDY" | "DMY" | "YMD";
type Decimal = "." | ",";
type Derive = NonNullable<ImportLayoutIn["derive"]>[number];

const NOT_USED = "__none__";
const DATE_ORDERS: SelectOption[] = [
  { value: "MDY", label: "Month/Day/Year (01/05 = 5 Jan)" },
  { value: "DMY", label: "Day/Month/Year (01/05 = 1 May)" },
  { value: "YMD", label: "Year-Month-Day" },
];
const DECIMALS: SelectOption[] = [
  { value: ".", label: "1,234.56" },
  { value: ",", label: "1.234,56" },
];
const LOW_CONFIDENCE = 0.6;

const columnLabel = (c: Column) => {
  const samples = c.samples.slice(0, 2).join(", ");
  const head = c.header || `Column ${c.index + 1}`;
  return samples ? `${head} — ${samples}` : head;
};

const badge = (c: Column): { text: string; low: boolean } | null => {
  if (!c.field) return null;
  if (c.by === "user") return { text: "Your choice", low: false };
  if (c.by === "saved") return { text: "Saved layout", low: false };
  const low = c.confidence < LOW_CONFIDENCE;
  if (c.by === "content") return { text: "Guessed from content", low };
  return { text: "Matched by header name", low };
};

interface Props {
  preview: ImportPreview;
  layout: Layout;
  onReparsed: (p: ImportPreview) => void;
  onCancel: () => void;
}

/**
 * The flexible importer's column editor: open questions first (pick a column, work
 * it out from the others, or cancel), then the full column table. Every change
 * re-reads the staged file and passes the new preview up.
 */
export function ColumnMapping({ preview, layout, onReparsed, onCancel }: Props) {
  const { toast } = useToast();
  const setLayout = useSetImportLayout();
  const hasQuestions = layout.questions.length > 0;
  const dateAsked = layout.questions.some((q) => q.field === "date_order");
  const flexible = preview.parser === "flexible";
  const [expanded, setExpanded] = useState(false);
  const [fieldOf, setFieldOf] = useState<Record<number, string | null>>(() =>
    Object.fromEntries(layout.columns.map((c) => [c.index, c.field ?? null])),
  );
  const [decimal, setDecimal] = useState<Decimal>(layout.decimal);
  const [dateOrder, setDateOrder] = useState<DateOrder>(layout.date_order);
  const [sheet, setSheet] = useState(layout.sheet);
  const [remember, setRemember] = useState(false);

  const send = (body: Partial<ImportLayoutIn>) =>
    setLayout.mutate(
      {
        importId: preview.import_id,
        body: { header_row: layout.header_row, sheet: layout.sheet, remember: false, derive: [], ...body },
      },
      {
        onSuccess: (p) => {
          toast({ title: "Preview updated", tone: "success" });
          onReparsed(p);
        },
        onError: (e) => toast({ title: "Could not apply that", description: e.message, tone: "error" }),
      },
    );

  // Columns the user already chose, kept when answering a question.
  const userColumns = (): Record<string, number | null> => {
    const out: Record<string, number | null> = {};
    for (const c of layout.columns) if (c.by === "user" && c.field) out[c.field] = c.index;
    return out;
  };

  const answer = (q: Question, choice: { column?: number; derive?: boolean; dateOrder?: DateOrder }) => {
    const columns = userColumns();
    const derive = [...layout.derive] as Derive[];
    if (choice.column !== undefined) columns[q.field] = choice.column;
    if (choice.derive && !derive.includes(q.field as Derive)) derive.push(q.field as Derive);
    // Never pin the guessed date order while the user is still being asked about it.
    send({ columns, derive, date_order: choice.dateOrder ?? (dateAsked ? null : layout.date_order), decimal: layout.decimal });
  };

  const apply = () => {
    const columns: Record<string, number | null> = {};
    for (const [idx, field] of Object.entries(fieldOf)) if (field) columns[field] = Number(idx);
    // A field the reader had matched but the user set to "Not used" is sent as
    // null, or the server would simply detect it again.
    for (const c of layout.columns) if (c.field && !(c.field in columns)) columns[c.field] = null;
    send({
      columns,
      derive: layout.derive as Derive[],
      date_order: dateAsked && dateOrder === layout.date_order ? null : dateOrder,
      decimal,
      sheet,
      remember: remember && layout.signature !== "",
    });
  };

  const assign = (index: number, value: string) =>
    setFieldOf((prev) => {
      const next = { ...prev };
      if (value !== NOT_USED) for (const k of Object.keys(next)) if (next[Number(k)] === value) next[Number(k)] = null;
      next[index] = value === NOT_USED ? null : value;
      return next;
    });

  const columnOptions: SelectOption[] = layout.columns.map((c) => ({ value: String(c.index), label: columnLabel(c) }));
  const fieldOptions: SelectOption[] = [
    { value: NOT_USED, label: "Not used" },
    ...layout.fields.map((f) => ({ value: f.id, label: f.required ? `${f.label} *` : f.label })),
  ];
  const fieldLabel = (id: string) => layout.fields.find((f) => f.id === id)?.label ?? id;
  const showTable = flexible || hasQuestions || expanded;

  return (
    <section className="column-mapping" aria-label="Column mapping">
      {hasQuestions && (
        <ul className="column-mapping__questions" aria-label="Questions">
          {layout.questions.map((q) => (
            <li key={q.field} className="column-mapping__question">
              <p className="column-mapping__message">{q.message}</p>
              {q.field === "date_order" ? (
                <div className="column-mapping__choices">
                  {DATE_ORDERS.map((o) => (
                    <Button
                      key={o.value}
                      variant="secondary"
                      disabled={setLayout.isPending}
                      onClick={() => answer(q, { dateOrder: o.value as DateOrder })}
                    >
                      {o.label}
                    </Button>
                  ))}
                  <Button variant="ghost" onClick={onCancel}>
                    Cancel import
                  </Button>
                </div>
              ) : (
                <div className="column-mapping__choices">
                  <div className="column-mapping__choice">
                    <span className="column-mapping__choice-label">Pick a column</span>
                    <Select
                      ariaLabel={`Pick a column for ${fieldLabel(q.field)}`}
                      options={columnOptions}
                      value=""
                      placeholder="Choose a column…"
                      disabled={setLayout.isPending}
                      onValueChange={(v) => answer(q, { column: Number(v) })}
                    />
                  </div>
                  {q.can_derive && (
                    <div className="column-mapping__choice">
                      <Button
                        variant="secondary"
                        leftIcon={<Wand2 aria-hidden />}
                        disabled={setLayout.isPending}
                        onClick={() => answer(q, { derive: true })}
                      >
                        Work it out from the other columns
                      </Button>
                      {q.derive_hint && <span className="column-mapping__hint">{q.derive_hint}</span>}
                    </div>
                  )}
                  <Button variant="ghost" onClick={onCancel}>
                    Cancel import
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {!showTable && (
        <div className="column-mapping__toggle">
          <Button variant="secondary" onClick={() => setExpanded(true)}>
            Adjust columns
          </Button>
        </div>
      )}

      {showTable && (
        <div className="column-mapping__editor">
          <h3 className="column-mapping__title">Columns</h3>
          {layout.notes.length > 0 && (
            <ul className="column-mapping__notes" aria-label="Notes">
              {layout.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
          {layout.sheets.length > 1 && (
            <div className="column-mapping__setting">
              <span className="column-mapping__setting-label">Sheet</span>
              <Select
                ariaLabel="Sheet"
                options={layout.sheets.map((s, i) => ({ value: String(i), label: s }))}
                value={String(sheet)}
                onValueChange={(v) => setSheet(Number(v))}
              />
            </div>
          )}
          <ul className="column-mapping__list">
            {layout.columns.map((c) => {
              const b = badge(c);
              const name = c.header || `Column ${c.index + 1}`;
              return (
                <li key={c.index} className="column-mapping__row">
                  <div className="column-mapping__source">
                    <span className="column-mapping__header">{name}</span>
                    <span className="column-mapping__samples">{c.samples.slice(0, 3).join(", ")}</span>
                  </div>
                  <Select
                    ariaLabel={`Field for ${name}`}
                    options={fieldOptions}
                    value={fieldOf[c.index] ?? NOT_USED}
                    onValueChange={(v) => assign(c.index, v)}
                  />
                  {b && (
                    <span className={`column-mapping__badge${b.low ? " column-mapping__badge--low" : ""}`}>{b.text}</span>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="column-mapping__settings">
            <div className="column-mapping__setting">
              <span className="column-mapping__setting-label">Number format</span>
              <Select ariaLabel="Number format" options={DECIMALS} value={decimal} onValueChange={(v) => setDecimal(v as Decimal)} />
            </div>
            <div className="column-mapping__setting">
              <span className="column-mapping__setting-label">Date order</span>
              <Select ariaLabel="Date order" options={DATE_ORDERS} value={dateOrder} onValueChange={(v) => setDateOrder(v as DateOrder)} />
            </div>
          </div>
          {layout.signature !== "" && (
            <Switch label="Remember this layout for files with the same columns" checked={remember} onCheckedChange={setRemember} />
          )}
          <div className="column-mapping__actions">
            <Button variant="primary" loading={setLayout.isPending} onClick={apply}>
              Apply
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
