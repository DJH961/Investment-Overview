import { ArrowDown, ArrowRight, ArrowUp, Coins, Minus } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Link } from "react-router";
import { Card } from "../../../../components/Card";
import { Chart, type ChartSeries } from "../../../../components/Chart";
import { CurrencySection } from "../../../../components/CurrencySection";
import { DataTable, type Column } from "../../../../components/DataTable";
import { InfoTip } from "../../../../components/InfoTip";
import { Money } from "../../../../components/Money";
import type { StatItem } from "../../../../components/StatStrip";
import { chartMoneyFormat, formatAxisDate, formatDate, formatNumber, formatPercent } from "../../../../lib/format";
import {
  useFxCosts,
  type FxCostProviderDto,
  type FxCostsDto,
  type FxCostYearDto,
} from "../../../../lib/queries/fxCosts";
import { toNum } from "../../../../lib/queries/portfolio";
import type { CurrencySectionComponentProps } from "../../sections";
import "./Conversions.scss";

const PROVIDER_LABEL: Record<string, string> = { wise: "Wise", revolut: "Revolut", other: "Other" };
const providerName = (p: string | null | undefined) => (p ? (PROVIDER_LABEL[p] ?? p) : "No provider");

const FIXING_TIP =
  "Measured against the ECB daily reference, which is struck at about 14:15 CET. A conversion done at another hour is compared with a rate it never saw, so a small negative cost is normal intraday noise, not a win.";

/** "−0.56 %": a distance from the ECB reference as a plain signed number (no good/bad colour). */
const offText = (v: string | null | undefined) => {
  const n = toNum(v ?? null);
  if (n === null) return "–";
  const pct = n * 100;
  if (Math.abs(pct) < 0.005) return "0.00 %";
  return `${pct < 0 ? "−" : "+"}${formatNumber(Math.abs(pct), 2)} %`;
};

const pctText = (v: string | null | undefined) => formatPercent(toNum(v ?? null), { digits: 2 });

function Cost({ value, ccy }: { value: string | null | undefined; ccy: FxCostsDto["currency"] }) {
  // Signed plain text on purpose: for a cost, "up" is bad, so no gain/loss colour.
  return <Money amount={toNum(value ?? null)} currency={ccy} signed digits={2} />;
}

function stats(d: FxCostsDto): StatItem[] {
  const s = d.summary;
  const usd = d.currency === "USD";
  return [
    {
      key: "fees",
      label: "Fees paid",
      value: <Money amount={toNum(s.fees)} currency={d.currency} digits={2} />,
      note: `on ${s.count} ${s.count === 1 ? "conversion" : "conversions"}`,
    },
    {
      key: "spread",
      label: "Spread",
      value: <Cost value={s.spread} ccy={d.currency} />,
      note: usd ? "dollars not received" : "paid over the reference",
      tip: `What the rate itself cost you against the ECB daily reference, fees left out. ${FIXING_TIP}`,
    },
    {
      key: "cost",
      label: "Total cost",
      value: <Cost value={s.cost} ccy={d.currency} />,
      note: s.cost_pct !== null ? `${pctText(s.cost_pct)} of what you converted` : undefined,
      tip: `Fees plus spread. ${FIXING_TIP}`,
    },
    {
      key: "avg",
      label: "Average vs ECB",
      value: offText(s.avg_off_pct),
      note: "weighted by amount",
      tip: "All-in rate (fees included) against the ECB daily reference, averaged with each conversion weighted by the euros it converted, not a plain mean of percentages. Negative: fewer dollars per euro than the reference.",
    },
    {
      key: "bestworst",
      label: "Best / worst",
      value: `${offText(d.best?.off_pct)} · ${offText(d.worst?.off_pct)}`,
      note: d.best && d.worst ? `${formatDate(d.best.date)} · ${formatDate(d.worst.date)}` : undefined,
      tip: "The best and the worst conversion, as the all-in distance from the ECB daily reference.",
    },
  ];
}

function TimingCard({ d }: { d: FxCostsDto }) {
  const t = d.timing;
  const avg = toNum(t.avg_pct);
  if (t.count === 0 || avg === null) return null;
  const pct = formatNumber(Math.abs(avg) * 100, 1);
  const flat = Math.abs(avg) * 100 < 0.05;
  const Icon = flat ? Minus : avg > 0 ? ArrowUp : ArrowDown;
  const headline = flat
    ? "You converted at about the month average"
    : `You converted ${pct} % ${avg > 0 ? "better" : "worse"} than the month average`;
  return (
    <Card
      className="conv-section__timing"
      title={
        <span className="conv-section__title">
          Timing
          <InfoTip
            label="Timing"
            content="Your rate (fees left out) against the mean of the ECB daily fixings of the calendar month you converted in, weighted by the euros converted. A month still running is averaged so far. It shows luck of the day, not skill, and says nothing about the future."
          />
        </span>
      }
    >
      <p className="conv-section__timing-line">
        <Icon aria-hidden className="conv-section__timing-icon" />
        <span className="conv-section__timing-text">{headline}</span>
      </p>
      <p className="conv-section__muted">
        {t.better} better · {t.worse} worse
        {t.so_far > 0 ? ` · ${t.so_far} in the running month, compared so far` : ""}
      </p>
    </Card>
  );
}

