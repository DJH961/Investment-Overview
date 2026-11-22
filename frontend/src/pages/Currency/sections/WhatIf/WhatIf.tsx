import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ArrowRight, RotateCcw, Scale } from "lucide-react";
import { Link } from "react-router";
import { Card } from "../../../../components/Card";
import { CurrencySection } from "../../../../components/CurrencySection";
import { InfoTip } from "../../../../components/InfoTip";
import { Money } from "../../../../components/Money";
import type { StatItem } from "../../../../components/StatStrip";
import { formatDate, formatMoney, formatNumber, formatPercent } from "../../../../lib/format";
import { useScenarios, type ScenarioMarkDto, type ScenariosDto } from "../../../../lib/queries/currencyDollar";
import { RATE_RANGE_LABELS, type RateRange } from "../../../../lib/queries/currencyRate";
import { toNum } from "../../../../lib/queries/portfolio";
import type { CurrencySectionComponentProps } from "../../sections";
import { layoutMarks } from "./layoutMarks";
import "./WhatIf.scss";

type Ccy = ScenariosDto["ccy"];

/** The page currency shows the quote of its own currency: euros per dollar, or dollars per euro. */
const QUOTE_WORDS = {
  "USD/EUR": { thing: "One dollar in euros", mover: "Dollar" },
  "EUR/USD": { thing: "One euro in dollars", mover: "Euro" },
} as const;

/** The range worded for a label: "1Y low", "low since you started", "low since 1999". */
function rangeWords(range: RateRange): { low: string; high: string; start: string; window: string } {
  if (range === "all") return { low: "Low since you started", high: "High since you started", start: "You started", window: "since you started" };
  if (range === "max") return { low: "Low since 1999", high: "High since 1999", start: "1999", window: "since 1999" };
  const label = RATE_RANGE_LABELS[range];
  return { low: `${label} low`, high: `${label} high`, start: `${label} start`, window: `over the last ${label}` };
}

function markNames(range: RateRange): Record<ScenarioMarkDto["key"], string> {
  const w = rangeWords(range);
  return {
    today: "Today",
    average: "Your average",
    breakeven: "Break-even",
    range_start: w.start,
    historic_low: w.low,
    historic_high: w.high,
  };
}
const MARK_ORDER: ScenarioMarkDto["key"][] = ["today", "average", "breakeven", "range_start", "historic_low", "historic_high"];

/** A rate in the quote shown, 4 decimals, in the currency it is quoted in (EUR view: "€0.8590"). */
const rateText = (value: string | number | null, ccy: Ccy) =>
  formatMoney(typeof value === "number" ? value : toNum(value), ccy, { digits: 4 });

/** A diverging bar from a centre line: blue to the right (gain), orange to the left (loss). */
function DeltaBar({ value, scale }: { value: number; scale: number }) {
  const half = scale > 0 ? Math.min(50, (Math.abs(value) / scale) * 50) : 0;
  return (
    <span className="delta-bar" aria-hidden>
      <span className={`delta-bar__fill delta-bar__fill--${value < 0 ? "neg" : "pos"}`} style={{ "--w": half } as CSSProperties} />
    </span>
  );
}

/** One label on the track: marks that sit on the same rate are merged into one. */
interface MarkGroup {
  key: string;
  row: number;
  text: string;
  today: boolean;
}

function groupMarks(marks: ScenarioMarkDto[], ccy: Ccy, range: RateRange): MarkGroup[] {
  const MARK_NAMES = markNames(range);
  const byRate = new Map<string, ScenarioMarkDto[]>();
  for (const m of marks) {
    const k = rateText(m.rate_display, ccy);
    byRate.set(k, [...(byRate.get(k) ?? []), m]);
  }
  return [...byRate.entries()].map(([rate, list]) => {
    const sorted = [...list].sort((a, b) => MARK_ORDER.indexOf(a.key) - MARK_ORDER.indexOf(b.key));
    const names = sorted.map((m) => MARK_NAMES[m.key]);
    return {
      key: sorted.map((m) => m.key).join("+"),
      row: sorted[0]!.row_index,
      text: `${names.join(" · ")} ${rate}`,
      today: sorted.some((m) => m.key === "today"),
    };
  });
}

