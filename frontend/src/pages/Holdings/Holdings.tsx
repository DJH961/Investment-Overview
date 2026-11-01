import { ChevronDown, Inbox, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Card } from "../../components/Card";
import { type Column, DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { Input } from "../../components/Input";
import { Money } from "../../components/Money";
import { PageHeader } from "../../components/PageHeader";
import { Percent } from "../../components/Percent";
import { Select } from "../../components/Select";
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
        <dl id={detailId} className="holdings-page__detail">
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

  const columns: Column<HoldingRowDto>[] = useMemo(
    () => [
      {
        key: "symbol",
        header: "Symbol",
        primary: true,
        sortValue: (r) => r.symbol,
        cell: (r) => (
          <span className="holdings-page__symbol">
            <strong>{r.symbol}</strong>
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
          <ul className="holdings-page__list">
            {phoneRows.map((r) => (
              <MobileRow key={r.instrument_id} row={r} ccy={currency} />
            ))}
          </ul>
        )
      ) : (
        <DataTable
          caption="All holdings"
          columns={columns}
          rows={rows}
          rowKey={(r) => String(r.instrument_id)}
          defaultSort={{ key: "value", direction: "desc" }}
          loading={query.isPending}
          emptyMessage="No holdings match your filters."
        />
      )}
    </div>
  );
}
