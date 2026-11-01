import { ChevronDown, Inbox, Search } from "lucide-react";
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
import { formatDate, formatMoney, formatNumber, formatPercent, formatTime } from "../../lib/format";
import { usePrefs } from "../../lib/prefs";
import { type HoldingRowDto, toNum, useHoldings } from "../../lib/queries/portfolio";
import { useShellStatus } from "../../lib/shell";
import { PHONE_QUERY, useMediaQuery } from "../../lib/useMediaQuery";
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

function Flags({ row }: { row: HoldingRowDto }) {
  return (
    <span className="holdings-page__flags">
      {row.is_money_market && <span className="holdings-page__flag">PAR</span>}
      {row.price_type === "nav" && <span className="holdings-page__flag">NAV</span>}
      {row.value_warning && <span className="holdings-page__flag holdings-page__flag--warn">stale value</span>}
      {row.price_data_warning && <span className="holdings-page__flag holdings-page__flag--warn">bad history</span>}
    </span>
  );
}

type GroupBy = "none" | "account" | "asset_class" | "currency";

const GROUP_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: "none", label: "No grouping" },
  { value: "account", label: "By account" },
  { value: "asset_class", label: "By asset class" },
  { value: "currency", label: "By currency" },
];

function groupKey(row: HoldingRowDto, by: GroupBy): string {
  if (by === "account") return row.account;
  if (by === "asset_class") return row.asset_class;
  if (by === "currency") return row.native_currency;
  return "";
}

export interface HoldingGroup {
  key: string;
  rows: HoldingRowDto[];
  value: number;
  cost: number;
  gain: number;
  dividends: number;
  totalReturn: number;
  weight: number;
}

/** Split rows into groups (largest value first) with summed subtotals in the reporting currency. */
export function groupHoldings(rows: HoldingRowDto[], by: GroupBy): HoldingGroup[] {
  const map = new Map<string, HoldingRowDto[]>();
  for (const r of rows) {
    const k = groupKey(r, by);
    map.set(k, [...(map.get(k) ?? []), r]);
  }
  const sum = (rs: HoldingRowDto[], pick: (r: HoldingRowDto) => string | null | undefined) =>
    rs.reduce((acc, r) => acc + (toNum(pick(r)) ?? 0), 0);
  return [...map.entries()]
    .map(([key, rs]) => ({
      key,
      rows: rs,
      value: sum(rs, (r) => r.value),
      cost: sum(rs, (r) => r.cost_basis),
      gain: sum(rs, (r) => r.capital_gain),
      dividends: sum(rs, (r) => r.dividends),
      totalReturn: sum(rs, (r) => r.total_return),
      weight: sum(rs, (r) => r.weight_pct),
    }))
    .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
}

function HoldingDetails({ id, row, ccy }: { id?: string; row: HoldingRowDto; ccy: string }) {
  return (
    <dl id={id} className="holdings-page__detail">
      <div>
        <dt>Price</dt>
        <dd>{formatMoney(toNum(row.price_native), row.native_currency)}</dd>
      </div>
      <div>
        <dt>Shares</dt>
        <dd>{formatNumber(toNum(row.shares), 4)}</dd>
      </div>
      <div>
        <dt>Cost basis</dt>
        <dd>
          <Money amount={toNum(row.cost_basis)} currency={ccy} />
        </dd>
      </div>
      <div>
        <dt>Capital gain</dt>
        <dd>
          <Money amount={toNum(row.capital_gain)} currency={ccy} signed colored />
        </dd>
      </div>
      <div>
        <dt>Dividends</dt>
        <dd>
          <Money amount={toNum(row.dividends)} currency={ccy} />
        </dd>
      </div>
      <div>
        <dt>Total return (incl. dividends)</dt>
        <dd>
          <Money amount={toNum(row.total_return)} currency={ccy} signed colored />
        </dd>
      </div>
      <div>
        <dt>Growth</dt>
        <dd>
          <Percent ratio={toNum(row.total_growth)} signed colored />
        </dd>
      </div>
      <div>
        <dt>XIRR</dt>
        <dd>
          <Percent ratio={toNum(row.xirr)} signed colored />
        </dd>
      </div>
      <div>
        <dt>Weight</dt>
        <dd>{formatPercent(toNum(row.weight_pct), { digits: 1 })}</dd>
      </div>
      <div>
        <dt>Expense</dt>
        <dd>{formatPercent(toNum(row.expense_ratio))}</dd>
      </div>
    </dl>
  );
}

