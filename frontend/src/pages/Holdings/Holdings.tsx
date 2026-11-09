import clsx from "clsx";
import { Inbox, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Card } from "../../components/Card";
import { Chart } from "../../components/Chart";
import { type Column, DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { foldStamps, formatStamp, holdingMarks, PriceStamps, PriceTick } from "../../components/Freshness";
import { ErrorState } from "../../components/ErrorState";
import { Input } from "../../components/Input";
import { Money } from "../../components/Money";
import { PageHeader } from "../../components/PageHeader";
import { Percent } from "../../components/Percent";
import { Select } from "../../components/Select";
import { Sheet } from "../../components/Sheet";
import { Skeleton } from "../../components/Skeleton";
import { useDisplayPrefs } from "../../lib/displayPrefs";
import { formatAxisDate, formatDate, formatMoney, formatQuantity } from "../../lib/format";
import { usePrefs } from "../../lib/prefs";
import {
  type HistoryRange,
  type HoldingRowDto,
  type HoldingsGroupBy,
  useHoldingHistory,
  useHoldings,
} from "../../lib/queries/holdings";
import { toNum } from "../../lib/queries/portfolio";
import { useTimeZone } from "../../lib/timezone";
import { useShellStatus } from "../../lib/shell";
import { PHONE_QUERY, useMediaQuery } from "../../lib/useMediaQuery";
import { usePersistentState, type Validator } from "../../lib/usePersistentState";
import { HoldingMobileRow } from "./HoldingMobileRow";
import { GroupSummary } from "./GroupSummary";
import { EstChip, Flags, HoldingDetails, RowStamp, TwinBlock, TwinLine, WeightCell, tintClass } from "./HoldingParts";
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
      timeFormat={(t) => formatAxisDate(t, range === "1m" || range === "3m" || range === "6m" ? 0 : Infinity)}
      tooltipTimeFormat={(t) => formatDate(new Date(t).toISOString().slice(0, 10))}
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
          <TwinBlock row={row} ccy={ccy} />
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
  const timeZone = useTimeZone();
  // The price time is said once (page header + top bar); a row says its own only when it differs.
  const stamps = useMemo(() => foldStamps(data?.holdings ?? [], { timeZone }), [data, timeZone]);
  const priceText = stamps.price;
  const marks = useMemo(() => holdingMarks(data?.holdings ?? [], { timeZone }), [data, timeZone]);
  const label = data ? `Prices as of ${priceText ?? formatDate(data.as_of)}` : query.isPending ? "Loading" : "Offline";
  const shortText = useMemo(
    () => foldStamps(data?.holdings ?? [], { timeZone, weekdays: true }).price,
    [data, timeZone],
  );
  const short = data ? (shortText ?? formatAxisDate(Date.parse(data.as_of), 0)) : undefined;
  const updated = stamps.updated ? `Updated ${formatStamp(stamps.updated, { timeZone })}` : undefined;
  useShellStatus(status, label, () => void query.refetch(), query.isFetching, short, updated);
  const maxWeight = useMemo(() => Math.max(0, ...(data?.holdings ?? []).map((h) => toNum(h.weight_pct) ?? 0)), [data]);

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
        header: "Holding",
        primary: true,
        sortValue: (r) => r.symbol,
        cell: (r) => (
          <span className="holdings-page__holding">
            <span className="holdings-page__symbol">
              <button
                type="button"
                className="holdings-page__open"
                aria-label={`Details for ${r.symbol}`}
                onClick={() => setSelected(r)}
              >
                {r.symbol}
              </button>
              <Flags row={r} />
            </span>
            <span className="holdings-page__holding-name" title={r.name}>
              {r.name}
            </span>
            <TwinLine row={r} />
          </span>
        ),
      },
      {
        key: "category",
        header: "Category",
        sortValue: (r) => r.category,
        cell: (r) => <span className="holdings-page__category">{r.category}</span>,
      },
      {
        key: "shares",
        header: "Shares",
        group: "Position",
        align: "right",
        sortValue: (r) => toNum(r.shares),
        cell: (r) => formatQuantity(toNum(r.shares), 4),
      },
      {
        key: "avg",
        header: "Avg price",
        group: "Position",
        align: "right",
        sortValue: (r) => toNum(r.avg_price_native),
        cell: (r) => formatMoney(toNum(r.avg_price_native), r.native_currency),
      },
      {
        key: "price",
        header: "Price",
        group: "Position",
        align: "right",
        sortValue: (r) => toNum(r.price_native),
        cell: (r) => (
          <span className="holdings-page__stack">
            <span className="holdings-page__price">
              {formatMoney(toNum(r.price_native), r.native_currency, { unmasked: true })}
              <PriceTick title={marks.tick(r)} />
            </span>
            {/* The price above is the last NAV the fund actually published; while
                today's is still pending the twin's estimate of it sits underneath,
                marked, so the official figure is never the one that moved. */}
            {r.twin?.pending && toNum(r.twin.est_price) !== null && (
              <span
                className="holdings-page__stack-sub"
                title={`Estimated from the ETF ${r.twin.symbol} until ${r.symbol}'s NAV posts`}
              >
                <EstChip>≈</EstChip>{" "}
                {formatMoney(toNum(r.twin.est_price), r.native_currency, { unmasked: true })}
              </span>
            )}
            <RowStamp text={stamps.rowPrice(r)} />
          </span>
        ),
      },
      {
        key: "expense",
        header: "Fee",
        group: "Position",
        align: "right",
        sortValue: (r) => toNum(r.expense_ratio),
        cell: (r) => <Percent ratio={toNum(r.expense_ratio)} />,
      },
      {
        key: "cost",
        header: "Cost basis",
        group: "Value",
        align: "right",
        sortValue: (r) => toNum(r.cost_basis),
        cell: (r) => <Money amount={toNum(r.cost_basis)} currency={currency} />,
      },
      {
        key: "value",
        header: "Value",
        group: "Value",
        align: "right",
        phone: "headline",
        emphasis: true,
        sortValue: (r) => toNum(r.value),
        cell: (r) => (
          <span className="holdings-page__stack">
            <Money amount={toNum(r.value)} currency={currency} />
            {r.twin?.pending && toNum(r.twin.est_value) !== null && (
              <span
                className="holdings-page__stack-sub"
                title={`The holding at ${r.twin.symbol}'s estimate, until ${r.symbol}'s NAV posts`}
              >
                <EstChip>≈</EstChip> <Money amount={toNum(r.twin.est_value)} currency={currency} />
              </span>
            )}
          </span>
        ),
      },
      {
        key: "weight",
        header: "Weight",
        group: "Value",
        align: "right",
        sortValue: (r) => toNum(r.weight_pct),
        cell: (r) => <WeightCell ratio={toNum(r.weight_pct)} max={maxWeight} />,
      },
      {
        key: "divs",
        header: "Dividends",
        group: "Return",
        align: "right",
        sortValue: (r) => toNum(r.dividends),
        cell: (r) => <Money amount={toNum(r.dividends)} currency={currency} />,
      },
      {
        key: "totret",
        header: "Total return",
        group: "Return",
        align: "right",
        emphasis: true,
        sortValue: (r) => toNum(r.total_return),
        cell: (r) => <Money amount={toNum(r.total_return)} currency={currency} signed colored />,
      },
      {
        key: "growth",
        header: "Growth",
        group: "Return",
        align: "right",
        sortValue: (r) => toNum(r.total_growth),
        cell: (r) => <Percent ratio={toNum(r.total_growth)} signed colored />,
      },
      {
        key: "xirr",
        header: "XIRR",
        group: "Return",
        align: "right",
        sortValue: (r) => toNum(r.xirr),
        cell: (r) => <Percent ratio={toNum(r.xirr)} signed colored />,
      },
      {
        key: "today",
        header: "Day",
        group: "Period",
        align: "right",
        sortValue: (r) => toNum(r.today_pct),
        cell: (r) => {
          const note = marks.staleMove(r);
          return (
            <span
              className={clsx("holdings-page__stack", note && "holdings-page__today--stale")}
              title={note ?? undefined}
            >
              <Percent ratio={toNum(r.today_pct)} signed colored={!note} />
              <span className="holdings-page__stack-sub">
                <Money amount={toNum(r.today_move)} currency={currency} signed />
              </span>
              {note && <span className="holdings-page__sr">{note}</span>}
            </span>
          );
        },
      },
      {
        key: "mtd",
        header: "MTD",
        group: "Period",
        align: "right",
        sortValue: (r) => toNum(r.mtd_growth),
        cell: (r) => <Percent ratio={toNum(r.mtd_growth)} signed colored />,
      },
      {
        key: "ytd",
        header: "YTD",
        group: "Period",
        align: "right",
        sortValue: (r) => toNum(r.ytd_growth),
        cell: (r) => <Percent ratio={toNum(r.ytd_growth)} signed colored />,
      },
    ],
    [currency, maxWeight, stamps, marks],
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
        <HoldingMobileRow
          key={r.instrument_id}
          row={r}
          ccy={currency}
          stamp={stamps.rowPrice(r)}
          tick={marks.tick(r)}
          staleMove={marks.staleMove(r)}
          onOpenChart={setSelected}
        />
      ))}
    </ul>
  );

  return (
    <div className="holdings-page">
      <PageHeader
        title="Holdings"
        subtitle="Every position in full detail"
      />

      <HoldingsKpis data={data} currency={currency} />
      <FlagNotice rows={data?.holdings ?? []} />

      <div className="holdings-page__toolbar">
        <div className="holdings-page__tool holdings-page__tool--search">
        <Input
          data-search
          type="search"
          aria-label="Search holdings"
          placeholder="Search symbol or name"
          leftIcon={<Search aria-hidden size={16} />}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        </div>
        <div className="holdings-page__tool holdings-page__tool--category">
        <Select
          ariaLabel="Category"
          value={category}
          onValueChange={setCategory}
          options={[{ value: ALL, label: "All categories" }, ...categories.map((c) => ({ value: c, label: c }))]}
        />
        </div>
        <div className="holdings-page__tool holdings-page__tool--group">
        <Select
          ariaLabel="Group by"
          value={groupBy}
          onValueChange={(v) => setGroupBy(v as HoldingsGroupBy)}
          options={GROUP_OPTIONS}
        />
        </div>
        {isPhone && (
          <div className="holdings-page__tool holdings-page__tool--sort">
          <Select
            ariaLabel="Sort by"
            value={sortKey}
            onValueChange={(v) => setSortKey(v as SortKey)}
            options={SORT_OPTIONS}
          />
          </div>
        )}
      </div>
      {groupedReady && filtered && (
        <p className="holdings-page__muted">Subtotals cover every position in the group, not only the matches.</p>
      )}

      {data && (
        <div className="holdings-page__stamps">
          <PriceStamps priceText={stamps.price} updated={stamps.updated} options={{ timeZone }} />
        </div>
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
            <GroupSummary group={group} ccy={currency} />
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
