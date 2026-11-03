import { ArrowDownUp, Pencil, Plus, Search, SlidersHorizontal, Tag, Upload } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { DataTable, type Column } from "../../components/DataTable";
import { Dialog } from "../../components/Dialog";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { IconButton } from "../../components/IconButton";
import { Input } from "../../components/Input";
import { Money } from "../../components/Money";
import { PageHeader } from "../../components/PageHeader";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Select, type SelectOption } from "../../components/Select";
import { Sheet } from "../../components/Sheet";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { formatDate, getFormatPrefs, todayIn } from "../../lib/format";
import { usePrefs } from "../../lib/prefs";
import { useAccounts } from "../../lib/queries/accounts";
import {
  useCreateTransaction,
  useDeleteTransaction,
  useTransactions,
  useUpdateTransaction,
  type TransactionFilters,
  type TransactionMonth,
  type TransactionOut,
  type TransactionWrite,
} from "../../lib/queries/ledger";
import { useShellStatus } from "../../lib/shell";
import { useIsPhone } from "../../lib/useMediaQuery";
import { usePersistentState } from "../../lib/usePersistentState";
import { formatPrice, formatQuantity, num } from "./numbers";
import { KIND_OPTIONS, TransactionForm } from "./TransactionForm";
import "./Transactions.scss";

const PAGE_SIZE = 50;
const ALL = "all";
const KIND_LABEL: Record<string, string> = Object.fromEntries(KIND_OPTIONS.map((o) => [o.value, o.label]));

type SortKey = NonNullable<TransactionFilters["sort"]>;
type Order = NonNullable<TransactionFilters["order"]>;
type RangeKey = "all" | "30d" | "90d" | "12m" | "ytd" | "custom";

const SORT_OPTIONS: SelectOption[] = [
  { value: "date", label: "Sort: date" },
  { value: "symbol", label: "Sort: symbol" },
  { value: "kind", label: "Sort: kind" },
  { value: "account", label: "Sort: account" },
  { value: "quantity", label: "Sort: quantity" },
  { value: "net", label: "Sort: net (native)" },
];
const RANGE_OPTIONS: { value: Exclude<RangeKey, "custom">; label: string }[] = [
  { value: "all", label: "All" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "12m", label: "12m" },
  { value: "ytd", label: "This year" },
];

interface FilterState {
  account: string;
  kind: string;
  symbol: string;
  start: string;
  end: string;
  q: string;
  sweeps: boolean;
  sort: SortKey;
  order: Order;
  range: RangeKey;
}

const DEFAULT_FILTERS: FilterState = {
  account: ALL,
  kind: ALL,
  symbol: "",
  start: "",
  end: "",
  q: "",
  sweeps: false,
  sort: "date",
  order: "desc",
  range: "all",
};

const isFilterState = (v: unknown): v is FilterState =>
  typeof v === "object" &&
  v !== null &&
  Object.keys(DEFAULT_FILTERS).every((k) => typeof (v as Record<string, unknown>)[k] === typeof DEFAULT_FILTERS[k as keyof FilterState]);

