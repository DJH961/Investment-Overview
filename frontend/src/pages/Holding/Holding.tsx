import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, Inbox } from "lucide-react";
import { useMemo } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import { type Column, DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { Money } from "../../components/Money";
import { PageHeader } from "../../components/PageHeader";
import { Skeleton } from "../../components/Skeleton";
import { type TabItem, Tabs } from "../../components/Tabs";
import { formatDate } from "../../lib/format";
import { usePrefs } from "../../lib/prefs";
import { useDividends } from "../../lib/queries/activity";
import { type HoldingRowDto, useHoldings } from "../../lib/queries/holdings";
import { type TransactionFilters, type TransactionOut, transactionsQuery } from "../../lib/queries/ledger";
import { toNum } from "../../lib/queries/portfolio";
import { Flags, HoldingDetails, HoldingDrawerChart, TwinBlock } from "../Holdings/HoldingParts";
import { formatPrice, formatQuantity, num } from "../Transactions/numbers";
import "../Holdings/Holdings.scss";
import "./Holding.scss";

type TabKey = "details" | "transactions" | "dividends";
const TABS: TabKey[] = ["details", "transactions", "dividends"];

const KIND_LABEL: Record<string, string> = {
  buy: "Buy",
  sell: "Sell",
  dividend_cash: "Dividend",
  dividend_reinvest: "Div. reinvest",
  split: "Split",
  transfer_in: "Transfer in",
  transfer_out: "Transfer out",
};

const tabPath = (id: string, tab: TabKey) => (tab === "details" ? `/holdings/${id}` : `/holdings/${id}/${tab}`);

function BackLink() {
  return (
    <Link to="/holdings" className="holding-page__back">
      <ChevronLeft aria-hidden size={16} />
      Holdings
    </Link>
  );
}

function TransactionsTab({ row, txns, pending, error }: { row: HoldingRowDto; txns: TransactionOut[]; pending: boolean; error: boolean }) {
  const columns: Column<TransactionOut>[] = [
    { key: "date", header: "Date", primary: true, cell: (r) => formatDate(r.date), nowrap: true },
    {
      key: "kind",
      header: "Kind",
      phone: "inline",
      cell: (r) => KIND_LABEL[r.kind] ?? r.kind,
    },
    { key: "quantity", header: "Qty", align: "right", cell: (r) => formatQuantity(r.quantity) },
    {
      key: "price",
      header: "Price",
      align: "right",
      cell: (r) => (r.price_native == null ? "–" : <span className="money">{formatPrice(r.price_native, r.currency)}</span>),
    },
    {
      key: "net",
      header: "Net",
      align: "right",
      phone: "headline",
      // In the row's own currency, as stored: nothing is converted here.
      cell: (r) => <Money amount={num(r.net_native)} currency={r.currency} signed />,
    },
  ];
  if (error) return <ErrorState message="Could not load the transactions." />;
  if (pending) return <Skeleton height="10rem" />;
  if (txns.length === 0) {
    return <EmptyState icon={<Inbox aria-hidden />} title={`No transactions for ${row.symbol} yet.`} />;
  }
  return (
    <div className="holding-page__panel">
      <DataTable
        caption={`Transactions for ${row.symbol}`}
        columns={columns}
        rows={txns}
        rowKey={(r) => String(r.id)}
      />
      <Link to="/transactions" className="holding-page__more">
        All transactions
      </Link>
    </div>
  );
}

export function Holding() {
  const { id = "", tab } = useParams();
  const navigate = useNavigate();
  const { currency } = usePrefs();
  const holdings = useHoldings(currency);
  const dividends = useDividends(currency);
  const row = (holdings.data?.holdings ?? []).find((h) => String(h.instrument_id) === id) ?? null;
  const symbol = row?.symbol ?? "";

  const filters: TransactionFilters = {
    symbol,
    hide_sweeps: true,
    sort: "date",
    order: "desc",
    limit: 200,
    offset: 0,
  };
  const txQuery = useQuery({ ...transactionsQuery(filters), enabled: symbol !== "" });
  // A list we already hold, filtered again here: the server's symbol filter is a prefix match.
  const txns = useMemo(() => (txQuery.data?.rows ?? []).filter((t) => t.symbol === symbol), [txQuery.data, symbol]);
  const divRows = useMemo(
    () => (dividends.data?.rows ?? []).filter((d) => d.symbol === symbol),
    [dividends.data, symbol],
  );
  const divTotals = (dividends.data?.by_holding ?? []).find((h) => h.symbol === symbol) ?? null;

  if (tab !== undefined && !TABS.includes(tab as TabKey)) return <Navigate to={`/holdings/${id}`} replace />;
  const active: TabKey = (tab as TabKey | undefined) ?? "details";

  if (holdings.isError && !holdings.data) {
    return (
      <div className="holding-page">
        <BackLink />
        <ErrorState message={holdings.error.message} onRetry={() => void holdings.refetch()} />
      </div>
    );
  }
  if (holdings.isPending) {
    return (
      <div className="holding-page">
        <BackLink />
        <Skeleton height="12rem" />
      </div>
    );
  }
  if (!row) {
    return (
      <div className="holding-page">
        <BackLink />
        <EmptyState
          icon={<Inbox aria-hidden />}
          title="We can't find this holding"
          description="It may have been sold or renamed. Open the list to pick another one."
          action={<Link to="/holdings">Back to Holdings</Link>}
        />
      </div>
    );
  }

  const dividendColumns: Column<(typeof divRows)[number]>[] = [
    { key: "date", header: "Date", primary: true, cell: (r) => formatDate(r.date), nowrap: true },
    { key: "kind", header: "Kind", phone: "inline", cell: (r) => (r.kind === "interest" ? "Interest" : r.kind === "reinvest" ? "Reinvested" : "Cash") },
    { key: "account", header: "Account", phone: "hide", cell: (r) => r.account },
    {
      key: "amount",
      header: `Amount (${currency})`,
      align: "right",
      phone: "headline",
      cell: (r) => <Money amount={toNum(r.amount)} currency={currency} />,
    },
  ];

  const items: TabItem<TabKey>[] = [
    {
      value: "details",
      label: "Details",
      content: (
        <div className="holdings-page__drawer">
          <HoldingDrawerChart row={row} />
          <HoldingDetails row={row} ccy={currency} />
          <TwinBlock row={row} ccy={currency} />
        </div>
      ),
    },
    {
      value: "transactions",
      label: "Transactions",
      badge: txQuery.data ? txns.length : undefined,
      content: <TransactionsTab row={row} txns={txns} pending={txQuery.isPending} error={txQuery.isError} />,
    },
    {
      value: "dividends",
      label: "Dividends",
      badge: dividends.data ? divRows.length : undefined,
      content: dividends.isError ? (
        <ErrorState message="Could not load the dividends." onRetry={() => void dividends.refetch()} />
      ) : dividends.isPending ? (
        <Skeleton height="10rem" />
      ) : divRows.length === 0 ? (
        <EmptyState icon={<Inbox aria-hidden />} title={`No dividends from ${row.symbol} yet.`} />
      ) : (
        <div className="holding-page__panel">
          {divTotals && (
            <p className="holding-page__total">
              Lifetime from {row.symbol}: <Money amount={toNum(divTotals.lifetime)} currency={currency} />
            </p>
          )}
          <DataTable
            caption={`Dividends from ${row.symbol}`}
            columns={dividendColumns}
            rows={divRows}
            rowKey={(r) => String(r.id ?? `${r.date}-${r.kind}-${r.amount}`)}
          />
        </div>
      ),
    },
  ];

  return (
    <div className="holding-page">
      <BackLink />
      <PageHeader
        title={row.symbol}
        subtitle={`${row.name} · ${row.account} · ${row.category} · ${row.native_currency}`}
        actions={<Flags row={row} />}
      />
      <Tabs
        items={items}
        value={active}
        ariaLabel="Holding views"
        // Replace, not push: Back leaves the holding instead of stepping through its tabs.
        onChange={(t) => navigate(tabPath(id, t), { replace: true })}
      />
    </div>
  );
}
