import clsx from "clsx";
import { ArrowDownRight, ArrowUpRight, Minus, MoveRight, TrendingDown, TrendingUp } from "lucide-react";
import { useMemo } from "react";
import { Card } from "../Card";
import { Chart, type ChartSeries } from "../Chart";
import { InfoTip } from "../InfoTip";
import { SegmentedControl } from "../SegmentedControl";
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
import { useTimeZone } from "../../lib/timezone";
import { usePersistentState } from "../../lib/usePersistentState";
import "./RateChart.scss";

/** "rate": EUR/USD, dollars per euro (market quote). "dollar": one dollar priced in euros. */
export type RateLens = "rate" | "dollar";

const LENS_OPTIONS = [
  { value: "rate", label: "EUR/USD" },
  { value: "dollar", label: "1 $ in €" },
];

const isRange = (v: unknown): v is RateRange => RATE_RANGES.includes(v as RateRange);
const isLens = (v: unknown): v is RateLens => v === "rate" || v === "dollar";

const pick = (p: RatePointDto | null | undefined, lens: RateLens) =>
  p ? toNum(lens === "rate" ? p.rate : p.inverse) : null;

const fmt = (v: number | null, lens: RateLens) =>
  v === null ? "–" : lens === "rate" ? formatNumber(v, 4) : `€${formatNumber(v, 4)}`;

const pct = (v: number | null) => (v === null ? "–" : formatPercent(v, { signed: true, digits: 1 }));

const DIRECTION = {
  dollar_up: { word: "Dollar strengthening", Icon: TrendingUp, holdings: "tailwind", next: "headwind" },
  dollar_down: { word: "Dollar weakening", Icon: TrendingDown, holdings: "headwind", next: "tailwind" },
  sideways: { word: "Dollar moving sideways", Icon: MoveRight, holdings: "neutral", next: "neutral" },
} as const;

const NORMAL_WORD = { normal: "a normal month", large: "a larger month than usual", unusual: "an unusual month" } as const;

type Kind = "tailwind" | "headwind" | "neutral";
const KIND_ICON = { tailwind: ArrowUpRight, headwind: ArrowDownRight, neutral: Minus } as const;

function KindWord({ kind, children }: { kind: Kind; children: string }) {
  const Icon = KIND_ICON[kind];
  return (
    <span className={`rate-chart__kind rate-chart__kind--${kind}`}>
      <Icon aria-hidden className="rate-chart__kind-icon" />
      {children}
    </span>
  );
}

const kindOf = (v: number | null): Kind => (v === null || Math.abs(v) < 0.0005 ? "neutral" : v > 0 ? "tailwind" : "headwind");

