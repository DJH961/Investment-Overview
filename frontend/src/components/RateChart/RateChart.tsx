import clsx from "clsx";
import { ArrowDownRight, ArrowUpRight, Minus, MoveRight, TrendingDown, TrendingUp } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Card } from "../Card";
import { Chart, type ChartSeries } from "../Chart";
import { InfoTip } from "../InfoTip";
import { formatAxisDate, formatDate, formatDayTime, formatNumber, formatPercent, formatShortDay, formatTime } from "../../lib/format";
import { toNum } from "../../lib/queries/portfolio";
import {
  RATE_RANGE_LABELS,
  RATE_RANGES,
  useRateHistory,
  type RateHistoryDto,
  type RatePointDto,
  type RateRange,
} from "../../lib/queries/currencyRate";
import type { ReportingCurrency } from "../../lib/prefs";
import { useTimeZone } from "../../lib/timezone";
import { usePersistentState } from "../../lib/usePersistentState";
import "./RateChart.scss";

/**
 * The quote follows the reporting currency, like the Today card (`today.pair`): the
 * other currency priced in yours. EUR view: USD/EUR, one dollar in euros (up = your
 * dollars are worth more). USD view: EUR/USD, one euro in dollars.
 */
export type RateLens = "rate" | "dollar";
export const lensFor = (ccy: ReportingCurrency): RateLens => (ccy === "EUR" ? "dollar" : "rate");

const isRange = (v: unknown): v is RateRange => RATE_RANGES.includes(v as RateRange);

const pick = (p: RatePointDto | null | undefined, lens: RateLens) =>
  p ? toNum(lens === "rate" ? p.rate : p.inverse) : null;

const fmt = (v: number | null, lens: RateLens) =>
  v === null ? "–" : lens === "rate" ? `$${formatNumber(v, 4)}` : `€${formatNumber(v, 4)}`;

const pct = (v: number | null) => (v === null ? "–" : formatPercent(v, { signed: true, digits: 1 }));

const DIRECTION = {
  dollar_up: { word: "Strengthening", Icon: TrendingUp },
  dollar_down: { word: "Weakening", Icon: TrendingDown },
  sideways: { word: "Sideways", Icon: MoveRight },
} as const;

const NORMAL_WORD = { normal: "normal month", large: "larger month than usual", unusual: "unusual month" } as const;

type Kind = "tailwind" | "headwind" | "neutral";
const KIND_ICON = { tailwind: ArrowUpRight, headwind: ArrowDownRight, neutral: Minus } as const;
const kindOf = (v: number | null): Kind => (v === null || Math.abs(v) < 0.0005 ? "neutral" : v > 0 ? "tailwind" : "headwind");

function KindWord({ kind, words }: { kind: Kind; words: Record<Kind, string> }) {
  const Icon = KIND_ICON[kind];
  return (
    <span className={`rate-chart__kind rate-chart__kind--${kind}`}>
      <Icon aria-hidden className="rate-chart__kind-icon" />
      {words[kind]}
    </span>
  );
}

/** One figure under the chart: label, figure, one quiet note. All four share this shape. */
function Figure({ label, tip, value, note }: { label: string; tip: ReactNode; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="rate-chart__fig">
      <dt className="rate-chart__fig-label">
        {label}
        <InfoTip label={label} content={tip} />
      </dt>
      <dd className="rate-chart__fig-value">{value}</dd>
      {note ? <dd className="rate-chart__fig-note">{note}</dd> : null}
    </div>
  );
}

function Figures({ data, lens }: { data: RateHistoryDto; lens: RateLens }) {
  const holdings = toNum(data.change?.inverse_pct);
  const next = toNum(data.change?.rate_pct);
  const trend = data.trend;
  const dir = trend ? DIRECTION[trend.direction] : null;
  // Low and high of the quote shown (in USD/EUR the dollar's low is EUR/USD's high).
  const lo = lens === "rate" ? data.low : data.high;
  const hi = lens === "rate" ? data.high : data.low;
  const day = (p: RatePointDto | null) => (p ? formatDate(p.t.slice(0, 10)) : "–");
  return (
    <dl className="rate-chart__figs">
      <Figure
        label="Low – high"
        tip={`The lowest and highest rate in this range: ${day(lo)} and ${day(hi)}.`}
        value={`${fmt(pick(lo, lens), lens)} – ${fmt(pick(hi, lens), lens).replace(/^[$€]/, "")}`}
      />
      <Figure
        label="Dollars you hold"
        tip="What the rate move alone did to the euro value of a dollar held through this range. Up is good for what you own."
        value={pct(holdings)}
        note={<KindWord kind={kindOf(holdings)} words={{ tailwind: "Tailwind", headwind: "Headwind", neutral: "Flat" }} />}
      />
      <Figure
        label="Euros you convert"
        tip="How many more or fewer dollars one euro buys than at the start of this range. Up is good for what you invest next."
        value={pct(next)}
        note={<KindWord kind={kindOf(next)} words={{ tailwind: "Buys more", headwind: "Buys less", neutral: "Flat" }} />}
      />
      {trend && dir ? (
        <Figure
          label="Dollar trend"
          tip={
            <>
              Exchange rates have no built-in upward drift: they wander both ways, and that is normal. This compares the
              dollar with its 200-day average
              {trend.since && trend.since_change_pct ? ` (this direction since ${formatDate(trend.since)}: ${pct(toNum(trend.since_change_pct))})` : ""}
              , and this month&apos;s move ({pct(toNum(trend.move_pct))}) with a typical month (±
              {formatPercent(toNum(trend.typical_move_pct), { digits: 1 })}). It describes; it does not predict.
            </>
          }
          value={
            <span className="rate-chart__trend">
              <dir.Icon aria-hidden className="rate-chart__trend-icon" />
              {dir.word}
            </span>
          }
          note={`${trend.since ? `since ${formatDate(trend.since)} · ` : ""}${NORMAL_WORD[trend.normal]}`}
        />
      ) : null}
    </dl>
  );
}