function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** From/To for a quick range (calendar dates in the user's zone; display-only). */
export function rangeDates(range: RangeKey, today: string): { start: string; end: string } {
  switch (range) {
    case "30d":
      return { start: shiftDays(today, -30), end: "" };
    case "90d":
      return { start: shiftDays(today, -90), end: "" };
    case "12m":
      return { start: shiftDays(today, -365), end: "" };
    case "ytd":
      return { start: `${today.slice(0, 4)}-01-01`, end: "" };
    default:
      return { start: "", end: "" };
  }
}

function monthLabel(month: string): string {
  return new Intl.DateTimeFormat(getFormatPrefs().locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${month}-01T00:00:00Z`),
  );
}

/** Net in the reporting currency (trade-date FX, from the server) with the other legs beneath. */
function NetCell({ row, currency }: { row: TransactionOut; currency: "EUR" | "USD" }) {
  const other = currency === "EUR" ? "USD" : "EUR";
  const main = num(currency === "EUR" ? row.cash_eur : row.cash_usd);
  const second = num(other === "EUR" ? row.cash_eur : row.cash_usd);
  const native = row.currency !== "EUR" && row.currency !== "USD";
  return (
    <span className="transactions-page__net">
      {main === null ? (
        <span title="No exchange rate on file for this date">–</span>
      ) : (
        <Money amount={main} currency={currency} signed colored />
      )}
      {second !== null && <Money amount={second} currency={other} signed className="transactions-page__net-sub" />}
      {native && <Money amount={num(row.net_native)} currency={row.currency} signed className="transactions-page__net-sub" />}
    </span>
  );
}

export function Transactions() {
  const isPhone = useIsPhone();
  const { toast } = useToast();
  const { currency } = usePrefs();
  const [f, setF] = usePersistentState<FilterState>("transactions.filters", DEFAULT_FILTERS, isFilterState);
  const [page, setPage] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [editing, setEditing] = useState<TransactionOut | "new" | null>(null);
  const [deleting, setDeleting] = useState<TransactionOut | null>(null);

  const patch = (next: Partial<FilterState>) => {
    setF((prev) => ({ ...prev, ...next }));
    setPage(0);
  };
  const pickRange = (range: RangeKey) => patch({ range, ...rangeDates(range, todayIn(getFormatPrefs().timeZone)) });

  const list = useTransactions({
    account_id: f.account === ALL ? undefined : Number(f.account),
    kind: f.kind === ALL ? undefined : f.kind,
    symbol: f.symbol.trim().toUpperCase() || undefined,
    start: f.start || undefined,
    end: f.end || undefined,
    q: f.q.trim() || undefined,
    hide_sweeps: !f.sweeps,
    sort: f.sort,
    order: f.order,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });
  const accountList = useAccounts();
  const accounts = useMemo<SelectOption[]>(
    () => (accountList.data ?? []).map((a) => ({ value: String(a.id), label: a.account_label })),
    [accountList.data],
  );

  const create = useCreateTransaction();
  const update = useUpdateTransaction();
  const remove = useDeleteTransaction();

  const { refetch } = list;
  const onRefresh = useCallback(() => void refetch(), [refetch]);
  useShellStatus(
    list.isError ? "stale" : list.isFetching ? "loading" : "closed",
    list.isError ? "Offline" : list.isFetching ? "Loading" : "Ledger",
    onRefresh,
    list.isFetching,
  );

  const closeForm = () => {
    setEditing(null);
    create.reset();
    update.reset();
  };

  const save = (body: TransactionWrite) => {
    const done = (title: string, warnings?: string[]) => {
      toast({ title, description: warnings?.join(" "), tone: "success" });
      closeForm();
    };
    if (editing === "new") {
      create.mutate(body, { onSuccess: (r) => done("Saved", r.warnings) });
    } else if (editing) {
      update.mutate({ id: editing.id, body }, { onSuccess: (r) => done("Updated", r.warnings) });
    }
  };

  const confirmDelete = () => {
    if (!deleting) return;
    remove.mutate(deleting.id, {
      onSuccess: () => {
        toast({ title: "Deleted", tone: "success" });
        setDeleting(null);
        closeForm();
      },
      onError: (e) => toast({ title: "Delete failed", description: e.message, tone: "error" }),
    });
  };

  const columns: Column<TransactionOut>[] = [
    { key: "date", header: "Date", phone: "sub", cell: (r) => formatDate(r.date), nowrap: true },
    { key: "symbol", header: "Symbol", primary: true, cell: (r) => r.symbol || "—" },
    {
      key: "kind",
      header: "Kind",
      phone: "inline",
      cell: (r) => (
        <span className={`transactions-page__kind transactions-page__kind--${r.kind}`}>{KIND_LABEL[r.kind] ?? r.kind}</span>
      ),
    },
    { key: "account", header: "Account", cell: (r) => r.account, phone: "hide" },
    { key: "quantity", header: "Qty", align: "right", cell: (r) => formatQuantity(r.quantity) },
    {
      key: "price",
      header: "Price",
      align: "right",
      cell: (r) => <span className="money">{formatPrice(r.price_native, r.currency)}</span>,
    },
    {
      key: "fees",
      header: "Fees",
      align: "right",
      phone: "hide",
      cell: (r) => (num(r.fees_native) ? <Money amount={num(r.fees_native)} currency={r.currency} /> : "–"),
    },
    { key: "net", header: `Net (${currency})`, align: "right", phone: "headline", cell: (r) => <NetCell row={r} currency={currency} /> },
    { key: "source", header: "Source", phone: "hide", cell: (r) => r.source ?? "—" },
    {
      key: "edit",
      header: "",
      cell: (r) => (
        <span className="transactions-page__row-actions">
          {r.instrument_id != null && (
            <Link
              to={`/instruments?id=${r.instrument_id}`}
              className="transactions-page__icon-link"
              aria-label={`Edit instrument ${r.symbol}`}
              title="Edit instrument"
            >
              <Tag aria-hidden />
            </Link>
          )}
          <IconButton label={`Edit transaction ${r.id}`} size="sm" icon={<Pencil aria-hidden />} onClick={() => setEditing(r)} />
        </span>
      ),
    },
  ];

  const summary = list.data?.summary;
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const activeFilters = [f.account !== ALL, f.kind !== ALL, Boolean(f.symbol), Boolean(f.start || f.end), f.sweeps].filter(
    Boolean,
  ).length;
  const filtered = activeFilters > 0 || Boolean(f.q);
  const avgTrade = summary ? num(currency === "EUR" ? summary.avg_trade_size_eur : summary.avg_trade_size_usd) : null;

  const form = editing && (
    <TransactionForm
      key={editing === "new" ? "new" : editing.id}
      row={editing === "new" ? null : editing}
      accounts={accounts}
      busy={create.isPending || update.isPending}
      serverError={editing === "new" ? create.error : update.error}
      onSubmit={save}
      onCancel={closeForm}
      onDelete={editing === "new" ? undefined : () => setDeleting(editing)}
    />
  );
  const formTitle = editing === "new" ? "Add transaction" : "Edit transaction";

  const search = (
    <Input
      data-search
      aria-label="Search transactions"
      placeholder="Search…"
      leftIcon={<Search aria-hidden />}
      value={f.q}
      onChange={(e) => patch({ q: e.target.value })}
    />
  );
  const sortControls = (
    <>
      <Select ariaLabel="Sort by" value={f.sort} onValueChange={(v) => patch({ sort: v as SortKey })} options={SORT_OPTIONS} />
      <Button
        size="sm"
        variant="ghost"
        leftIcon={<ArrowDownUp aria-hidden />}
        onClick={() => patch({ order: f.order === "desc" ? "asc" : "desc" })}
        aria-label={f.order === "desc" ? "Order: newest / largest first" : "Order: oldest / smallest first"}
      >
        {f.sort === "date" ? (f.order === "desc" ? "Newest first" : "Oldest first") : f.order === "desc" ? "Descending" : "Ascending"}
      </Button>
    </>
  );
  const filterControls = (
    <>
      <Select
        ariaLabel="Account"
        value={f.account}
        onValueChange={(v) => patch({ account: v })}
        options={[{ value: ALL, label: "All accounts" }, ...accounts]}
      />
      <Select ariaLabel="Kind" value={f.kind} onValueChange={(v) => patch({ kind: v })} options={[{ value: ALL, label: "All kinds" }, ...KIND_OPTIONS]} />
      <Input aria-label="Instrument" placeholder="Symbol" value={f.symbol} onChange={(e) => patch({ symbol: e.target.value })} />
      <Input aria-label="From date" type="date" value={f.start} onChange={(e) => patch({ start: e.target.value, range: "custom" })} />
      <Input aria-label="To date" type="date" value={f.end} onChange={(e) => patch({ end: e.target.value, range: "custom" })} />
      <label
        className="transactions-page__check"
        title="Auto-generated money-market legs are hidden by default; they still count toward balance."
      >
        <input type="checkbox" checked={f.sweeps} onChange={(e) => patch({ sweeps: e.target.checked })} />
        <span>Show settlement sweeps</span>
      </label>
      {isPhone && sortControls}
    </>
  );
  const ranges = (
    <SegmentedControl
      ariaLabel="Time range"
      size="sm"
      options={RANGE_OPTIONS}
      value={f.range === "custom" ? ("" as Exclude<RangeKey, "custom">) : f.range}
      onChange={pickRange}
    />
  );

  const table = (rows: TransactionOut[], caption: string) => (
    <DataTable caption={caption} columns={columns} rows={rows} rowKey={(r) => String(r.id)} />
  );

  let body: ReactNode;
  if (list.isError && !list.data) {
    body = <ErrorState title="Could not load transactions" message={list.error.message} onRetry={() => void list.refetch()} />;
  } else if (list.isPending) {
    body = <Skeleton height="16rem" />;
  } else if (list.data.rows.length === 0) {
    body = (
      <EmptyState
        title={filtered ? "No transactions match your filters" : "No transactions yet"}
        description={filtered ? "Try clearing a filter." : "Import a broker file or add one manually."}
        action={
          filtered ? undefined : (
            <Button variant="primary" onClick={() => setEditing("new")}>
              Add transaction
            </Button>
          )
        }
      />
    );
  } else if (f.sort === "date") {
    const months = new Map<string, TransactionMonth>((list.data.months ?? []).map((m) => [m.month, m]));
    const groups = new Map<string, TransactionOut[]>();
    for (const r of list.data.rows) {
      const m = r.date.slice(0, 7);
      groups.set(m, [...(groups.get(m) ?? []), r]);
    }
    body = [...groups.entries()].map(([month, rows]) => {
      const t = months.get(month);
      const net = t ? num(currency === "EUR" ? t.net_eur : t.net_usd) : null;
      return (
        <Card
          key={month}
          title={monthLabel(month)}
          collapsibleId={`transactions.month.${month}`}
          flush
          subtitle={
            t && (
              <span className="transactions-page__month-sub">
                {t.count} {t.count === 1 ? "transaction" : "transactions"} · net <Money amount={net} currency={currency} signed colored />
                {t.fx_incomplete && " (some rows without a rate)"}
              </span>
            )
          }
        >
          {table(rows, `Transactions ${monthLabel(month)}`)}
        </Card>
      );
    });
  } else {
    body = <Card flush>{table(list.data.rows, "Transactions")}</Card>;
  }

  return (
    <div className="transactions-page">
      <PageHeader
        title="Transactions"
        subtitle="Every buy, sell and cash movement."
        actions={
          <>
            <Link to="/import" className="transactions-page__link">
              <Upload aria-hidden /> Import
            </Link>
            <Button variant="primary" leftIcon={<Plus aria-hidden />} onClick={() => setEditing("new")}>
              Add transaction
            </Button>
          </>
        }
      />

      {isPhone ? (
        <search className="transactions-page__filters transactions-page__filters--phone">
          {search}
          <Button variant="ghost" leftIcon={<SlidersHorizontal aria-hidden />} onClick={() => setFiltersOpen(true)}>
            {activeFilters > 0 ? `Filters (${activeFilters})` : "Filters"}
          </Button>
        </search>
      ) : (
        <search className="transactions-page__filters">
          {search}
          {filterControls}
        </search>
      )}
      <div className="transactions-page__toolbar">
        {ranges}
        {!isPhone && <div className="transactions-page__sort">{sortControls}</div>}
      </div>
      {isPhone && (
        <Sheet open={filtersOpen} onOpenChange={setFiltersOpen} title="Filters">
          <div className="transactions-page__sheet">
            {filterControls}
            <Button variant="ghost" onClick={() => patch({ ...DEFAULT_FILTERS, q: f.q })}>
              Clear filters
            </Button>
          </div>
        </Sheet>
      )}

      {summary && (
        <p className="transactions-page__summary">
          {filtered ? `${summary.count} matching` : `${summary.count} transactions`} · {summary.buy_count} buys · {summary.sell_count}{" "}
          sells
          {avgTrade ? (
            <>
              {" "}
              · avg trade <Money amount={avgTrade} currency={currency} />
            </>
          ) : null}
        </p>
      )}

      {body}

      {list.data && list.data.rows.length > 0 && pages > 1 && (
        <nav className="transactions-page__pager" aria-label="Pagination">
          <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span>
            Page {page + 1} of {pages}
          </span>
          <Button size="sm" variant="ghost" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </nav>
      )}

      {editing &&
        (isPhone ? (
          <Sheet open onOpenChange={(o) => !o && closeForm()} title={formTitle}>
            {form}
          </Sheet>
        ) : (
          <Dialog open onOpenChange={(o) => !o && closeForm()} title={formTitle}>
            {form}
          </Dialog>
        ))}

      <Dialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete transaction?"
        description="This removes the row from the ledger and cannot be undone."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={confirmDelete}>
              Confirm delete
            </Button>
          </>
        }
      />
    </div>
  );
}
