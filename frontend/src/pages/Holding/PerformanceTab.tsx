import { useMemo, useState } from "react";
import { Chart, isReferenceInSoftBounds, type ChartMarker, type ChartSeries } from "../../components/Chart";
import { hasSplit, HoldingDaySplit } from "../../components/DaySplit";
import { holdingPriceTime, PriceStamps, useScreenPhase } from "../../components/Freshness";
import { KpiTile } from "../../components/KpiTile";
import { Money } from "../../components/Money";
import { Percent } from "../../components/Percent";
import { SegmentedControl } from "../../components/SegmentedControl";
import { useDisplayPrefs } from "../../lib/displayPrefs";
import { useIsPhone } from "../../lib/useMediaQuery";
import { chartMoneyFormat, formatMoney, formatQuantity } from "../../lib/format";
import type { ReportingCurrency } from "../../lib/prefs";
import {
  HOLDING_RANGES,
  type HistoryMode,
  type HoldingHistoryV2Dto,
  type HoldingRange,
  NAV_RANGES,
  useHoldingHistoryV2,
} from "../../lib/queries/holding-detail";
import type { HoldingRowDto } from "../../lib/queries/holdings";
import { toNum } from "../../lib/queries/portfolio";
import { formatQuantity as formatShares } from "../Transactions/numbers";
import { axisFormat, chartSessions, chartXMode, rangeLabel, tooltipFormat } from "./holdingFormat";

/** Whether this holding has an intraday price at all (NAV funds publish once a day). */
export const isNavFund = (row: HoldingRowDto): boolean => row.price_type === "nav" || row.is_money_market;

export function rangesFor(row: HoldingRowDto): HoldingRange[] {
  return isNavFund(row) ? NAV_RANGES : HOLDING_RANGES;
}

/** Nearest point at or before `t` (the trade marker sits on the value line). */
function valueAt(points: { x: number; v: number | null }[], t: number): number | null {
  let best: number | null = null;
  for (const p of points) {
    if (p.x > t) break;
    if (p.v !== null) best = p.v;
  }
  return best ?? points.find((p) => p.v !== null)?.v ?? null;
}

function buildSeries(
  data: HoldingHistoryV2Dto | undefined,
  mode: HistoryMode,
  ccy: ReportingCurrency,
  symbol: string,
): { series: ChartSeries[]; markers: ChartMarker[] } {
  if (!data) return { series: [], markers: [] };
  const pts = [...data.points].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const native = data.ccy;
  if (mode === "price") {
    const line = pts.map((p) => ({ t: p.t, v: toNum(p.v) }));
    const markers: ChartMarker[] = (data.trades ?? []).flatMap((tr) => {
      const v = toNum(tr.price_native);
      if (v === null) return [];
      const q = toNum(tr.quantity);
      return [
        {
          t: tr.t,
          v,
          shape: tr.kind,
          label: `${tr.kind === "buy" ? "Bought" : "Sold"} ${q === null ? "" : `${formatQuantity(Math.abs(q), 0)} sh `}at ${formatMoney(v, native, { unmasked: true })}`,
        },
      ];
    });
    return { series: [{ id: "price", label: `${symbol} price`, points: line, tone: "primary" }], markers };
  }
  const pick = (p: (typeof pts)[number]) => toNum(ccy === "EUR" ? (p.value_eur ?? null) : (p.value_usd ?? null));
  const invested = (p: (typeof pts)[number]) =>
    toNum(ccy === "EUR" ? (p.invested_eur ?? null) : (p.invested_usd ?? null));
  const value = pts.map((p) => ({ t: p.t, v: pick(p) }));
  const timed = value.map((p) => ({ x: Date.parse(p.t), v: p.v }));
  const markers: ChartMarker[] = (data.trades ?? []).flatMap((tr) => {
    const at = Date.parse(tr.t);
    const v = valueAt(timed, at);
    if (v === null) return [];
    const q = toNum(tr.quantity);
    const price = toNum(tr.price_native);
    return [
      {
        t: tr.t,
        v,
        shape: tr.kind,
        label: `${tr.kind === "buy" ? "Bought" : "Sold"} ${q === null ? "" : `${formatQuantity(Math.abs(q), 0)} sh `}at ${formatMoney(price, native, { unmasked: true })}`,
      },
    ];
  });
  return {
    series: [
      { id: "value", label: "Value", points: value, tone: "primary" },
      { id: "invested", label: "Invested", points: pts.map((p) => ({ t: p.t, v: invested(p) })), tone: "invested" },
    ],
    markers,
  };
}

