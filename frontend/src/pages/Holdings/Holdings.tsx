import { Inbox, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Card } from "../../components/Card";
import { Chart } from "../../components/Chart";
import { type Column, DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { Input } from "../../components/Input";
import { Money } from "../../components/Money";
import { PageHeader } from "../../components/PageHeader";
import { Percent } from "../../components/Percent";
import { Select } from "../../components/Select";
import { Sheet } from "../../components/Sheet";
import { Skeleton } from "../../components/Skeleton";
import { useDisplayPrefs } from "../../lib/displayPrefs";
import { formatDate, formatMoney, formatTime, formatQuantity } from "../../lib/format";
import { usePrefs } from "../../lib/prefs";
import {
  type HistoryRange,
  type HoldingGroupDto,
  type HoldingRowDto,
  type HoldingsGroupBy,
  useHoldingHistory,
  useHoldings,
} from "../../lib/queries/holdings";
import { toNum } from "../../lib/queries/portfolio";
import { useShellStatus } from "../../lib/shell";
import { PHONE_QUERY, useMediaQuery } from "../../lib/useMediaQuery";
import { usePersistentState, type Validator } from "../../lib/usePersistentState";
import { HoldingMobileRow } from "./HoldingMobileRow";
import { Flags, HoldingDetails, tintClass } from "./HoldingParts";
import { HoldingsKpis } from "./HoldingsKpis";
import "./Holdings.scss";

const ALL = "__all__";

type SortKey = "value" | "today" | "growth" | "weight" | "symbol";

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "value", label: "Value" },
  { value: "today", label: "Today" },
  { value: "growth", label: "Growth" },
  { value: "weight", label: "Weight" },
  { value: "symbol", label: "Symbol" },
];

const GROUP_OPTIONS: { value: HoldingsGroupBy; label: string }[] = [
  { value: "none", label: "No grouping" },
  { value: "account", label: "By account" },
  { value: "category", label: "By category" },
  { value: "asset_class", label: "By asset class" },
  { value: "currency", label: "By currency" },
];

const oneOf =
  <T extends string>(options: { value: T }[]): Validator<T> =>
  (v): v is T =>
    options.some((o) => o.value === v);

function sortNumber(row: HoldingRowDto, key: SortKey): number {
  const pick = {
    value: row.value,
    today: row.today_pct,
    growth: row.total_growth,
    weight: row.weight_pct,
    symbol: null,
  }[key];
  return toNum(pick) ?? Number.NEGATIVE_INFINITY;
}

/** Server-computed subtotals of one group (never summed in the browser). */
function Subtotals({ group, ccy }: { group: HoldingGroupDto; ccy: string }) {
  return (
    <dl className="holdings-page__subtotals" aria-label={`Subtotal ${group.key}`}>
      <div>
        <dt>Value</dt>
        <dd>
          <Money amount={toNum(group.value)} currency={ccy} />
        </dd>
      </div>
      <div>
        <dt>Cost basis</dt>
        <dd>
          <Money amount={toNum(group.cost_basis)} currency={ccy} />
        </dd>
      </div>
      <div>
        <dt>Capital gain</dt>
        <dd>
          <Money amount={toNum(group.capital_gain)} currency={ccy} signed colored />
        </dd>
      </div>
      <div>
        <dt>Dividends</dt>
        <dd>
          <Money amount={toNum(group.dividends)} currency={ccy} />
        </dd>
      </div>
      <div>
        <dt>Total return</dt>
        <dd>
          <Money amount={toNum(group.total_return)} currency={ccy} signed colored />
        </dd>
      </div>
      <div>
        <dt>Weight</dt>
        <dd>
          <Percent ratio={toNum(group.weight_pct)} digits={1} />
        </dd>
      </div>
    </dl>
  );
}

const HISTORY_RANGES: HistoryRange[] = ["1m", "3m", "6m", "ytd", "1y", "all"];

