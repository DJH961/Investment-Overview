import { ArrowDown, ArrowRight, ArrowUp, Check, Coins, Minus } from "lucide-react";
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
import { useIsPhone } from "../../../../lib/useMediaQuery";
import { fractionTone, PCT_DIGITS, pctText, PP_DIGITS, spanOf, windowText } from "../../numbers";
import type { CurrencySectionComponentProps } from "../../sections";
import "./Conversions.scss";

const PROVIDER_LABEL: Record<string, string> = { wise: "Wise", revolut: "Revolut", other: "Other" };
const providerName = (p: string | null | undefined) => (p ? (PROVIDER_LABEL[p] ?? p) : "No provider");

const FIXING_TIP =
  "Measured against the ECB daily reference, which is struck at about 14:15 CET. A conversion done at another hour is compared with a rate it never saw, so a small negative cost is normal intraday noise, not a win.";

/** "−0.6%": a distance from the ECB reference, signed, the page's one digit (no good/bad color). */
const offText = (v: string | null | undefined) => pctText(toNum(v ?? null));

/** The server sends a cost as a positive amount; the page shows it as what it took from you. */
const asCost = (v: string | null | undefined) => {
  const n = toNum(v ?? null);
  return n === null ? null : -n;
};

/** A cost share, negative like the cost itself ("−0.4%"). */
const costPctText = (v: string | null | undefined) => pctText(asCost(v));

/** A cost: minus always means it cost you (orange); a rare plus is a conversion that beat the reference. */
function Cost({ value, ccy }: { value: string | null | undefined; ccy: FxCostsDto["currency"] }) {
  return <Money amount={asCost(value)} currency={ccy} signed colored digits={2} />;
}

/** The range's span in ms from the server window (the same dates in every section). */
function windowSpan(d: FxCostsDto): number | null {
  const w = d.window;
  if (!w) return null;
  const a = Date.parse(w.start);
  const b = Date.parse(w.through);
  return Number.isFinite(a) && Number.isFinite(b) && b > a ? b - a : null;
}