/** "This range: +€121k +13.9% · bought €14.8k · dividends €3.2k" (all server figures). */
function RangeSummary({ data, ccy }: { data: HoldingHistoryV2Dto | undefined; ccy: ReportingCurrency }) {
  const p = data?.period;
  if (!p) return null;
  const e = ccy === "EUR";
  const change = toNum(e ? p.change_eur : p.change_usd);
  const ret = toNum(e ? p.return_eur : p.return_usd);
  const bought = toNum(e ? p.bought_eur : p.bought_usd);
  const divs = toNum(e ? p.dividends_eur : p.dividends_usd);
  return (
    <p className="holding-page__range-summary">
      <span className="holding-page__muted">This range:</span> <Money amount={change} currency={ccy} signed colored compact />{" "}
      <Percent ratio={ret} signed colored />
      {bought !== null && bought !== 0 && (
        <>
          <span className="holding-page__muted"> · {bought > 0 ? "bought" : "sold"} </span>
          <Money amount={Math.abs(bought)} currency={ccy} compact />
        </>
      )}
      {divs !== null && divs !== 0 && (
        <>
          <span className="holding-page__muted"> · dividends </span>
          <Money amount={divs} currency={ccy} compact />
        </>
      )}
    </p>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="holding-page__fact">
      <dt className="holding-page__fact-key">{label}</dt>
      <dd className="holding-page__fact-value">{children}</dd>
    </div>
  );
}

export function KeyFacts({ row, ccy }: { row: HoldingRowDto; ccy: ReportingCurrency }) {
  const native = row.native_currency;
  return (
    <section className="holding-page__section" aria-labelledby="holding-facts">
      <h2 id="holding-facts" className="holding-page__section-title">
        Key facts
      </h2>
      <dl className="holding-page__facts">
        <Fact label="Shares">{formatShares(row.shares)}</Fact>
        <Fact label="Avg → now">
          {formatMoney(toNum(row.avg_price_native), native)} → {formatMoney(toNum(row.price_native), native, { unmasked: true })}
        </Fact>
        <Fact label="Price as of">
          <PriceStamps price={holdingPriceTime(row)} updated={null} terse />
        </Fact>
        <Fact label="Cost basis">
          <Money amount={toNum(row.cost_basis)} currency={ccy} />
        </Fact>
        <Fact label="Weight">
          <Percent ratio={toNum(row.weight_pct)} digits={1} />
        </Fact>
        <Fact label="Expense">
          <Percent ratio={toNum(row.expense_ratio)} />
        </Fact>
        <Fact label="MTD">
          <Percent ratio={toNum(row.mtd_growth)} signed colored />
        </Fact>
        <Fact label="YTD">
          <Percent ratio={toNum(row.ytd_growth)} signed colored />
        </Fact>
        <Fact label="Growth">
          <Percent ratio={toNum(row.total_growth)} signed colored />
        </Fact>
      </dl>
    </section>
  );
}

export function HoldingKpis({ row, ccy }: { row: HoldingRowDto; ccy: ReportingCurrency }) {
  const stale = row.daily_is_stale;
  const day = useScreenPhase();
  return (
    <div className="holding-page__kpis">
      <KpiTile
        label="Unrealized gain"
        value={<Money amount={toNum(row.capital_gain)} currency={ccy} signed colored />}
        hint={
          <>
            on cost <Money amount={toNum(row.cost_basis)} currency={ccy} />
          </>
        }
      />
      <KpiTile
        label="Total return"
        value={<Money amount={toNum(row.total_return)} currency={ccy} signed colored />}
        hint={
          <>
            <Percent ratio={toNum(row.total_growth)} signed /> · incl. <Money amount={toNum(row.dividends)} currency={ccy} compact />{" "}
            dividends
          </>
        }
      />
      <KpiTile
        label="XIRR"
        value={<Percent ratio={toNum(row.xirr)} signed colored />}
        hint="a year, money-weighted"
        tooltip="The holding's annualized return, weighting each buy and sell by when it happened."
      />
      <KpiTile
        label={day.label}
        value={<Money amount={toNum(row.today_move)} currency={ccy} signed colored={!stale} />}
        hint={
          <span className="holding-page__today-hint">
            <Percent ratio={toNum(row.today_pct)} signed colored={!stale} />
            {!stale && hasSplit(row, ccy) && <HoldingDaySplit row={row} currency={ccy} marketOpen={row.market_open} />}
          </span>
        }
      />
    </div>
  );
}

