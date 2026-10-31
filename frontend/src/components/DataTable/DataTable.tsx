import clsx from "clsx";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
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
  /** On phones the primary column becomes the list-row title (no label). */
  primary?: boolean;
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
}

type Direction = "asc" | "desc";

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

  return (
    <div className={clsx("data-table", className)}>
      <table className="data-table__table">
        <caption className="u-sr-only">{caption}</caption>
        <thead className="data-table__head">
          <tr>
            {columns.map((col) => {
              const active = sort?.key === col.key;
              const ariaSort = active ? (sort.direction === "asc" ? "ascending" : "descending") : undefined;
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={col.sortValue ? (ariaSort ?? "none") : undefined}
                  className={clsx("data-table__th", col.align === "right" && "data-table__th--right")}
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
                  <td key={col.key} className="data-table__td">
                    <Skeleton height="1rem" width={col.align === "right" ? "60%" : "80%"} />
                  </td>
                ))}
              </tr>
            ))}
          {!loading &&
            sorted.map((row) => (
              <tr key={rowKey(row)} className="data-table__row">
                {columns.map((col) => (
                  <td
                    key={col.key}
                    data-label={col.primary ? undefined : col.header}
                    className={clsx(
                      "data-table__td",
                      col.align === "right" && "data-table__td--right",
                      col.primary && "data-table__td--primary",
                    )}
                  >
                    {col.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
        </tbody>
      </table>
      {!loading && sorted.length === 0 && <p className="data-table__empty">{emptyMessage}</p>}
    </div>
  );
}