function stats(d: FxCostsDto): StatItem[] {
  const s = d.summary;
  const usd = d.currency === "USD";
  return [
    {
      key: "fees",
      label: "Fees paid",
      value: <Cost value={s.fees} ccy={d.currency} />,
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
      note: s.cost_pct !== null ? `${costPctText(s.cost_pct)} of converted` : undefined,
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
  const pct = formatPercent(Math.abs(avg), { digits: PCT_DIGITS });
  const flat = fractionTone(avg) === "flat";
  const Icon = flat ? Minus : avg > 0 ? ArrowUp : ArrowDown;
  const headline = flat
    ? "You converted at about the month average"
    : `You converted ${pct} ${avg > 0 ? "better" : "worse"} than the month average`;
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
  const phone = useIsPhone();
  const series = useMemo<ChartSeries[]>(
    () => [
      {
        id: "cost",
        label: d.currency === "USD" ? "Dollars not received, cumulative" : "Cumulative cost",
        // Down is cost, like every cost on the page.
        points: d.cumulative.map((p) => ({ t: p.date, v: asCost(p.cost) })),
        tone: "primary",
      },
    ],
    [d.cumulative, d.currency],
  );
  // The real span: the range's window when the server sends it, else the line's own.
  const span = windowSpan(d) ?? spanOf(d.cumulative.map((p) => Date.parse(p.date)));
  return (
    <Card
      title="Cost over time"
      subtitle="Cumulative fees plus spread, by conversion date, versus the ECB daily reference. Below zero is what it cost you."
    >
      {d.cumulative.length >= 2 ? (
        <Chart
          series={series}
          referenceLine={{ value: 0 }}
          valueFormat={chartMoneyFormat(d.currency, "axis")}
          timeFormat={(t) => formatAxisDate(t, span)}
          tooltipTimeFormat={(t) => formatDate(new Date(t), "medium")}
          height={phone ? 160 : 200}
          ariaLabel="Cumulative cost of converting"
          legendExtra="Steps down on the days you converted"
        />
      ) : (
        <p className="conv-section__muted">One conversion so far: a line needs at least two.</p>
      )}
    </Card>
  );
}

function YearsCard({ d }: { d: FxCostsDto }) {
  const phone = useIsPhone();
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
      sortValue: (r) => asCost(r.cost),
    },
    {
      key: "pct",
      header: "Cost %",
      align: "right",
      cell: (r) => costPctText(r.cost_pct),
      sortValue: (r) => asCost(r.cost_pct),
    },
  ];
  if (phone) {
    // One compact line per year, labels once on top: a mini table, no chips.
    return (
      <Card title="By year" className="conv-section__years">
        <table className="conv-section__mini">
          <caption className="u-sr-only">What converting cost, per year</caption>
          <thead>
            <tr className="conv-section__mini-row conv-section__mini-row--head">
              <th scope="col" className="conv-section__mini-cell">Year</th>
              <th scope="col" className="conv-section__mini-cell conv-section__mini-cell--num">Converted</th>
              <th scope="col" className="conv-section__mini-cell conv-section__mini-cell--num">Cost</th>
              <th scope="col" className="conv-section__mini-cell conv-section__mini-cell--num">%</th>
            </tr>
          </thead>
          <tbody>
            {d.by_year.map((r) => (
              <tr key={r.year} className="conv-section__mini-row">
                <th scope="row" className="conv-section__mini-cell">{r.year}</th>
                <td className="conv-section__mini-cell conv-section__mini-cell--num">
                  <Money amount={toNum(r.converted)} currency={ccy} digits={0} />
                </td>
                <td className="conv-section__mini-cell conv-section__mini-cell--num">
                  <Cost value={r.cost} ccy={ccy} />
                </td>
                <td className="conv-section__mini-cell conv-section__mini-cell--num">{costPctText(r.cost_pct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    );
  }
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

/**
 * Providers side by side (the owner will mostly use two): a column each with what it
 * converted, what that cost and the distance from the ECB. The cheaper one carries a word
 * and an icon, never color alone. One provider is a single summary line.
 */
function ProvidersCard({ d }: { d: FxCostsDto }) {
  const ccy = d.currency;
  const named = d.by_provider.filter((p): p is FxCostProviderDto & { provider: NonNullable<FxCostProviderDto["provider"]> } => p.provider !== null);
  const unnamed = d.by_provider.find((p) => p.provider === null);
  const gap = toNum(d.cheaper_gap_pct);
  const compare = named.length >= 2;
  const lead: ReactNode =
    compare && d.cheaper_provider && d.cheaper_than && gap !== null ? (
      <>
        {providerName(d.cheaper_provider)} is cheaper than {providerName(d.cheaper_than)} by{" "}
        {formatNumber(Math.abs(gap) * 100, PP_DIGITS)} pp of what you converted.
      </>
    ) : named.length === 1 ? (
      "Compare once you use a second provider."
    ) : (
      "Add a provider to your conversions to compare them."
    );
  return (
    <Card title="Cost per provider" subtitle={lead} className="conv-section__providers">
      {named.length === 0 ? null : (
        <div className="conv-section__compare">
          {named.map((p) => {
            const cheaper = compare && p.provider === d.cheaper_provider;
            return (
              <section key={p.provider} className="conv-section__prov" aria-label={providerName(p.provider)}>
                <h4 className="conv-section__prov-name">
                  {providerName(p.provider)}
                  {cheaper ? (
                    <span className="conv-section__prov-flag">
                      <Check aria-hidden className="conv-section__prov-flag-icon" />
                      Cheaper
                    </span>
                  ) : null}
                </h4>
                <dl className="conv-section__prov-list">
                  <div className="conv-section__prov-row">
                    <dt className="conv-section__prov-label">Converted</dt>
                    <dd className="conv-section__prov-value">
                      <Money amount={toNum(p.converted)} currency={ccy} digits={0} />
                    </dd>
                  </div>
                  <div className="conv-section__prov-row">
                    <dt className="conv-section__prov-label">Cost</dt>
                    <dd className="conv-section__prov-value">
                      <Cost value={p.cost} ccy={ccy} />
                    </dd>
                  </div>
                  <div className="conv-section__prov-row">
                    <dt className="conv-section__prov-label">Cost %</dt>
                    <dd className="conv-section__prov-value">{costPctText(p.cost_pct)}</dd>
                  </div>
                  <div className="conv-section__prov-row">
                    <dt className="conv-section__prov-label">vs ECB</dt>
                    <dd className="conv-section__prov-value">{offText(p.avg_off_pct)}</dd>
                  </div>
                </dl>
              </section>
            );
          })}
        </div>
      )}
      {unnamed ? (
        <p className="conv-section__muted">
          {unnamed.count} {unnamed.count === 1 ? "conversion has" : "conversions have"} no provider and{" "}
          {unnamed.count === 1 ? "is" : "are"} not compared.
        </p>
      ) : null}
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
      meta={d ? (windowText(d.window, range) ?? undefined) : undefined}
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