/** The range's two readings: what it did to the dollars you hold, and to the euros you will convert. */
function Readings({ data, rangeLabel }: { data: RateHistoryDto; rangeLabel: string }) {
  const holdings = toNum(data.change?.inverse_pct);
  const next = toNum(data.change?.rate_pct);
  const trend = data.trend;
  const dir = trend ? DIRECTION[trend.direction] : null;
  return (
    <dl className="rate-chart__readings">
      <div className="rate-chart__reading">
        <dt className="rate-chart__reading-label">
          For dollars you hold, {rangeLabel}
          <InfoTip label="dollar holdings" content="What the rate move alone did to the euro value of a dollar you held over this range. Up is good for what you own." />
        </dt>
        <dd className="rate-chart__reading-value">
          <span className="rate-chart__reading-figure">{pct(holdings)}</span>
          <KindWord kind={kindOf(holdings)}>{kindOf(holdings) === "neutral" ? "Flat" : kindOf(holdings) === "tailwind" ? "Tailwind" : "Headwind"}</KindWord>
        </dd>
      </div>
      <div className="rate-chart__reading">
        <dt className="rate-chart__reading-label">
          For euros you convert, {rangeLabel}
          <InfoTip label="next euro" content="How many more or fewer dollars one euro buys than at the start of this range. Up is good for what you invest next." />
        </dt>
        <dd className="rate-chart__reading-value">
          <span className="rate-chart__reading-figure">{pct(next)}</span>
          <KindWord kind={kindOf(next)}>{kindOf(next) === "neutral" ? "Flat" : kindOf(next) === "tailwind" ? "Buys more" : "Buys less"}</KindWord>
        </dd>
      </div>
      {trend && dir ? (
        <div className="rate-chart__reading rate-chart__reading--trend">
          <dt className="rate-chart__reading-label">
            Trend
            <InfoTip
              label="trend"
              content="Exchange rates have no built-in upward drift: they wander in both directions, and that is normal. This describes the recent direction against the 200-day average and how big this month's move is next to a typical month. It does not predict."
            />
          </dt>
          <dd className="rate-chart__reading-value rate-chart__reading-value--trend">
            <span className="rate-chart__trend">
              <dir.Icon aria-hidden className="rate-chart__trend-icon" />
              {dir.word}
            </span>
            <span className="rate-chart__trend-note">
              {trend.since ? `since ${formatDate(trend.since, "medium")}` : null}
              {trend.since && trend.since_change_pct ? ` (${pct(toNum(trend.since_change_pct))})` : null}
              {` · ${NORMAL_WORD[trend.normal]}`}
              {` (${pct(toNum(trend.move_pct))}; typical ±${formatPercent(toNum(trend.typical_move_pct), { digits: 1 })})`}
            </span>
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

/**
 * The Currency page's first visual: EUR/USD over a chosen range, with your average
 * rate and the 200-day average, in either quote. Direction has two meanings for a
 * euro investor in dollars, so the line is never coloured good or bad.
 */
export function RateChart({ className }: { className?: string }) {
  const timeZone = useTimeZone();
  const [range, setRange] = usePersistentState<RateRange>("currency.rate.range", "1y", isRange);
  const [lens, setLens] = usePersistentState<RateLens>("currency.rate.lens", "rate", isLens);
  const q = useRateHistory(range);
  const data = q.data;
  const shown: RateRange = data?.range ?? range;

  const series = useMemo<ChartSeries[]>(() => {
    if (!data) return [];
    const toPts = (pts: RatePointDto[]) => pts.map((p) => ({ t: p.t, v: pick(p, lens) }));
    const out: ChartSeries[] = [
      { id: "rate", label: lens === "rate" ? "EUR/USD" : "1 $ in €", points: toPts(data.points), tone: "primary" },
    ];
    if (data.ma200.length) out.push({ id: "ma200", label: "200-day average", points: toPts(data.ma200), tone: "benchmark" });
    return out;
  }, [data, lens]);

  const avg = data?.avg_rate ? toNum(lens === "rate" ? data.avg_rate.rate : data.avg_rate.inverse) : null;
  const last = data?.points.length ? pick(data.points[data.points.length - 1], lens) : null;
  const change = toNum(lens === "rate" ? data?.change?.rate_pct : data?.change?.inverse_pct);
  const rangeLabel = RATE_RANGE_LABELS[shown] === "Max" ? "since 1999" : `over ${RATE_RANGE_LABELS[shown]}`;
  const long = shown === "1y" || shown === "5y" || shown === "10y" || shown === "max";

  const timeFormat = (t: number) =>
    shown === "1d" ? formatTime(new Date(t), timeZone) : shown === "1w" ? formatShortDay(t, timeZone) : formatAxisDate(t, long ? Infinity : 0);
  const tooltipTimeFormat = (t: number) =>
    shown === "1d" ? formatTime(new Date(t), timeZone) : shown === "1w" ? formatDayTime(t, timeZone) : formatDate(new Date(t), "medium");

  return (
    <Card
      className={clsx("rate-chart", className)}
      title="Exchange rate"
      actions={
        <SegmentedControl
          size="sm"
          ariaLabel="Quote"
          options={LENS_OPTIONS}
          value={lens}
          onChange={(v) => setLens(v as RateLens)}
        />
      }
    >
      <div className="rate-chart__head">
        <p className="rate-chart__figure" data-testid="rate-now">
          {fmt(last, lens)}
        </p>
        <p className="rate-chart__figure-note">
          <span className="rate-chart__unit">{lens === "rate" ? "dollars per euro" : "euros per dollar"}</span>
          {change !== null ? (
            <span className="rate-chart__change">
              {pct(change)} {rangeLabel}
            </span>
          ) : null}
        </p>
      </div>
      <Chart
        series={series}
        // Labelled in the legend, not on the plot, where it would cross the line.
        referenceLine={avg !== null ? { value: avg } : undefined}
        legendExtra={
          avg !== null ? (
            <span className="rate-chart__avg">
              <span className="rate-chart__avg-swatch" aria-hidden />
              Your average {fmt(avg, lens)}
              <InfoTip label="your average" content="The average rate at which your euros became dollars, weighted by amount. Above it in EUR/USD (below it in 1 $ in €), the rate move has cost your holdings." />
            </span>
          ) : undefined
        }
        range={shown}
        ranges={[...RATE_RANGES]}
        rangeLabel={(r) => RATE_RANGE_LABELS[r as RateRange] ?? r}
        onRangeChange={(r) => setRange(r as RateRange)}
        loading={q.isPending}
        busy={q.isFetching && !q.isPending}
        valueFormat={(v, step) => (lens === "rate" ? formatNumber(v, step !== undefined && step < 0.01 ? 3 : 2) : `€${formatNumber(v, step !== undefined && step < 0.01 ? 3 : 2)}`)}
        xMode={shown === "1d" ? "time" : "date"}
        timeFormat={timeFormat}
        tooltipTimeFormat={tooltipTimeFormat}
        height={260}
        ariaLabel={lens === "rate" ? "EUR/USD exchange rate" : "One dollar priced in euros"}
        emptyMessage={q.isError ? "Could not load the rate history." : "No rate history yet."}
      />
      {data ? (
        <p className="rate-chart__extremes">
          <span>
            Low {fmt(pick(lens === "rate" ? data.low : data.high, lens), lens)}
            {(lens === "rate" ? data.low : data.high) ? ` on ${formatDate((lens === "rate" ? data.low : data.high)!.t.slice(0, 10), "medium")}` : ""}
          </span>
          <span>
            High {fmt(pick(lens === "rate" ? data.high : data.low, lens), lens)}
            {(lens === "rate" ? data.high : data.low) ? ` on ${formatDate((lens === "rate" ? data.high : data.low)!.t.slice(0, 10), "medium")}` : ""}
          </span>
          <span className="rate-chart__source">{data.source}</span>
        </p>
      ) : null}
      {data ? <Readings data={data} rangeLabel={rangeLabel} /> : null}
    </Card>
  );
}
