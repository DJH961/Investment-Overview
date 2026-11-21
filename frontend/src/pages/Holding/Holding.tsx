import { useQuery } from "@tanstack/react-query";
import { Inbox } from "lucide-react";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import { Chip } from "../../components/Chip";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { HoldingPills } from "../../components/HoldingIdentity";
import { Money } from "../../components/Money";
import { Percent } from "../../components/Percent";
import { Skeleton } from "../../components/Skeleton";
import { type TabItem, Tabs } from "../../components/Tabs";
import { usePrefs } from "../../lib/prefs";
import { useDividends } from "../../lib/queries/activity";
import { type HoldingRowDto, useHoldings } from "../../lib/queries/holdings";
import { type TransactionFilters, transactionsQuery } from "../../lib/queries/ledger";
import { toNum } from "../../lib/queries/portfolio";
import { DividendsTab } from "./DividendsTab";
import { BackLink, HoldingHeader } from "./HoldingHeader";
import { assetClassLabel } from "./holdingFormat";
import { isNavFund, PerformanceTab } from "./PerformanceTab";
import { TranchesTab } from "./TranchesTab";
import { TransactionsTab } from "./TransactionsTab";
import { TwinTab } from "./TwinTab";
import "./Holding.scss";

export type TabKey = "performance" | "twin" | "tranches" | "transactions" | "dividends";
const ALL_TABS: TabKey[] = ["performance", "twin", "tranches", "transactions", "dividends"];

/** Only NAV funds with an ETF twin get the Twin tab (right after Performance). */
export function tabsFor(row: HoldingRowDto): TabKey[] {
  return ALL_TABS.filter((t) => t !== "twin" || (isNavFund(row) && row.twin != null));
}

const tabPath = (id: string, tab: TabKey) => (tab === "performance" ? `/holdings/${id}` : `/holdings/${id}/${tab}`);

export function HoldingChips({ row }: { row: HoldingRowDto }) {
  // The NAV / CASH pill already says what a fund is; the type chip would repeat it.
  const type = row.price_type === "nav" || row.is_money_market ? null : assetClassLabel(row.asset_class);
  return (
    <>
      <Chip size="sm" outline title={row.account} className="holding-page__chip">
        {row.account}
      </Chip>
      <Chip size="sm" outline className="holding-page__chip holding-page__chip--fixed">
        {row.category}
      </Chip>
      <Chip size="sm" outline className="holding-page__chip holding-page__chip--fixed">
        {row.native_currency}
      </Chip>
      {type && (
        <Chip size="sm" outline className="holding-page__chip holding-page__chip--fixed">
          {type}
        </Chip>
      )}
    </>
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
  const txns = (txQuery.data?.rows ?? []).filter((t) => t.symbol === symbol);
  const divCount = (dividends.data?.rows ?? []).filter((d) => d.symbol === symbol).length;

  // The old Details tab folded into Performance (7.1): keep its links working.
  if (tab === "details") return <Navigate to={`/holdings/${id}`} replace />;
  if (tab !== undefined && !ALL_TABS.includes(tab as TabKey)) return <Navigate to={`/holdings/${id}`} replace />;

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

  const tabs = tabsFor(row);
  // A twin link on a fund that has none (any more) lands on Performance.
  if (tab !== undefined && !tabs.includes(tab as TabKey)) return <Navigate to={`/holdings/${id}`} replace />;
  const active: TabKey = (tab as TabKey | undefined) ?? "performance";

  const content: Record<TabKey, { label: string; badge?: number; node: React.ReactNode }> = {
    performance: { label: "Performance", node: <PerformanceTab row={row} ccy={currency} /> },
    twin: { label: "Twin", node: <TwinTab row={row} /> },
    tranches: { label: "Tranches", node: <TranchesTab row={row} /> },
    transactions: {
      label: "Transactions",
      badge: txQuery.data ? txns.length : undefined,
      node: <TransactionsTab row={row} txns={txns} pending={txQuery.isPending} error={txQuery.isError} />,
    },
    dividends: {
      label: "Dividends",
      badge: dividends.data ? divCount : undefined,
      node: (
        <DividendsTab
          row={row}
          ccy={currency}
          data={dividends.data}
          pending={dividends.isPending}
          error={dividends.isError}
          onRetry={() => void dividends.refetch()}
          txns={txns}
        />
      ),
    },
  };
  const items: TabItem<TabKey>[] = tabs.map((t) => ({
    value: t,
    label: content[t].label,
    badge: content[t].badge,
    // Only the open tab mounts its content (each one fetches its own data).
    content: t === active ? content[t].node : null,
  }));

  return (
    <div className="holding-page">
      <HoldingHeader
        symbol={row.symbol}
        name={row.name}
        chips={<HoldingChips row={row} />}
        pills={<HoldingPills row={row} live={row.market_open && !row.daily_is_stale} />}
        value={<Money amount={toNum(row.value)} currency={currency} />}
        today={
          <>
            <Money amount={toNum(row.today_move)} currency={currency} signed colored={!row.daily_is_stale} />
            <Percent ratio={toNum(row.today_pct)} signed colored={!row.daily_is_stale} />
          </>
        }
      />
      <Tabs
        items={items}
        value={active}
        ariaLabel="Holding views"
        // Four tabs fit a 360 px phone; a NAV fund's fifth (Twin) scrolls sideways.
        fit={tabs.length <= 4}
        // Replace, not push: Back leaves the holding instead of stepping through its tabs.
        onChange={(t) => navigate(tabPath(id, t), { replace: true })}
      />
    </div>
  );
}
