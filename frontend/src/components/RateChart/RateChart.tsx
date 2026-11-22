import clsx from "clsx";
import { ArrowDownRight, ArrowUpRight, Minus, MoveRight, TrendingDown, TrendingUp } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Card } from "../Card";
import { Chart, type ChartMarker, type ChartSeries } from "../Chart";
import { InfoTip } from "../InfoTip";
import {
  formatAxisDate,
  formatDate,
  formatDayTime,
  formatMoney,
  formatNumber,
  formatPercent,
  formatShortDay,
  formatTime,
} from "../../lib/format";
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

/** The same trend told from the euro's side (the USD view, EUR/USD): the dollar weakening is the euro strengthening. */
const EURO_DIRECTION = {
  dollar_up: DIRECTION.dollar_down,
  dollar_down: DIRECTION.dollar_up,
  sideways: DIRECTION.sideways,
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
  // The USD view (EUR/USD, the investing side) tells the trend as the euro's.
  const euroSide = lens === "rate";
  const dir = trend ? (euroSide ? EURO_DIRECTION : DIRECTION)[trend.direction] : null;
  // Low and high of the quote shown (in USD/EUR the dollar's low is EUR/USD's high).
  const lo = lens === "rate" ? data.low : data.high;
  const hi = lens === "rate" ? data.high : data.low;
  const day = (p: RatePointDto | null | undefined) => (p ? formatDate(p.t.slice(0, 10)) : "–");
  const hold = (
      <Figure
        key="hold"
        label="Dollars you hold"
        tip="What the rate move alone did to the euro value of a dollar held through this range. Up is good for what you own."
        value={pct(holdings)}
        note={<KindWord kind={kindOf(holdings)} words={{ tailwind: "Tailwind", headwind: "Headwind", neutral: "Flat" }} />}
      />
  );
  const convert = (
      <Figure
        key="convert"
        label="Euros you convert"
        tip="How many more or fewer dollars one euro buys than at the start of this range. Up is good for what you invest next."
        value={pct(next)}
        note={<KindWord kind={kindOf(next)} words={{ tailwind: "Buys more", headwind: "Buys less", neutral: "Flat" }} />}
      />
  );
  return (
    <dl className="rate-chart__figs">
      <Figure
        label="Low – high"
        tip={`The lowest and highest rate in this range: ${day(lo)} and ${day(hi)}.`}
        value={`${fmt(pick(lo, lens), lens)} – ${fmt(pick(hi, lens), lens).replace(/^[$€]/, "")}`}
      />
      {euroSide ? [convert, hold] : [hold, convert]}
      {trend && dir ? (
        <Figure
          label={euroSide ? "Euro trend" : "Dollar trend"}
          tip={
            <>
              Exchange rates have no built-in upward drift: they wander both ways, and that is normal.{" "}
              {euroSide ? (
                <>
                  This compares the euro with its 200-day average, and this month&apos;s move with a typical month. A
                  stronger euro buys more dollars. It describes; it does not predict.
                </>
              ) : (
                <>
                  This compares the dollar with its 200-day average
                  {trend.since && trend.since_change_pct ? ` (this direction since ${formatDate(trend.since)}: ${pct(toNum(trend.since_change_pct))})` : ""}
                  , and this month&apos;s move ({pct(toNum(trend.move_pct))}) with a typical month (±
                  {formatPercent(toNum(trend.typical_move_pct), { digits: 1 })}). It describes; it does not predict.
                </>
              )}
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

const MARK_WORD = { above_reference: "better than the reference rate", below_reference: "worse than the reference rate" } as const;

/**
 * Your conversions on the chart (server `markers`, 7.2 contract with 7.3): quiet ticks on
 * the date axis, taller for larger amounts (within each source currency). They mark when
 * you converted, not a point on the reference line: your own rate usually differs from
 * the fixing, so a mark on the line would mislead. Only those inside the plotted span.
 */
export function conversionMarks(data: RateHistoryDto, lens: RateLens): ChartMarker[] {
  const pts = data.points ?? [];
  const list = data.markers ?? [];
  if (!pts.length || !list.length) return [];
  const t0 = Date.parse(pts[0].t.length === 10 ? `${pts[0].t}T00:00:00Z` : pts[0].t);
  const last = pts[pts.length - 1].t;
  const t1 = Date.parse(last.length === 10 ? `${last}T23:59:59Z` : last);
  const max = new Map<string, number>();
  for (const m of list) max.set(m.from_ccy, Math.max(max.get(m.from_ccy) ?? 0, Math.abs(toNum(m.amount_from) ?? 0)));
  return list.flatMap((m) => {
    const t = Date.parse(`${m.date.slice(0, 10)}T12:00:00Z`);
    const rate = toNum(m.rate);
    if (!Number.isFinite(t) || t < t0 - 43_200_000 || t > t1 || rate === null || !(rate > 0)) return [];
    const amount = Math.abs(toNum(m.amount_from) ?? 0);
    const top = max.get(m.from_ccy) ?? 0;
    // Tick height follows the amount (square root, so the area reads like the amount).
    const h = 4 + 8 * (top > 0 ? Math.sqrt(amount / top) : 0);
    const kind = m.kind ?? null;
    const v = lens === "rate" ? rate : 1 / rate;
    const what = `${formatMoney(amount, m.from_ccy, { digits: 0 })} to ${m.to_ccy} on ${formatDate(m.date.slice(0, 10))} at ${formatNumber(rate, 4)}`;
    return [{ t, v, r: h, shape: "rug" as const, label: kind ? `Converted ${what}: ${MARK_WORD[kind]}` : `Converted ${what}` }];
  });
}

/**
 * The Currency page's first visual: the exchange rate over a chosen range, quoted like
 * the Today card, with your average rate and the 200-day average. Direction means
 * different things for dollars held and euros still to convert, so the line is never
 * coloured good or bad; the figures below give both readings.
 */
export function RateChart({
  currency,
  className,
  range: rangeProp,
  onRangeChange,
  showRangePicker = true,
}: {
  currency: ReportingCurrency;
  className?: string;
  /** The page's range (the Currency page owns it); without it the chart keeps its own. */
  range?: RateRange;
  onRangeChange?: (range: RateRange) => void;
  /** Render the chart's own range buttons (false when the page shows the picker elsewhere). */
  showRangePicker?: boolean;
}) {
  const timeZone = useTimeZone();
  const [ownRange, setOwnRange] = usePersistentState<RateRange>(rangeProp ? null : "currency.rate.range", "1y", isRange);
  const range = rangeProp ?? ownRange;
  const setRange = onRangeChange ?? setOwnRange;
  const lens = lensFor(currency);
  const pair = lens === "rate" ? "EUR/USD" : "USD/EUR";
  const q = useRateHistory(range);
  const data = q.data;
  const shown: RateRange = data?.range ?? range;

  const series = useMemo<ChartSeries[]>(() => {
    if (!data) return [];
    const toPts = (pts: RatePointDto[]) => pts.map((p) => ({ t: p.t, v: pick(p, lens) }));
    const out: ChartSeries[] = [{ id: "rate", label: pair, points: toPts(data.points ?? []), tone: "primary" }];
    if (data.ma200?.length) out.push({ id: "ma200", label: "200-day average", points: toPts(data.ma200), tone: "benchmark" });
    return out;
  }, [data, lens, pair]);

  const marks = useMemo(() => (data ? conversionMarks(data, lens) : []), [data, lens]);
  const avg = data?.avg_rate ? toNum(lens === "rate" ? data.avg_rate.rate : data.avg_rate.inverse) : null;
  const pts = data?.points ?? [];
  const last = pts.length ? pick(pts[pts.length - 1], lens) : null;
  const change = toNum(lens === "rate" ? data?.change?.rate_pct : data?.change?.inverse_pct);
  const rangeLabel = shown === "max" ? "since 1999" : shown === "all" ? "since you started" : RATE_RANGE_LABELS[shown];
  const long = shown === "1y" || shown === "all" || shown === "5y" || shown === "10y" || shown === "max";
  const sessions = useMemo(
    () => (shown === "1w" ? (data?.sessions ?? []).map((s) => ({ date: s.close.slice(0, 10), open: s.open, close: s.close })) : []),
    [data, shown],
  );
  // 1D / 1W: shade the hours the US stock market was open (the rate trades round the clock).
  const shade = useMemo(
    () => (shown === "1d" || shown === "1w" ? (data?.us_market_hours ?? []).map((h) => ({ from: h.open, to: h.close })) : []),
    [data, shown],
  );

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
            {pct(change)} {shown === "max" || shown === "all" ? rangeLabel : `in ${rangeLabel}`}
          </span>
        ) : null}
      </p>
      <Chart
        series={series}
        // Labelled in the legend, not on the plot, where it would cross the line.
        // Far from a short range's line it becomes an edge marker, so the line keeps its scale.
        referenceLine={avg !== null ? { value: avg, softBounds: true } : undefined}
        markers={marks.length ? marks : undefined}
        legendExtra={
          avg !== null || marks.length || shade.length ? (
            <span className="rate-chart__keys">
              {shade.length ? (
                <span className="rate-chart__avg">
                  <span className="rate-chart__shade-swatch" aria-hidden />
                  US market open
                </span>
              ) : null}
              {avg !== null ? (
                <span className="rate-chart__avg">
                  <span className="rate-chart__avg-swatch" aria-hidden />
                  Your average {fmt(avg, lens)}
                </span>
              ) : null}
              {marks.length ? (
                <span className="rate-chart__avg">
                  <span className="rate-chart__mark-swatch" aria-hidden />
                  {marks.length === 1 ? "1 conversion" : `${marks.length} conversions`}
                </span>
              ) : null}
            </span>
          ) : undefined
        }
        range={shown}
        ranges={showRangePicker ? [...RATE_RANGES] : undefined}
        rangeLabel={(r) => RATE_RANGE_LABELS[r as RateRange] ?? r}
        onRangeChange={(r) => setRange(r as RateRange)}
        loading={q.isPending}
        busy={q.isFetching && !q.isPending}
        valueFormat={axis}
        xMode={shown === "1d" ? "time" : shown === "1w" && sessions.length ? "session" : "date"}
        sessions={sessions.length ? sessions : undefined}
        shade={shade.length ? shade : undefined}
        // Spot FX resumes where it left off on Friday: one line across the weekend divider.
        joinSessions
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