/** Daily closes (native currency) with the average purchase price as a cost-basis line. */
function HoldingDrawerChart({ row }: { row: HoldingRowDto }) {
  const defaultRange = useDisplayPrefs().holdingsRange;
  const [range, setRange] = useState<HistoryRange>(() =>
    HISTORY_RANGES.includes(defaultRange as HistoryRange) ? (defaultRange as HistoryRange) : "1y",
  );
  const history = useHoldingHistory(row.instrument_id, range);
  const avg = toNum(row.avg_price_native);
  const ccy = history.data?.ccy ?? row.native_currency;
  const points = (history.data?.points ?? []).map((p) => ({ t: p.t, v: toNum(p.v) }));
  return (
    <Chart
      series={[{ id: row.symbol, label: row.symbol, points, tone: "primary" }]}
      referenceLine={avg !== null ? { value: avg, label: "Cost basis" } : undefined}
      range={range}
      ranges={HISTORY_RANGES}
      onRangeChange={(r) => setRange(r as HistoryRange)}
      loading={history.isPending}
      valueFormat={(v) => formatMoney(v, ccy)}
      timeFormat={(t) => formatDate(new Date(t).toISOString().slice(0, 10), "short")}
      height={200}
      ariaLabel={`${row.symbol} price against cost basis`}
      emptyMessage={history.isError ? "Could not load the price history." : "No price history yet."}
    />
  );
}

function HoldingDrawer({ row, ccy, onClose }: { row: HoldingRowDto | null; ccy: string; onClose: () => void }) {
  return (
    <Sheet open={row !== null} onOpenChange={(o) => !o && onClose()} title={row ? `${row.symbol} · ${row.name}` : ""}>
      {row && (
        <div className="holdings-page__drawer">
          <p className="holdings-page__muted">
            {row.account} · {row.category} · {row.native_currency}
          </p>
          <HoldingDrawerChart row={row} />
          <HoldingDetails row={row} ccy={ccy} />
        </div>
      )}
    </Sheet>
  );
}

/** One notice above the list naming the positions whose figures cannot be trusted. */
function FlagNotice({ rows }: { rows: HoldingRowDto[] }) {
  const stale = rows.filter((r) => r.value_warning).map((r) => r.symbol);
  const bad = rows.filter((r) => r.price_data_warning).map((r) => r.symbol);
  if (stale.length === 0 && bad.length === 0) return null;
  return (
    <output className="holdings-page__notice">
      {stale.length > 0 && (
        <span>
          <strong>Stale or zero value:</strong> {stale.join(", ")}.{" "}
        </span>
      )}
      {bad.length > 0 && (
        <span>
          <strong>Suspect price history:</strong> {bad.join(", ")}.
        </span>
      )}
    </output>
  );
}