function CumulativeCard({ d }: { d: FxCostsDto }) {
  const series = useMemo<ChartSeries[]>(
    () => [
      {
        id: "cost",
        label: d.currency === "USD" ? "Dollars not received, cumulative" : "Cumulative cost",
        points: d.cumulative.map((p) => ({ t: p.date, v: toNum(p.cost) })),
        tone: "primary",
      },
    ],
    [d.cumulative, d.currency],
  );
  return (
    <Card
      title="Cost over time"
      subtitle="Cumulative fees plus spread, by conversion date, versus the ECB daily reference."
    >
      {d.cumulative.length >= 2 ? (
        <Chart
          series={series}
          referenceLine={{ value: 0 }}
          valueFormat={chartMoneyFormat(d.currency, "axis")}
          timeFormat={(t) => formatAxisDate(t, Infinity)}
          tooltipTimeFormat={(t) => formatDate(new Date(t), "medium")}
          height={200}
          ariaLabel="Cumulative cost of converting"
        />
      ) : (
        <p className="conv-section__muted">One conversion so far: a line needs at least two.</p>
      )}
    </Card>
  );
}

function YearsCard({ d }: { d: FxCostsDto }) {
  const ccy = d.currency;
  const columns: Column<FxCostYearDto>[] = [
    { key: "year", header: "Year", primary: true, cell: (r) => r.year, sortValue: (r) => r.year },
    {
      key: "converted",
      header: "Converted",
      align: "right",
      phone: "sub",
      cell: (r) => <Money amount={toNum(r.converted)} currency={ccy} digits={0} />,
      sortValue: (r) => toNum(r.converted),
    },
    {
      key: "cost",
      header: "Cost",
      align: "right",
      phone: "headline",
      emphasis: true,
      cell: (r) => <Cost value={r.cost} ccy={ccy} />,
      sortValue: (r) => toNum(r.cost),
    },
    {
      key: "pct",
      header: "Cost %",
      align: "right",
      cell: (r) => pctText(r.cost_pct),
      sortValue: (r) => toNum(r.cost_pct),
    },
  ];
  return (
    <Card title="By year" flush>
      <DataTable
        caption="What converting cost, per year"
        columns={columns}
        rows={d.by_year}
        rowKey={(r) => String(r.year)}
        defaultSort={{ key: "year", direction: "desc" }}
      />
    </Card>
  );
}

function ProvidersCard({ d }: { d: FxCostsDto }) {
  const ccy = d.currency;
  const gap = toNum(d.cheaper_gap_pct);
  const sentence: ReactNode =
    d.cheaper_provider && gap !== null ? (
      <>
        <strong>{providerName(d.cheaper_provider)}</strong> has been cheaper for you:{" "}
        {formatNumber(gap * 100, 2)} percentage points less of what you converted went on fees and spread.
      </>
    ) : (
      "Add a provider to your conversions to compare them. Two are needed to say which is cheaper."
    );
  const columns: Column<FxCostProviderDto>[] = [
    {
      key: "provider",
      header: "Provider",
      primary: true,
      cell: (r) => providerName(r.provider),
      sortValue: (r) => providerName(r.provider),
    },
    {
      key: "count",
      header: "Conv.",
      align: "right",
      phone: "sub",
      cell: (r) => r.count,
      sortValue: (r) => r.count,
    },
    {
      key: "cost",
      header: "Cost",
      align: "right",
      phone: "headline",
      emphasis: true,
      cell: (r) => <Cost value={r.cost} ccy={ccy} />,
      sortValue: (r) => toNum(r.cost),
    },
    {
      key: "pct",
      header: "Cost %",
      align: "right",
      cell: (r) => pctText(r.cost_pct),
      sortValue: (r) => toNum(r.cost_pct),
    },
    {
      key: "avg",
      header: "vs ECB",
      align: "right",
      cell: (r) => offText(r.avg_off_pct),
      sortValue: (r) => toNum(r.avg_off_pct),
    },
  ];
  return (
    <Card title="Cost per provider" subtitle={sentence} flush>
      <DataTable
        caption="What converting cost, per provider"
        columns={columns}
        rows={d.by_provider}
        rowKey={(r) => r.provider ?? "none"}
      />
    </Card>
  );
}

/** What converting costs you: fees and spread against the ECB daily reference (7.3). */
export function Conversions({ id, label, currency, range }: CurrencySectionComponentProps) {
  const q = useFxCosts(currency, range);
  const d = q.data;
  const state = q.isError && !d ? "error" : !d ? "loading" : d.rows.length === 0 ? "empty" : "ready";
  return (
    <CurrencySection
      id={id}
      title={label}
      explainer={
        currency === "USD"
          ? "The dollars you did not get when you converted, versus the ECB daily reference."
          : "What your EUR to USD conversions cost, versus the ECB daily reference: fees plus the rate you were given."
      }
      stats={d ? stats(d) : undefined}
      state={state}
      onRetry={() => void q.refetch()}
      busy={q.isFetching && !q.isPending}
      emptyIcon={<Coins aria-hidden />}
      emptyTitle="No conversions in this range"
      emptyDescription="Add the conversions you made on the Conversions page and what they cost shows up here."
      skeleton={["6rem", "14rem", "12rem"]}
      className="conv-section"
    >
      {d ? (
        <>
          <TimingCard d={d} />
          <CumulativeCard d={d} />
          <div className="conv-section__pair">
            <YearsCard d={d} />
            <ProvidersCard d={d} />
          </div>
          {d.unpriced > 0 ? (
            <p className="conv-section__muted">
              {d.unpriced} {d.unpriced === 1 ? "conversion has" : "conversions have"} no ECB fixing close enough to compare with
              and {d.unpriced === 1 ? "is" : "are"} left out of these figures.
            </p>
          ) : null}
          <p className="conv-section__more">
            <Link to="/conversions" className="conv-section__link">
              All conversions, with the cost of each
              <ArrowRight aria-hidden className="conv-section__link-icon" />
            </Link>
          </p>
        </>
      ) : null}
    </CurrencySection>
  );
}