export function PerformanceChart({ row, ccy }: { row: HoldingRowDto; ccy: ReportingCurrency }) {
  const ranges = rangesFor(row);
  const { holdingsRange, holdingChartCostScale } = useDisplayPrefs();
  const pref = holdingsRange as HoldingRange;
  const [range, setRange] = useState<HoldingRange>(() => (ranges.includes(pref) ? pref : "1y"));
  const [mode, setMode] = useState<HistoryMode>("value");
  const safeRange = ranges.includes(range) ? range : "1y";
  const history = useHoldingHistoryV2(row.instrument_id, safeRange, mode);
  const { series, markers } = useMemo(
    () => buildSeries(history.data, mode, ccy, row.symbol),
    [history.data, mode, ccy, row.symbol],
  );
  const [investedOverride, setInvestedOverride] = useState<{ key: string; visible: boolean } | null>(null);
  const autoHideInvested = useMemo(() => {
    if (mode !== "value" || holdingChartCostScale === "always") return false;
    const valPts = (series.find((s) => s.id === "value")?.points ?? [])
      .map((p) => p.v)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    const invPts = (series.find((s) => s.id === "invested")?.points ?? [])
      .map((p) => p.v)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    if (!valPts.length || !invPts.length) return false;
    const valLo = Math.min(...valPts);
    const valHi = Math.max(...valPts);
    const invLo = Math.min(...invPts);
    const invHi = Math.max(...invPts);
    if (holdingChartCostScale === "never") return invLo < valLo || invHi > valHi;
    return !isReferenceInSoftBounds(invLo, valLo, valHi) || !isReferenceInSoftBounds(invHi, valLo, valHi);
  }, [mode, series, holdingChartCostScale]);
  const overrideKey = `${row.instrument_id}|${safeRange}|${holdingChartCostScale}`;
  const activeOverride = investedOverride && investedOverride.key === overrideKey ? investedOverride.visible : null;
  const hideInvested = activeOverride !== null ? !activeOverride : autoHideInvested;
  const chartSeries = useMemo(
    () =>
      mode === "value"
        ? series.map((s) => (s.id === "invested" ? { ...s, hidden: hideInvested } : s))
        : series,
    [mode, series, hideInvested],
  );
  const native = history.data?.ccy ?? row.native_currency;
  const avg = toNum(history.data?.avg_price_native ?? row.avg_price_native);
  const priceSoftBounds: boolean | "strict" =
    holdingChartCostScale === "always" ? false : holdingChartCostScale === "never" ? "strict" : true;
  const xMode = history.data?.x_mode;
  const sessions = chartSessions(history.data?.sessions);
  const isPhone = useIsPhone();
  const modeSwitch = (
    <SegmentedControl<HistoryMode>
      ariaLabel="Chart shows"
      size="sm"
      options={[
        { value: "value", label: "Value" },
        { value: "price", label: "Price" },
      ]}
      value={mode}
      onChange={setMode}
    />
  );
  return (
    <section className="holding-page__section holding-page__chart" aria-label="Performance chart">
      <Chart
        series={chartSeries}
        markers={markers}
        referenceLine={
          mode === "price" && avg !== null
            ? {
                value: avg,
                label: "Avg cost",
                softBounds: priceSoftBounds,
                formattedValue: formatMoney(avg, native, { unmasked: true }),
              }
            : undefined
        }
        range={safeRange}
        ranges={ranges}
        rangeLabel={rangeLabel}
        onRangeChange={(r) => {
          setRange(r as HoldingRange);
          setInvestedOverride(null);
        }}
        onToggleSeries={
          mode === "value"
            ? (id) => {
                if (id === "invested") setInvestedOverride({ key: overrideKey, visible: hideInvested });
              }
            : undefined
        }
        headerExtra={isPhone ? undefined : modeSwitch}
        // Phone: the switch sits at the end of the legend row (legend left, switch right).
        legendExtra={isPhone ? modeSwitch : undefined}
        xMode={chartXMode(xMode, sessions)}
        sessions={sessions}
        loading={history.isPending}
        busy={history.isFetching && !history.isPending}
        valueFormat={(v, step) =>
          mode === "price" ? formatMoney(v, native, { unmasked: true }) : chartMoneyFormat(ccy, "axis")(v, step)
        }
        timeFormat={axisFormat(safeRange, xMode)}
        tooltipTimeFormat={tooltipFormat(safeRange, xMode)}
        height={240}
        ariaLabel={mode === "price" ? `${row.symbol} price against average cost` : `${row.symbol} value against money invested`}
        emptyMessage={
          history.isError
            ? "Could not load the history."
            : safeRange === "1d" || safeRange === "1w"
              ? "No intraday prices stored yet."
              : "No history for this range yet."
        }
      />
      <div className="holding-page__range-row">
        <RangeSummary data={history.data} ccy={ccy} />
      </div>
      {isNavFund(row) && !row.twin && (
        <p className="holding-page__note">No intraday price for this fund: it publishes one NAV a day.</p>
      )}
    </section>
  );
}

export function PerformanceTab({ row, ccy }: { row: HoldingRowDto; ccy: ReportingCurrency }) {
  return (
    <div className="holding-page__panel holding-page__panel--performance">
      <HoldingKpis row={row} ccy={ccy} />
      <PerformanceChart row={row} ccy={ccy} />
      <KeyFacts row={row} ccy={ccy} />
    </div>
  );
}