/** The track width, so label rows can be worked out; a fixed guess before the first measure. */
function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(320);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (el.clientWidth > 0) setWidth(el.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

const THUMB_PX = 20;
const CHAR_PX = 6.6;
const LANE_REM = 1.375;

function ScenarioSlider({ data }: { data: ScenariosDto }) {
  const rows = data.rows ?? [];
  const marks = useMemo(() => data.marks ?? [], [data.marks]);
  const words = QUOTE_WORDS[data.quote.pair];
  const today = marks.find((m) => m.key === "today");
  const todayRow = Math.min(rows.length - 1, Math.max(0, today?.row_index ?? 0));
  // The picked row, or today's when nothing is picked (or the rows changed under it).
  const [picked, setPicked] = useState<{ row: number; base: number } | null>(null);
  const index = picked && picked.base === todayRow ? picked.row : todayRow;
  const setIndex = (row: number) => setPicked({ row, base: todayRow });
  const trackRef = useRef<HTMLDivElement>(null);
  const width = useWidth(trackRef);
  const max = Math.max(rows.length - 1, 1);
  const groups = useMemo(() => groupMarks(marks, data.ccy, data.range), [marks, data.ccy, data.range]);
  const usable = Math.max(width - THUMB_PX, 1);
  const placed = useMemo(
    () =>
      layoutMarks(
        groups.map((g) => ({ x: THUMB_PX / 2 + (g.row / max) * usable, w: g.text.length * CHAR_PX + 10 })),
        width,
      ),
    [groups, max, usable, width],
  );
  const lanes = placed.reduce((n, p) => Math.max(n, p.lane + 1), 0);
  const activeIndex = Math.min(rows.length - 1, Math.max(0, index));
  const row = rows[activeIndex];
  if (!row) return null;
  const pair = data.quote.pair;
  const toBreakeven = row.to_breakeven_pct == null ? null : toNum(row.to_breakeven_pct);
  // Linear presentation maths only: this row's value minus today's, both from the server.
  // Not exposed: none of the holdings are in the other currency, so this side's own value
  // never moves with the rate; what moves is their worth in the other one (server figures).
  const exposed = data.exposed;
  const shownCcy: Ccy = exposed ? data.ccy : data.other_ccy;
  const otherName = shownCcy === "EUR" ? "euros" : "dollars";
  const nowValue = exposed ? data.value_now : data.value_now_other;
  const rowValue = exposed ? row.value : row.other_value;
  const diff = nowValue == null || rowValue == null ? null : (toNum(rowValue) ?? 0) - (toNum(nowValue) ?? 0);
  const diffScale = Math.max(
    0,
    ...(data.stress ?? []).map((s) => Math.abs(toNum(exposed ? s.change : s.other_change) ?? 0)),
  );

  return (
    <Card className="what-if__scenario" title="Try another exchange rate">
      <p className="what-if__intro">
        Drag the handle to value today's holdings at another rate. This shows what a rate would mean for you, not where the rate is going.
        {exposed
          ? null
          : ` All your holdings are in ${data.ccy === "EUR" ? "euros" : "dollars"}, so their ${data.ccy === "EUR" ? "euro" : "dollar"} value stays the same at any rate; what the rate changes is their worth in ${otherName}.`}
      </p>
      <div className="what-if__try">
        <div className="scenario-slider">
          <div className="scenario-slider__head">
            <label className="scenario-slider__label" htmlFor="what-if-rate">
              {words.thing} <span className="scenario-slider__pair">({pair})</span>
            </label>
            {activeIndex !== todayRow ? (
              <button type="button" className="scenario-slider__reset" onClick={() => setIndex(todayRow)}>
                <RotateCcw aria-hidden /> Back to today
              </button>
            ) : null}
          </div>
          <p className="scenario-slider__rate" aria-live="polite">
            {rateText(row.rate_display, data.ccy)}
          </p>
          <p className="scenario-slider__ends" aria-hidden>
            <span>{rateText(data.min_rate, data.ccy)}</span>
            <span>{rateText(data.max_rate, data.ccy)}</span>
          </p>
          <div className="scenario-slider__track" ref={trackRef} style={{ "--thumb": `${THUMB_PX}px` } as CSSProperties}>
            <input
              id="what-if-rate"
              className="scenario-slider__input"
              type="range"
              min={0}
              max={max}
              step={1}
              value={activeIndex}
              onChange={(event) => setIndex(Number(event.currentTarget.value))}
              aria-valuetext={`${pair} ${rateText(row.rate_display, data.ccy)}`}
            />
            {groups.length ? (
              <ul
                className="scenario-slider__marks"
                aria-label="Reference rates"
                style={{ "--lane-h": `${LANE_REM}rem`, "--lanes": lanes } as CSSProperties}
              >
                {groups.map((g, i) => {
                  const place = placed[i]!;
                  return (
                    <li
                      key={g.key}
                      className={`scenario-slider__mark${g.today ? " scenario-slider__mark--today" : ""}`}
                      style={{ "--p": g.row / max, "--lane": place.lane, "--dx": place.dx } as CSSProperties}
                    >
                      <span className="scenario-slider__mark-text">{g.text}</span>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        </div>
        <dl className="scenario-result">
          <div className="scenario-result__item scenario-result__item--lead">
            <dt className="scenario-result__label">{exposed ? "Holdings worth" : `Holdings worth in ${otherName}`}</dt>
            <dd className="scenario-result__value">
              <Money amount={toNum(exposed ? row.value : row.other_value)} currency={shownCcy} digits={0} />
            </dd>
            {exposed ? null : (
              <dd className="scenario-result__note">
                In {data.ccy === "EUR" ? "euros" : "dollars"} they stay at <Money amount={toNum(row.value)} currency={data.ccy} digits={0} />
              </dd>
            )}
          </div>
          {diff !== null ? (
            <div className="scenario-result__item scenario-result__item--lead">
              <dt className="scenario-result__label">Compared with today</dt>
              <dd className="scenario-result__value scenario-result__value--sub">
                {Math.abs(diff) < 0.5 ? "No change" : <Money amount={diff} currency={shownCcy} signed colored digits={0} />}
              </dd>
              <dd className="scenario-result__bar">
                <DeltaBar value={diff} scale={Math.max(diffScale, Math.abs(diff))} />
              </dd>
            </div>
          ) : null}
          {exposed ? (
            <div className="scenario-result__item">
              <dt className="scenario-result__label">Currency gain/loss</dt>
              <dd className="scenario-result__value">
                <Money amount={toNum(row.gain)} currency={data.ccy} signed colored digits={0} />
              </dd>
            </div>
          ) : null}
          <div className="scenario-result__item">
            <dt className="scenario-result__label">Move to break even</dt>
            <dd className="scenario-result__value">
              {toBreakeven == null ? "—" : Math.abs(toBreakeven) < 0.00005 ? "None" : formatPercent(toBreakeven, { signed: true })}
            </dd>
            <dd className="scenario-result__note">
              {row.to_breakeven == null || toBreakeven == null || Math.abs(toBreakeven) < 0.00005
                ? "At break-even"
                : `${toNum(row.to_breakeven)! > 0 ? "+" : "−"}${Math.abs(toNum(row.to_breakeven)!).toFixed(4)} on ${pair}`}
            </dd>
          </div>
        </dl>
      </div>
    </Card>
  );
}

function StressCard({ data }: { data: ScenariosDto }) {
  const stress = data.stress ?? [];
  if (!stress.length || data.value_now == null) return null;
  const words = QUOTE_WORDS[data.quote.pair];
  // Not exposed: the side's own value never moves, so the table shows the other currency.
  const shownCcy: Ccy = data.exposed ? data.ccy : data.other_ccy;
  const valueOf = (s: (typeof stress)[number]) => (data.exposed ? s.value : s.other_value);
  const changeOf = (s: (typeof stress)[number]) => (data.exposed ? s.change : s.other_change);
  const nowValue = data.exposed ? data.value_now : data.value_now_other;
  const scale = Math.max(...stress.map((s) => Math.abs(toNum(changeOf(s)) ?? 0)));
  const falls = stress.filter((s) => toNum(s.shift_pct)! < 0);
  const rises = stress.filter((s) => toNum(s.shift_pct)! > 0);
  const cell = (s: (typeof stress)[number]) => (
    <tr key={s.shift_pct} className="rate-table__row">
      <th scope="row">{formatPercent(toNum(s.shift_pct), { signed: true, digits: 0 })}</th>
      <td>{formatNumber(toNum(s.rate_display), 4)}</td>
      <td>
        <Money amount={toNum(valueOf(s))} currency={shownCcy} digits={0} />
      </td>
      <td className="rate-table__delta">
        <Money amount={toNum(changeOf(s))} currency={shownCcy} signed colored digits={0} />
        <DeltaBar value={toNum(changeOf(s)) ?? 0} scale={scale} />
      </td>
    </tr>
  );
  return (
    <Card className="what-if__stress" title={`If the ${words.mover.toLowerCase()} moves`}>
      <p className="what-if__intro">
        Today's holdings if {data.quote.pair} were 5, 10 or 15% different from today.
        {data.exposed
          ? null
          : ` Your holdings are all in ${data.ccy === "EUR" ? "euros" : "dollars"}, so only their worth in ${shownCcy === "EUR" ? "euros" : "dollars"} changes.`}
      </p>
      <table className="rate-table" aria-label={`Holdings value if ${data.quote.pair} moves`}>
        <thead>
          <tr className="rate-table__head">
            <th scope="col">{words.mover}</th>
            <th scope="col">{data.quote.pair}</th>
            <th scope="col">Worth</th>
            <th scope="col">Change</th>
          </tr>
        </thead>
        <tbody>
          {falls.map(cell)}
          <tr className="rate-table__row rate-table__row--today">
            <th scope="row">Today</th>
            <td>{formatNumber(toNum(data.rate_now ? data.rate_now[data.quote.field] : null), 4)}</td>
            <td>
              <Money amount={toNum(nowValue)} currency={shownCcy} digits={0} />
            </td>
            <td className="rate-table__delta">
              —
              <span className="delta-bar delta-bar--empty" aria-hidden />
            </td>
          </tr>
          {rises.map(cell)}
        </tbody>
      </table>
    </Card>
  );
}

/** Euro vs dollar figure for one measure as two bars on one scale (the dollar bar is hatched). */
function PairBars({ title, hint, eur, usd }: { title: string; hint: string; eur: number | null; usd: number | null }) {
  const top = Math.max(Math.abs(eur ?? 0), Math.abs(usd ?? 0));
  const line = (name: string, value: number | null, kind: "eur" | "usd") => (
    <div className="pair-bars__line">
      <span className="pair-bars__name">{name}</span>
      <span className="pair-bars__track" aria-hidden>
        <span
          className={`pair-bars__fill pair-bars__fill--${kind}`}
          style={{ "--w": top > 0 ? (Math.abs(value ?? 0) / top) * 100 : 0 } as CSSProperties}
        />
      </span>
      <span className="pair-bars__value">{formatPercent(value, { digits: 1 })}</span>
    </div>
  );
  return (
    <div className="pair-bars">
      <p className="pair-bars__title">
        {title} <span className="pair-bars__hint">· {hint}</span>
      </p>
      {line("In euros", eur, "eur")}
      {line("In dollars", usd, "usd")}
    </div>
  );
}

function RiskCard({ data }: { data: ScenariosDto }) {
  const cushion = data.cushion;
  if (!cushion) return null;
  const rose = toNum(cushion.dollar_rose_share);
  return (
    <Card
      className="what-if__risk"
      title={
        <span className="what-if__title">
          Does the dollar cushion your swings?
          <InfoTip
            label="Does the dollar cushion your swings?"
            content="A comparison of the portfolio's historical volatility and deepest fall in euros and dollars. It describes what happened; it is not a promise that it will happen again."
          />
        </span>
      }
    >
      <div className="what-if__groups">
        <p className="what-if__intro">
          Your own history, since {formatDate(cushion.since)}
          {data.range === "all" || data.range === "max" ? "" : ` (${RATE_RANGE_LABELS[data.range]})`}.
        </p>
        {cushion.too_short ? (
          <p className="what-if__note">
            This window is too short to say how much your holdings swing. Pick a longer range to compare.
          </p>
        ) : (
          <>
        <PairBars title="Volatility" hint="how much it swings" eur={toNum(cushion.volatility_eur)} usd={toNum(cushion.volatility_usd)} />
        <PairBars
          title="Deepest fall"
          hint="worst drop from a peak"
          eur={toNum(cushion.max_drawdown_eur)}
          usd={toNum(cushion.max_drawdown_usd)}
        />
        {rose !== null ? (
          <div className="pair-bars">
            <p className="pair-bars__title">
              Days your holdings fell <span className="pair-bars__hint">· did the dollar rise?</span>
            </p>
            <div className="pair-bars__line pair-bars__line--share">
              <span className="pair-bars__name">Dollar rose</span>
              <span className="pair-bars__track" aria-hidden>
                <span className="pair-bars__fill pair-bars__fill--eur" style={{ "--w": rose * 100 } as CSSProperties} />
              </span>
              <span className="pair-bars__value">{formatPercent(rose, { digits: 0 })}</span>
            </div>
            <p className="what-if__note">
              On {cushion.down_days_dollar_rose} of the {cushion.down_days} days your holdings fell.
            </p>
          </div>
        ) : (
          <p className="what-if__note">There are not enough down days to compare yet.</p>
        )}
          </>
        )}
      </div>
    </Card>
  );
}

/** The four what-if figures of the strip, worded for the quote the page shows. */
function tiles(data: ScenariosDto): StatItem[] {
  const pair = data.quote.pair;
  const by = new Map((data.stats ?? []).map((s) => [s.key, s]));
  const out: StatItem[] = [];
  const cent = by.get("one_cent");
  if (cent) {
    out.push({
      key: "one_cent",
      label: `One cent of ${pair}`,
      tip: `How much your holdings' value moves if ${pair} moves by one cent from today's rate. It is a size, not a loss: it can go either way.`,
      value: (
        <>
          ±<Money amount={Math.abs(toNum(cent.value) ?? 0)} currency={data.ccy} digits={0} />
        </>
      ),
      note: "each way, per cent",
    });
  }
  const be = by.get("breakeven");
  if (be) {
    out.push({
      key: "breakeven",
      label: "Break-even rate",
      tip: `The ${pair} rate at which your holdings carry no currency gain or loss.`,
      value: rateText(be.value_display ?? be.value, data.ccy),
      note: pair,
    });
  }
  const words = rangeWords(data.range);
  for (const [key, label, word] of [
    ["value_at_low", `Worth at ${words.low.replace(/^Low/, "low")}`, "lowest"],
    ["value_at_high", `Worth at ${words.high.replace(/^High/, "high")}`, "highest"],
  ] as const) {
    const s = by.get(key);
    if (!s) continue;
    const worthCcy = s.currency ?? data.ccy;
    out.push({
      key,
      label: worthCcy === data.ccy ? label : `${label} (in ${worthCcy === "EUR" ? "euros" : "dollars"})`,
      tip: `What your holdings would be worth at the ${word} ${pair} rate ${words.window}.`,
      value: <Money amount={toNum(s.value) ?? 0} currency={worthCcy} digits={0} />,
      note: `at ${rateText(s.secondary_display ?? s.secondary ?? null, data.ccy)}${s.date ? ` · ${formatDate(s.date)}` : ""}`,
    });
  }
  return out;
}

/** Server-calculated what-if scenarios, with a discrete slider that only selects a row. */
export function WhatIf({ id, label, currency, range }: CurrencySectionComponentProps) {
  const q = useScenarios(currency, range);
  const data = q.data;
  const hasRows = Boolean(data?.rows?.length);
  return (
    <CurrencySection
      id={id}
      title={label}
      explainer="See what a different exchange rate would mean for your dollar holdings."
      meta={data?.as_of ? `As of ${formatDate(data.as_of)}` : undefined}
      stats={data ? tiles(data) : undefined}
      statsLabel="What if at a glance"
      state={q.isError && !data ? "error" : !data ? "loading" : hasRows ? "ready" : "empty"}
      onRetry={() => void q.refetch()}
      busy={q.isFetching && !q.isPending && q.isPlaceholderData}
      emptyIcon={<Scale aria-hidden />}
      emptyTitle="No dollar holdings to model"
      emptyDescription="Once you hold something priced in dollars, you can see how different rates would value it."
      skeleton={["5rem", "16rem"]}
      className="what-if-section"
    >
      {data ? (
        <div className="what-if">
          <ScenarioSlider data={data} />
          <div className="what-if__pair">
            <StressCard data={data} />
            <RiskCard data={data} />
          </div>
          <Link className="what-if__link" to="/projection#rate-band">
            The Projection page shows how rates could change your future value <ArrowRight aria-hidden />
          </Link>
        </div>
      ) : null}
    </CurrencySection>
  );
}
