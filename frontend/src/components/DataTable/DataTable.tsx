import clsx from "clsx";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { isValidElement, useMemo, useState, type ReactNode } from "react";
import { Skeleton } from "../Skeleton";
import "./DataTable.scss";

export interface Column<Row> {
  key: string;
  header: string;
  cell: (row: Row) => ReactNode;
  /** Provide to make the column sortable. */
  sortValue?: (row: Row) => string | number | null | undefined;
  /** Numbers and money: right-aligned, tabular. */
  align?: "left" | "right";
  /** On phones the primary column becomes the list-row title (no label), shown first. */
  primary?: boolean;
  /**
   * Phone layout (each row is a compact card):
   * - `"show"` (default): a small "Label value" chip under the title;
   * - `"headline"`: the row's key figure, right of the title, no label;
   * - `"sub"`: a muted line under the title (name, account, date), no label;
   * - `"inline"`: with the chips but without label or pill (badges, actions);
   * - `"hide"`: dropped on phones (low-priority columns, desktop-only detail).
   * Empty cells (blank, "–") are left out on phones.
   */
  phone?: "show" | "hide" | "headline" | "sub" | "inline";
  /** Keep the value on one line (default: true for right-aligned columns). */
  nowrap?: boolean;
  /**
   * Wide screens: a group heading over consecutive columns with the same
   * `group` ("Position", "Returns"), with a divider before each group.
   */
  group?: string;
  /** Wide screens: stronger type for the figures that matter most. */
  emphasis?: boolean;
}

interface GroupSpan {
  label: string;
  span: number;
}

/** Consecutive columns with the same `group` merged into one heading cell. */
export function groupSpans<Row>(columns: Column<Row>[]): GroupSpan[] {
  const out: GroupSpan[] = [];
  for (const c of columns) {
    const label = c.group ?? "";
    const last = out[out.length - 1];
    if (last && last.label === label) last.span += 1;
    else out.push({ label, span: 1 });
  }
  return out;
}

export interface DataTableProps<Row> {
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  caption: string;
  defaultSort?: { key: string; direction: "asc" | "desc" };
  loading?: boolean;
  emptyMessage?: string;
  className?: string;
  /** Extra class for a body row (e.g. a gain/loss tint). */
  rowClassName?: (row: Row) => string | false | undefined;
}

type Direction = "asc" | "desc";

/** Nothing worth a phone line: blank, or the "no value" dash. */
export function isEmptyCell(content: ReactNode): boolean {
  if (content === null || content === undefined || content === false) return true;
  if (typeof content === "string") return /^\s*[–—-]?\s*$/.test(content);
  // <Money amount={null}/>, <Percent ratio={null}/>, <DeltaBadge value={null}/> render the dash.
  if (isValidElement(content)) {
    const props = content.props as Record<string, unknown>;
    for (const key of ["amount", "ratio", "value"]) {
      if (key in props && (props[key] === null || props[key] === undefined)) return true;
    }
  }
  return false;
}

function compare(a: string | number | null | undefined, b: string | number | null | undefined): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  caption,
  defaultSort,
  loading = false,
  emptyMessage = "Nothing to show yet.",
  className,
  rowClassName,
}: DataTableProps<Row>) {
  const [sort, setSort] = useState<{ key: string; direction: Direction } | undefined>(defaultSort);

  const sorted = useMemo(() => {
    const col = sort && columns.find((c) => c.key === sort.key);
    if (!sort || !col?.sortValue) return rows;
    const get = col.sortValue;
    const factor = sort.direction === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => factor * compare(get(a), get(b)));
  }, [rows, columns, sort]);

  const toggle = (key: string) => {
    setSort((prev) =>
      prev?.key === key ? { key, direction: prev.direction === "asc" ? "desc" : "asc" } : { key, direction: "asc" },
    );
  };

  const grouped = columns.some((c) => c.group);
  /** First column of a group (after the first): gets a divider on its left. */
  const groupStart = (i: number) => grouped && i > 0 && (columns[i].group ?? "") !== (columns[i - 1].group ?? "");

  return (
    <div className={clsx("data-table", grouped && "data-table--grouped", className)} data-scrollable>
      <table className="data-table__table">
        <caption className="u-sr-only">{caption}</caption>
        <thead className="data-table__head">
          {grouped && (
            <tr className="data-table__groups">
              {groupSpans(columns).map((g, i) => (
                <th
                  key={`${g.label}-${i}`}
                  scope="colgroup"
                  colSpan={g.span}
                  className={clsx("data-table__group", i > 0 && "data-table__group--start")}
                >
                  {g.label}
                </th>
              ))}
            </tr>
          )}
          <tr>
            {columns.map((col, i) => {
              const active = sort?.key === col.key;
              const ariaSort = active ? (sort.direction === "asc" ? "ascending" : "descending") : undefined;
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={col.sortValue ? (ariaSort ?? "none") : undefined}
                  className={clsx(
                    "data-table__th",
                    col.align === "right" && "data-table__th--right",
                    col.phone === "hide" && "data-table__th--phone-hidden",
                    groupStart(i) && "data-table__th--group-start",
                  )}
                >
                  {col.sortValue ? (
                    <button type="button" className="data-table__sort" onClick={() => toggle(col.key)}>
                      {col.header}
                      {active ? (
                        sort.direction === "asc" ? (
                          <ArrowUp className="data-table__sort-icon" aria-hidden />
                        ) : (
                          <ArrowDown className="data-table__sort-icon" aria-hidden />
                        )
                      ) : (
                        <ChevronsUpDown className="data-table__sort-icon data-table__sort-icon--idle" aria-hidden />
                      )}
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading &&
            Array.from({ length: 4 }, (_, i) => (
              <tr key={`sk-${i}`} className="data-table__row">
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={clsx("data-table__td", col.phone === "hide" && "data-table__td--phone-hidden")}
                  >
                    <Skeleton height="1rem" width={col.align === "right" ? "60%" : "80%"} />
                  </td>
                ))}
              </tr>
            ))}
          {!loading &&
            sorted.map((row) => (
              <tr key={rowKey(row)} className={clsx("data-table__row", rowClassName?.(row))}>
                {columns.map((col, i) => {
                  const content = col.cell(row);
                  const role = col.primary ? "primary" : (col.phone ?? "show");
                  const chip = role === "show" && Boolean(col.header);
                  return (
                    <td
                      key={col.key}
                      className={clsx(
                        "data-table__td",
                        col.align === "right" && "data-table__td--right",
                        col.primary && "data-table__td--primary",
                        role === "headline" && "data-table__td--headline",
                        role === "sub" && "data-table__td--sub",
                        ((role === "show" && !col.header) || role === "inline") && "data-table__td--bare",
                        chip && "data-table__td--chip",
                        isEmptyCell(content) && "data-table__td--empty",
                        col.phone === "hide" && "data-table__td--phone-hidden",
                        groupStart(i) && "data-table__td--group-start",
                        col.emphasis && "data-table__td--emphasis",
                      )}
                    >
                      {chip && (
                        <span className="data-table__label" aria-hidden>
                          {col.header}
                        </span>
                      )}
                      <span
                        className={clsx(
                          "data-table__value",
                          (col.nowrap ?? col.align === "right") && "data-table__value--nowrap",
                        )}
                      >
                        {content}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
        </tbody>
      </table>
      {!loading && sorted.length === 0 && <p className="data-table__empty">{emptyMessage}</p>}
    </div>
  );
}