export function Holdings() {
  const { currency } = usePrefs();
  const isPhone = useMediaQuery(PHONE_QUERY);
  const [groupBy, setGroupBy] = usePersistentState<HoldingsGroupBy>("holdings.group", "none", oneOf(GROUP_OPTIONS));
  const query = useHoldings(currency, groupBy);
  const [search, setSearch] = useState("");
  const [categoryPref, setCategory] = usePersistentState<string>("holdings.category", ALL);
  const [sortKey, setSortKey] = usePersistentState<SortKey>("holdings.sort", "value", oneOf(SORT_OPTIONS));
  const [selected, setSelected] = useState<HoldingRowDto | null>(null);

  const data = query.data;
  const status = query.isPending ? "loading" : query.isError ? "stale" : "closed";
  const label = data ? `Prices as of ${formatDate(data.as_of)}` : query.isPending ? "Loading" : "Offline";
  useShellStatus(status, label, () => void query.refetch(), query.isFetching);

  const categories = useMemo(
    () => [...new Set((data?.holdings ?? []).map((h) => h.category))].sort((a, b) => a.localeCompare(b)),
    [data],
  );
  // A remembered category that no longer exists falls back to "all".
  const category = categoryPref === ALL || categories.includes(categoryPref) ? categoryPref : ALL;

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.holdings ?? []).filter(
      (h) =>
        (category === ALL || h.category === category) &&
        (q === "" || h.symbol.toLowerCase().includes(q) || h.name.toLowerCase().includes(q)),
    );
  }, [data, search, category]);

  const phoneRows = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) =>
      sortKey === "symbol" ? a.symbol.localeCompare(b.symbol) : sortNumber(b, sortKey) - sortNumber(a, sortKey),
    );
    return out;
  }, [rows, sortKey]);

  /** Server groups with their (filtered, ordered) member rows; empty groups drop out. */
  const groups = useMemo(() => {
    if (!data || groupBy === "none" || data.group_by !== groupBy) return [];
    const byId = new Map(rows.map((r) => [r.instrument_id, r]));
    const order = new Map(phoneRows.map((r, i) => [r.instrument_id, i]));
    return (data.groups ?? [])
      .map((g) => ({
        group: g,
        rows: g.instrument_ids
          .flatMap((id) => byId.get(id) ?? [])
          .sort((a, b) => (isPhone ? (order.get(a.instrument_id) ?? 0) - (order.get(b.instrument_id) ?? 0) : 0)),
      }))
      .filter((g) => g.rows.length > 0);
  }, [data, groupBy, rows, phoneRows, isPhone]);
  const filtered = search.trim() !== "" || category !== ALL;

  const columns: Column<HoldingRowDto>[] = useMemo(
    () => [
      {
        key: "symbol",
        header: "Symbol",
        primary: true,
        sortValue: (r) => r.symbol,
        cell: (r) => (
          <span className="holdings-page__symbol">
            <button
              type="button"
              className="holdings-page__open"
              aria-label={`Details for ${r.symbol}`}
              onClick={() => setSelected(r)}
            >
              <strong>{r.symbol}</strong>
            </button>
            <Flags row={r} />
          </span>
        ),
      },
      { key: "name", header: "Name", sortValue: (r) => r.name, cell: (r) => r.name },
      { key: "category", header: "Category", sortValue: (r) => r.category, cell: (r) => r.category },
      {
        key: "shares",
        header: "Shares",
        align: "right",
        sortValue: (r) => toNum(r.shares),
        cell: (r) => formatQuantity(toNum(r.shares), 4),
      },
      {
        key: "avg",
        header: "Avg price",
        align: "right",
        sortValue: (r) => toNum(r.avg_price_native),
        cell: (r) => formatMoney(toNum(r.avg_price_native), r.native_currency),
      },
      {
        key: "price",
        header: "Price",
        align: "right",
        sortValue: (r) => toNum(r.price_native),
        cell: (r) => formatMoney(toNum(r.price_native), r.native_currency, { unmasked: true }),
      },
      {
        key: "asof",
        header: "As of",
        sortValue: (r) => r.price_as_of ?? "",
        cell: (r) => (r.price_as_of ? formatDate(r.price_as_of, "short") : "–"),
      },
      {
        key: "expense",
        header: "Expense",
        align: "right",
        sortValue: (r) => toNum(r.expense_ratio),
        cell: (r) => <Percent ratio={toNum(r.expense_ratio)} />,
      },
      {
        key: "cost",
        header: "Cost basis",
        align: "right",
        sortValue: (r) => toNum(r.cost_basis),
        cell: (r) => <Money amount={toNum(r.cost_basis)} currency={currency} />,
      },
      {
        key: "value",
        header: "Value",
        align: "right",
        sortValue: (r) => toNum(r.value),
        cell: (r) => <Money amount={toNum(r.value)} currency={currency} />,
      },
      {
        key: "weight",
        header: "Weight",
        align: "right",
        sortValue: (r) => toNum(r.weight_pct),
        cell: (r) => <Percent ratio={toNum(r.weight_pct)} digits={1} />,
      },
      {
        key: "gain",
        header: "Capital gain",
        align: "right",
        sortValue: (r) => toNum(r.capital_gain),
        cell: (r) => <Money amount={toNum(r.capital_gain)} currency={currency} signed colored />,
      },
      {
        key: "divs",
        header: "Dividends",
        align: "right",
        sortValue: (r) => toNum(r.dividends),
        cell: (r) => <Money amount={toNum(r.dividends)} currency={currency} />,
      },
      {
        key: "totret",
        header: "Total return",
        align: "right",
        sortValue: (r) => toNum(r.total_return),
        cell: (r) => <Money amount={toNum(r.total_return)} currency={currency} signed colored />,
      },
      {
        key: "xirr",
        header: "XIRR",
        align: "right",
        sortValue: (r) => toNum(r.xirr),
        cell: (r) => <Percent ratio={toNum(r.xirr)} signed colored />,
      },
      {
        key: "growth",
        header: "Growth",
        align: "right",
        sortValue: (r) => toNum(r.total_growth),
        cell: (r) => <Percent ratio={toNum(r.total_growth)} signed colored />,
      },
      {
        key: "ytd",
        header: "YTD",
        align: "right",
        sortValue: (r) => toNum(r.ytd_growth),
        cell: (r) => <Percent ratio={toNum(r.ytd_growth)} signed colored />,
      },
      {
        key: "mtd",
        header: "MTD",
        align: "right",
        sortValue: (r) => toNum(r.mtd_growth),
        cell: (r) => <Percent ratio={toNum(r.mtd_growth)} signed colored />,
      },
      {
        key: "today",
        header: "Today",
        align: "right",
        sortValue: (r) => toNum(r.today_pct),
        cell: (r) => <Percent ratio={toNum(r.today_pct)} signed colored />,
      },
    ],
    [currency],
  );

  if (query.isError && !data) {
    return (
      <div className="holdings-page">
        <PageHeader title="Holdings" subtitle="Every position in full detail" />
        <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />
      </div>
    );
  }
  if (data && data.holdings.length === 0) {
    return (
      <div className="holdings-page">
        <PageHeader title="Holdings" subtitle="Every position in full detail" />
        <EmptyState
          icon={<Inbox aria-hidden />}
          title="No positions yet"
          description="Import a broker file from Transactions to see your holdings here."
        />
      </div>
    );
  }

  const groupedReady = groupBy !== "none" && data?.group_by === groupBy;
  const table = (list: HoldingRowDto[], caption: string) => (
    <DataTable
      className="holdings-page__table"
      caption={caption}
      columns={columns}
      rows={list}
      rowKey={(r) => String(r.instrument_id)}
      rowClassName={tintClass}
      defaultSort={{ key: "value", direction: "desc" }}
      emptyMessage="No holdings match your filters."
    />
  );
  const phoneList = (list: HoldingRowDto[]) => (
    <ul className="holdings-page__list">
      {list.map((r) => (
        <HoldingMobileRow key={r.instrument_id} row={r} ccy={currency} onOpenChart={setSelected} />
      ))}
    </ul>
  );

  return (
    <div className="holdings-page">
      <PageHeader
        title="Holdings"
        subtitle="Every position in full detail"
        actions={data ? <span className="holdings-page__muted">Updated {formatTime(data.as_of)}</span> : undefined}
      />

      <HoldingsKpis data={data} currency={currency} />
      <FlagNotice rows={data?.holdings ?? []} />

      <div className="holdings-page__toolbar">
        <Input
          data-search
          type="search"
          aria-label="Search holdings"
          placeholder="Search symbol or name"
          leftIcon={<Search aria-hidden size={16} />}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          ariaLabel="Category"
          value={category}
          onValueChange={setCategory}
          options={[{ value: ALL, label: "All categories" }, ...categories.map((c) => ({ value: c, label: c }))]}
        />
        <Select
          ariaLabel="Group by"
          value={groupBy}
          onValueChange={(v) => setGroupBy(v as HoldingsGroupBy)}
          options={GROUP_OPTIONS}
        />
        {isPhone && (
          <Select
            ariaLabel="Sort by"
            value={sortKey}
            onValueChange={(v) => setSortKey(v as SortKey)}
            options={SORT_OPTIONS}
          />
        )}
      </div>
      {groupedReady && filtered && (
        <p className="holdings-page__muted">Subtotals cover every position in the group, not only the matches.</p>
      )}

      {query.isPending ? (
        <Skeleton height="12rem" />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Search aria-hidden />} title="No matches" description="Try a different search or category." />
      ) : groupedReady ? (
        groups.map(({ group, rows: members }) => (
          <Card
            key={group.key}
            title={group.key || "(none)"}
            subtitle={`${group.count} position${group.count === 1 ? "" : "s"}`}
            collapsibleId={`holdings.group.${groupBy}.${group.key}`}
            flush
          >
            <Subtotals group={group} ccy={currency} />
            {isPhone ? phoneList(members) : table(members, `Holdings: ${group.key}`)}
          </Card>
        ))
      ) : isPhone ? (
        <Card title="Positions" subtitle={`${phoneRows.length} holdings`} collapsibleId="holdings.list" flush>
          {phoneList(phoneRows)}
        </Card>
      ) : (
        table(rows, "All holdings")
      )}
      <HoldingDrawer row={selected} ccy={currency} onClose={() => setSelected(null)} />
    </div>
  );
}