function Subtotals({ group, ccy }: { group: HoldingGroup; ccy: string }) {
  return (
    <dl className="holdings-page__subtotals" aria-label={`Subtotal ${group.key}`}>
      <div>
        <dt>Value</dt>
        <dd>
          <Money amount={group.value} currency={ccy} />
        </dd>
      </div>
      <div>
        <dt>Cost basis</dt>
        <dd>
          <Money amount={group.cost} currency={ccy} />
        </dd>
      </div>
      <div>
        <dt>Capital gain</dt>
        <dd>
          <Money amount={group.gain} currency={ccy} signed colored />
        </dd>
      </div>
      <div>
        <dt>Dividends</dt>
        <dd>
          <Money amount={group.dividends} currency={ccy} />
        </dd>
      </div>
      <div>
        <dt>Total return</dt>
        <dd>
          <Money amount={group.totalReturn} currency={ccy} signed colored />
        </dd>
      </div>
      <div>
        <dt>Weight</dt>
        <dd>{formatPercent(group.weight, { digits: 1 })}</dd>
      </div>
    </dl>
  );
}

const DAY_MS = 86_400_000;

/** Last two closes (previous close derived from today's move) against the average purchase price. */
function HoldingDrawerChart({ row }: { row: HoldingRowDto }) {
  const price = toNum(row.price_native);
  const move = toNum(row.today_pct);
  const avg = toNum(row.avg_price_native);
  const at = row.price_as_of ? Date.parse(row.price_as_of) : Number.NaN;
  const points =
    price !== null && Number.isFinite(at)
      ? [
          ...(move !== null && move > -1 ? [{ t: at - DAY_MS, v: price / (1 + move) }] : []),
          { t: at, v: price },
        ]
      : [];
  return (
    <Chart
      series={[{ id: row.symbol, label: row.symbol, points, tone: "primary" }]}
      referenceLine={avg !== null ? { value: avg, label: "Cost basis" } : undefined}
      valueFormat={(v) => formatMoney(v, row.native_currency)}
      timeFormat={(t) => formatDate(new Date(t).toISOString().slice(0, 10), "short")}
      height={180}
      ariaLabel={`${row.symbol} price against cost basis`}
      emptyMessage="No price yet."
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

function MobileRow({ row, ccy }: { row: HoldingRowDto; ccy: string }) {
  const [open, setOpen] = useState(false);
  const detailId = `holding-detail-${row.instrument_id}`;
  return (
    <li className="holdings-page__item" data-search-row>
      <button
        type="button"
        className="holdings-page__item-head"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="holdings-page__item-title">
          <strong>{row.symbol}</strong>
          <span className="holdings-page__muted">{row.name}</span>
          <Flags row={row} />
        </span>
        <span className="holdings-page__item-figures">
          <Money amount={toNum(row.value)} currency={ccy} />
          <Percent ratio={toNum(row.today_pct)} signed colored />
        </span>
        <ChevronDown aria-hidden size={16} className="holdings-page__chevron" />
      </button>
      {open && (
        <HoldingDetails id={detailId} row={row} ccy={ccy} />
      )}
    </li>
  );
}

export function Holdings() {
  const { currency } = usePrefs();
  const isPhone = useMediaQuery(PHONE_QUERY);
  const query = useHoldings(currency);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState(ALL);
  const [sortKey, setSortKey] = useState<SortKey>("value");
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [selected, setSelected] = useState<HoldingRowDto | null>(null);

  const data = query.data;
  const status = query.isPending ? "loading" : query.isError ? "stale" : "closed";
  const label = data ? `Prices as of ${formatDate(data.as_of)}` : query.isPending ? "Loading" : "Offline";
  useShellStatus(status, label, () => void query.refetch(), query.isFetching);

  const categories = useMemo(
    () => [...new Set((data?.holdings ?? []).map((h) => h.category))].sort((a, b) => a.localeCompare(b)),
    [data],
  );

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

  const groups = useMemo(() => groupHoldings(rows, groupBy), [rows, groupBy]);
  const phoneGroups = useMemo(() => groupHoldings(phoneRows, groupBy), [phoneRows, groupBy]);

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
        cell: (r) => formatNumber(toNum(r.shares), 4),
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
        cell: (r) => formatMoney(toNum(r.price_native), r.native_currency),
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
        cell: (r) => formatPercent(toNum(r.expense_ratio)),
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
      {
        key: "weight",
        header: "Weight",
        align: "right",
        sortValue: (r) => toNum(r.weight_pct),
        cell: (r) => formatPercent(toNum(r.weight_pct), { digits: 1 }),
      },
    ],
    [currency],
  );

  if (query.isError) {
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

  const s = data?.summary;
  return (
    <div className="holdings-page">
      <PageHeader
        title="Holdings"
        subtitle="Every position in full detail"
        actions={data ? <span className="holdings-page__muted">Updated {formatTime(data.as_of)}</span> : undefined}
      />

      <Card>
        {data ? (
          <dl className="holdings-page__summary" aria-label="Portfolio summary">
            <div>
              <dt>Total value</dt>
              <dd>
                <Money amount={toNum(data.total_value)} currency={currency} />
              </dd>
            </div>
            <div>
              <dt>Capital gain (excl. dividends)</dt>
              <dd>
                <Money amount={toNum(data.total_capital_gain)} currency={currency} signed colored />
              </dd>
            </div>
            <div>
              <dt>Total return (incl. dividends)</dt>
              <dd>
                <Money amount={toNum(data.total_return)} currency={currency} signed colored />
              </dd>
            </div>
            <div>
              <dt>In profit / in loss</dt>
              <dd>
                {s?.in_profit} / {s?.in_loss}
              </dd>
            </div>
            <div>
              <dt>Up / down today</dt>
              <dd>
                {s?.gainers} / {s?.losers}
              </dd>
            </div>
            <div>
              <dt>Best</dt>
              <dd>
                {s?.best_symbol ?? "–"} <Percent ratio={toNum(s?.best_growth)} signed colored />
              </dd>
            </div>
            <div>
              <dt>Worst</dt>
              <dd>
                {s?.worst_symbol ?? "–"} <Percent ratio={toNum(s?.worst_growth)} signed colored />
              </dd>
            </div>
            <div>
              <dt>Most concentrated</dt>
              <dd>
                {s?.most_concentrated_symbol ?? "–"}{" "}
                {formatPercent(toNum(s?.most_concentrated_weight_pct), { digits: 1 })}
              </dd>
            </div>
          </dl>
        ) : (
          <Skeleton height="3rem" />
        )}
      </Card>

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
          onValueChange={(v) => setGroupBy(v as GroupBy)}
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

      {isPhone ? (
        query.isPending ? (
          <Skeleton height="12rem" />
        ) : phoneRows.length === 0 ? (
          <EmptyState icon={<Search aria-hidden />} title="No matches" description="Try a different search or category." />
        ) : (
          phoneGroups.map((g) => (
            <section key={g.key} className="holdings-page__group">
              {groupBy !== "none" && (
                <>
                  <h2 className="holdings-page__group-title">{g.key}</h2>
                  <Subtotals group={g} ccy={currency} />
                </>
              )}
              <ul className="holdings-page__list">
                {g.rows.map((r) => (
                  <MobileRow key={r.instrument_id} row={r} ccy={currency} />
                ))}
              </ul>
            </section>
          ))
        )
      ) : groupBy === "none" ? (
        <DataTable
          caption="All holdings"
          columns={columns}
          rows={rows}
          rowKey={(r) => String(r.instrument_id)}
          defaultSort={{ key: "value", direction: "desc" }}
          loading={query.isPending}
          emptyMessage="No holdings match your filters."
        />
      ) : (
        groups.map((g) => (
          <Card key={g.key} title={g.key} subtitle={`${g.rows.length} position${g.rows.length === 1 ? "" : "s"}`} flush>
            <Subtotals group={g} ccy={currency} />
            <DataTable
              caption={`Holdings: ${g.key}`}
              columns={columns}
              rows={g.rows}
              rowKey={(r) => String(r.instrument_id)}
              defaultSort={{ key: "value", direction: "desc" }}
            />
          </Card>
        ))
      )}
      <HoldingDrawer row={selected} ccy={currency} onClose={() => setSelected(null)} />
    </div>
  );
}
