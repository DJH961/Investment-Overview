import { Pencil, Plus, Search, Upload } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Link } from "react-router";
import { Button } from "../../components/Button";
import { DataTable, type Column } from "../../components/DataTable";
import { Dialog } from "../../components/Dialog";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { IconButton } from "../../components/IconButton";
import { Input } from "../../components/Input";
import { PageHeader } from "../../components/PageHeader";
import { Select, type SelectOption } from "../../components/Select";
import { Sheet } from "../../components/Sheet";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { formatDate } from "../../lib/format";
import {
  useCreateTransaction,
  useDeleteTransaction,
  useTransactions,
  useUpdateTransaction,
  type TransactionOut,
  type TransactionWrite,
} from "../../lib/queries/ledger";
import { useShellStatus } from "../../lib/shell";
import { useIsPhone } from "../../lib/useMediaQuery";
import { KIND_OPTIONS, TransactionForm } from "./TransactionForm";
import "./Transactions.scss";

const PAGE_SIZE = 50;
const ALL = "all";
const KIND_LABEL: Record<string, string> = Object.fromEntries(KIND_OPTIONS.map((o) => [o.value, o.label]));

const dash = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? "—" : v);

export function Transactions() {
  const isPhone = useIsPhone();
  const { toast } = useToast();
  const [account, setAccount] = useState(ALL);
  const [kind, setKind] = useState(ALL);
  const [symbol, setSymbol] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [q, setQ] = useState("");
  const [sweeps, setSweeps] = useState(false);
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<TransactionOut | "new" | null>(null);
  const [deleting, setDeleting] = useState<TransactionOut | null>(null);

  const resetPage =
    <T,>(setter: (v: T) => void) =>
    (v: T) => {
      setter(v);
      setPage(0);
    };

  const list = useTransactions({
    account_id: account === ALL ? undefined : Number(account),
    kind: kind === ALL ? undefined : kind,
    symbol: symbol.trim().toUpperCase() || undefined,
    start: start || undefined,
    end: end || undefined,
    q: q.trim() || undefined,
    hide_sweeps: !sweeps,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });
  // The API has no accounts endpoint yet, so account options come from the ledger itself.
  const probe = useTransactions({ limit: 200, offset: 0, hide_sweeps: false });

  const accounts = useMemo<SelectOption[]>(() => {
    const seen = new Map<number, string>();
    for (const r of probe.data?.rows ?? []) {
      if (r.account_id != null) seen.set(r.account_id, r.account);
    }
    return [...seen].map(([id, name]) => ({ value: String(id), label: name }));
  }, [probe.data]);

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
    { key: "date", header: "Date", cell: (r) => formatDate(r.date, "short"), sortValue: (r) => r.date },
    { key: "symbol", header: "Symbol", primary: true, cell: (r) => r.symbol || "—", sortValue: (r) => r.symbol },
    {
      key: "kind",
      header: "Kind",
      cell: (r) => (
        <span className={`transactions-page__kind transactions-page__kind--${r.kind}`}>{KIND_LABEL[r.kind] ?? r.kind}</span>
      ),
    },
    { key: "account", header: "Account", cell: (r) => r.account, sortValue: (r) => r.account },
    { key: "quantity", header: "Qty", align: "right", cell: (r) => dash(r.quantity) },
    { key: "price", header: "Price", align: "right", cell: (r) => dash(r.price_native) },
    { key: "fees", header: "Fees", align: "right", cell: (r) => dash(r.fees_native) },
    { key: "net", header: "Net", align: "right", cell: (r) => `${dash(r.net_native)} ${r.currency}` },
    { key: "source", header: "Source", cell: (r) => dash(r.source) },
    {
      key: "edit",
      header: "",
      cell: (r) => (
        <IconButton label={`Edit transaction ${r.id}`} size="sm" icon={<Pencil aria-hidden />} onClick={() => setEditing(r)} />
      ),
    },
  ];

  const summary = list.data?.summary;
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered = account !== ALL || kind !== ALL || symbol || start || end || q;

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

      <search className="transactions-page__filters">
        <Input
          data-search
          aria-label="Search transactions"
          placeholder="Search…"
          leftIcon={<Search aria-hidden />}
          value={q}
          onChange={(e) => resetPage(setQ)(e.target.value)}
        />
        <Select
          ariaLabel="Account"
          value={account}
          onValueChange={resetPage(setAccount)}
          options={[{ value: ALL, label: "All accounts" }, ...accounts]}
        />
        <Select ariaLabel="Kind" value={kind} onValueChange={resetPage(setKind)} options={[{ value: ALL, label: "All kinds" }, ...KIND_OPTIONS]} />
        <Input aria-label="Instrument" placeholder="Symbol" value={symbol} onChange={(e) => resetPage(setSymbol)(e.target.value)} />
        <Input aria-label="From date" type="date" value={start} onChange={(e) => resetPage(setStart)(e.target.value)} />
        <Input aria-label="To date" type="date" value={end} onChange={(e) => resetPage(setEnd)(e.target.value)} />
        <label
          className="transactions-page__check"
          title="Auto-generated money-market legs are hidden by default; they still count toward balance."
        >
          <input type="checkbox" checked={sweeps} onChange={(e) => resetPage(setSweeps)(e.target.checked)} />
          <span>Show settlement sweeps</span>
        </label>
      </search>

      {summary && (
        <p className="transactions-page__summary">
          {summary.count} transactions · {summary.buy_count} buys · {summary.sell_count} sells
        </p>
      )}

      {list.isError && !list.data ? (
        <ErrorState title="Could not load transactions" message={list.error.message} onRetry={() => void list.refetch()} />
      ) : list.isPending ? (
        <Skeleton height="16rem" />
      ) : list.data.rows.length === 0 ? (
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
      ) : (
        <>
          <DataTable
            caption="Transactions"
            columns={columns}
            rows={list.data.rows}
            rowKey={(r) => String(r.id)}
            defaultSort={{ key: "date", direction: "desc" }}
          />
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
        </>
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