/**
 * The Currency page's first visual: the exchange rate over a chosen range, quoted like
 * the Today card, with your average rate and the 200-day average. Direction means
 * different things for dollars held and euros still to convert, so the line is never
 * coloured good or bad; the figures below give both readings.
 */
export function RateChart({ currency, className }: { currency: ReportingCurrency; className?: string }) {
  const timeZone = useTimeZone();
  const [range, setRange] = usePersistentState<RateRange>("currency.rate.range", "1y", isRange);
  const lens = lensFor(currency);
  const pair = lens === "rate" ? "EUR/USD" : "USD/EUR";
  const q = useRateHistory(range);
  const data = q.data;
  const shown: RateRange = data?.range ?? range;

  const series = useMemo<ChartSeries[]>(() => {
    if (!data) return [];
    const toPts = (pts: RatePointDto[]) => pts.map((p) => ({ t: p.t, v: pick(p, lens) }));
    const out: ChartSeries[] = [{ id: "rate", label: pair, points: toPts(data.points), tone: "primary" }];
    if (data.ma200.length) out.push({ id: "ma200", label: "200-day average", points: toPts(data.ma200), tone: "benchmark" });
    return out;
  }, [data, lens, pair]);

  const avg = data?.avg_rate ? toNum(lens === "rate" ? data.avg_rate.rate : data.avg_rate.inverse) : null;
  const last = data?.points.length ? pick(data.points[data.points.length - 1], lens) : null;
  const change = toNum(lens === "rate" ? data?.change?.rate_pct : data?.change?.inverse_pct);
  const rangeLabel = shown === "max" ? "since 1999" : RATE_RANGE_LABELS[shown];
  const long = shown === "1y" || shown === "5y" || shown === "10y" || shown === "max";

  const timeFormat = (t: number) =>
    shown === "1d" ? formatTime(new Date(t), timeZone) : shown === "1w" ? formatShortDay(t, timeZone) : formatAxisDate(t, long ? Infinity : 0);
  const tooltipTimeFormat = (t: number) =>
    shown === "1d" ? formatTime(new Date(t), timeZone) : shown === "1w" ? formatDayTime(t, timeZone) : formatDate(new Date(t), "medium");
  const axis = (v: number, step?: number) =>
    `${lens === "rate" ? "$" : "€"}${formatNumber(v, step !== undefined && step < 0.01 ? 3 : 2)}`;

  return (
    <Card
      className={clsx("rate-chart", className)}
      title={
        <span className="rate-chart__title">
          {pair}
          <InfoTip
            label={pair}
            content={`${
              lens === "rate" ? "What one euro is worth in dollars." : "What one dollar is worth in euros: up means your dollars are worth more."
            } Follows the EUR/USD switch at the top. ${data ? `Source: ${data.source}.` : ""}`}
          />
        </span>
      }
    >
      <p className="rate-chart__head">
        <span className="rate-chart__figure" data-testid="rate-now">
          {fmt(last, lens)}
        </span>
        {change !== null ? (
          <span className="rate-chart__change">
            {pct(change)} {shown === "max" ? rangeLabel : `in ${rangeLabel}`}
          </span>
        ) : null}
      </p>
      <Chart
        series={series}
        // Labelled in the legend, not on the plot, where it would cross the line.
        referenceLine={avg !== null ? { value: avg } : undefined}
        legendExtra={
          avg !== null ? (
            <span className="rate-chart__avg">
              <span className="rate-chart__avg-swatch" aria-hidden />
              Your average {fmt(avg, lens)}
            </span>
          ) : undefined
        }
        range={shown}
        ranges={[...RATE_RANGES]}
        rangeLabel={(r) => RATE_RANGE_LABELS[r as RateRange] ?? r}
        onRangeChange={(r) => setRange(r as RateRange)}
        loading={q.isPending}
        busy={q.isFetching && !q.isPending}
        valueFormat={axis}
        xMode={shown === "1d" ? "time" : "date"}
        timeFormat={timeFormat}
        tooltipTimeFormat={tooltipTimeFormat}
        height={260}
        ariaLabel={lens === "rate" ? "EUR/USD: one euro in dollars" : "USD/EUR: one dollar in euros"}
        emptyMessage={q.isError ? "Could not load the rate history." : "No rate history yet."}
      />
      {data ? <Figures data={data} lens={lens} /> : null}
    </Card>
  );
}
