import clsx from "clsx";
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
import { pctText, windowText } from "../../numbers";
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
  if (range === "1d") return { low: "Today's low", high: "Today's high", start: "Last close", window: "today" };
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
  // The EUR view values today's holdings (cashing out); the USD view prices the euros you
  // send in (investing). Both are server figures; the client only subtracts and displays.
  const invest = data.perspective === "invest" ? data.invest : null;
  const unit = invest ? toNum(invest.unit_eur) : null;
  const monthly = invest ? toNum(invest.monthly_eur) : null;
  const diff = invest
    ? row.unit_change == null
      ? null
      : toNum(row.unit_change)
    : data.value_now == null
      ? null
      : (toNum(row.value) ?? 0) - (toNum(data.value_now) ?? 0);
  const diffScale = Math.max(
    0,
    ...(data.stress ?? []).map((s) => Math.abs(toNum(invest ? s.unit_change : s.change) ?? 0)),
  );
  const euros = (n: number | null) => formatMoney(n, "EUR", { digits: 0 });

  return (
    <Card className="what-if__scenario" title="Try another exchange rate">
      <p className="what-if__intro">
        {invest
          ? `Drag the handle to see what the euros you send in would buy at another rate. A stronger euro buys more dollars. `
          : "Drag the handle to value today's holdings at another rate. "}
        This shows what a rate would mean for you, not where the rate is going.
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
            <dt className="scenario-result__label">{invest ? `${euros(unit)} buys` : "Holdings worth"}</dt>
            <dd className="scenario-result__value">
              <Money amount={toNum(invest ? row.per_unit : row.value)} currency={data.ccy} digits={0} />
            </dd>
            {invest ? (
              <dd className="scenario-result__note">
                Your regular {euros(monthly)}: <Money amount={toNum(row.per_monthly)} currency={data.ccy} digits={0} />
              </dd>
            ) : null}
          </div>
          {diff !== null ? (
            <div className="scenario-result__item scenario-result__item--lead">
              <dt className="scenario-result__label">Compared with today</dt>
              <dd className="scenario-result__value scenario-result__value--sub">
                {Math.abs(diff) < 0.5 ? "No change" : <Money amount={diff} currency={data.ccy} signed colored digits={0} />}
              </dd>
              {invest && row.monthly_change != null && Math.abs(toNum(row.monthly_change) ?? 0) >= 0.5 ? (
                <dd className="scenario-result__note">
                  On your regular {euros(monthly)}: <Money amount={toNum(row.monthly_change)} currency={data.ccy} signed colored digits={0} />
                </dd>
              ) : null}
              <dd className="scenario-result__bar">
                <DeltaBar value={diff} scale={Math.max(diffScale, Math.abs(diff))} />
              </dd>
            </div>
          ) : null}
          <div className="scenario-result__item">
            <dt className="scenario-result__label">{invest ? `Against your average rate` : "Currency gain/loss"}</dt>
            <dd className="scenario-result__value">
              <Money amount={toNum(invest ? row.unit_vs_avg : row.gain)} currency={data.ccy} signed colored digits={0} />
            </dd>
            {invest ? <dd className="scenario-result__note">per {euros(unit)}, against what your past euros got</dd> : null}
          </div>
          <div className="scenario-result__item">
            <dt className="scenario-result__label">Move to break even</dt>
            <dd className="scenario-result__value">
              {toBreakeven == null ? "—" : Math.abs(toBreakeven) < 0.0005 ? "None" : pctText(toBreakeven)}
            </dd>
            <dd className="scenario-result__note">
              {row.to_breakeven == null || toBreakeven == null || Math.abs(toBreakeven) < 0.00005
                ? "At break-even"
                : `${toNum(row.to_breakeven)! > 0 ? "+" : "−"}${Math.abs(toNum(row.to_breakeven)!).toFixed(4)} on ${pair}`}
            </dd>
          </div>
        </dl>
      </div>
      {invest && row.other_value != null ? (
        <p className="what-if__note">
          What you already have: your holdings are worth <Money amount={toNum(row.other_value)} currency={data.other_ccy} digits={0} /> at this rate
          {data.value_now_other != null ? (
            <>
              {" "}
              (today <Money amount={toNum(data.value_now_other)} currency={data.other_ccy} digits={0} />)
            </>
          ) : null}
          .
        </p>
      ) : null}
    </Card>
  );
}

function StressCard({ data }: { data: ScenariosDto }) {
  const stress = data.stress ?? [];
  if (!stress.length || data.value_now == null) return null;
  const words = QUOTE_WORDS[data.quote.pair];
  // EUR view: today's holdings. USD view: what the euro unit and your regular amount buy.
  const invest = data.perspective === "invest" ? data.invest : null;
  const unit = invest ? toNum(invest.unit_eur) : null;
  const monthly = invest ? toNum(invest.monthly_eur) : null;
  const euros = (n: number | null) => formatMoney(n, "EUR", { digits: 0 });
  const valueOf = (s: (typeof stress)[number]) => (invest ? s.per_unit : s.value);
  const changeOf = (s: (typeof stress)[number]) => (invest ? s.unit_change : s.change);
  const nowUnit = invest && data.rate_now && unit != null ? unit * (toNum(data.rate_now.rate) ?? 0) : null;
  const scale = Math.max(...stress.map((s) => Math.abs(toNum(changeOf(s)) ?? 0)));
  const falls = stress.filter((s) => toNum(s.shift_pct)! < 0);
  const rises = stress.filter((s) => toNum(s.shift_pct)! > 0);
  const cell = (s: (typeof stress)[number]) => (
    <tr key={s.shift_pct} className="rate-table__row">
      <th scope="row">{formatPercent(toNum(s.shift_pct), { signed: true, digits: 0 })}</th>
      <td>{formatNumber(toNum(s.rate_display), 4)}</td>
      <td>
        <Money amount={toNum(valueOf(s))} currency={data.ccy} digits={0} />
      </td>
      <td className="rate-table__delta">
        <Money amount={toNum(changeOf(s))} currency={data.ccy} signed colored digits={0} />
        <DeltaBar value={toNum(changeOf(s)) ?? 0} scale={scale} />
      </td>
      {invest ? (
        <td>
          <Money amount={toNum(s.per_monthly)} currency={data.ccy} digits={0} />
        </td>
      ) : null}
    </tr>
  );
  return (
    <Card className="what-if__stress" title={`If the ${words.mover.toLowerCase()} moves`}>
      <p className="what-if__intro">
        {invest
          ? `What ${euros(unit)} and your regular ${euros(monthly)} would buy if ${data.quote.pair} were 5, 10 or 15% different from today.`
          : `Today's holdings if ${data.quote.pair} were 5, 10 or 15% different from today.`}
      </p>
      <table className="rate-table" aria-label={invest ? `Dollars bought if ${data.quote.pair} moves` : `Holdings value if ${data.quote.pair} moves`}>
        <thead>
          <tr className="rate-table__head">
            <th scope="col">{words.mover}</th>
            <th scope="col">{data.quote.pair}</th>
            <th scope="col">{invest ? `${euros(unit)} buys` : "Worth"}</th>
            <th scope="col">Change</th>
            {invest ? <th scope="col">{euros(monthly)} buys</th> : null}
          </tr>
        </thead>
        <tbody>
          {falls.map(cell)}
          <tr className="rate-table__row rate-table__row--today">
            <th scope="row">Today</th>
            <td>{formatNumber(toNum(data.rate_now ? data.rate_now[data.quote.field] : null), 4)}</td>
            <td>
              <Money amount={invest ? nowUnit : toNum(data.value_now)} currency={data.ccy} digits={0} />
            </td>
            <td className="rate-table__delta">
              —
              <span className="delta-bar delta-bar--empty" aria-hidden />
            </td>
            {invest ? (
              <td>
                <Money amount={monthly != null && data.rate_now ? monthly * (toNum(data.rate_now.rate) ?? 0) : null} currency={data.ccy} digits={0} />
              </td>
            ) : null}
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
      <div className={clsx("what-if__groups", cushion.too_short && "what-if__groups--short")}>
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
  const invest = data.perspective === "invest";
  const euros = data.invest ? formatMoney(toNum(data.invest.monthly_eur), "EUR", { digits: 0 }) : "";
  const unitEuros = data.invest ? formatMoney(toNum(data.invest.unit_eur), "EUR", { digits: 0 }) : "";
  const cent = by.get("one_cent");
  if (cent) {
    out.push({
      key: "one_cent",
      label: `One cent of ${pair}`,
      tip: invest
        ? `How many dollars your regular ${euros} buys more or fewer if ${pair} moves by one cent from today's rate. It is a size: it can go either way.`
        : `How much your holdings' value moves if ${pair} moves by one cent from today's rate. It is a size, not a loss: it can go either way.`,
      value: (
        <>
          ±<Money amount={Math.abs(toNum(cent.value) ?? 0)} currency={data.ccy} digits={0} />
        </>
      ),
      note: invest ? `on your regular ${euros}, each way` : "each way, per cent",
    });
  }
  const be = by.get("breakeven");
  if (be) {
    out.push({
      key: "breakeven",
      label: "Break-even rate",
      tip: invest
        ? `The ${pair} rate at which the dollars you hold are worth exactly the euros you sent in.`
        : `The ${pair} rate at which your holdings carry no currency gain or loss.`,
      value: rateText(be.value_display ?? be.value, data.ccy),
      note: pair,
    });
  }
  const words = rangeWords(data.range);
  for (const [key, label, word] of [
    ["value_at_low", `${invest ? `${unitEuros} buys` : "Worth"} at ${words.low.replace(/^(Low|Today's)/, (w) => w.toLowerCase())}`, "lowest"],
    ["value_at_high", `${invest ? `${unitEuros} buys` : "Worth"} at ${words.high.replace(/^(High|Today's)/, (w) => w.toLowerCase())}`, "highest"],
  ] as const) {
    const s = by.get(key);
    if (!s) continue;
    out.push({
      key,
      label,
      tip: invest
        ? `How many dollars ${unitEuros} would buy at the ${word} ${pair} rate ${words.window}.`
        : `What your holdings would be worth at the ${word} ${pair} rate ${words.window}.`,
      value: <Money amount={toNum(s.value) ?? 0} currency={s.currency ?? data.ccy} digits={0} />,
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
      explainer={data?.perspective === "invest" ? "See what a different exchange rate would mean for the euros you send in." : "See what a different exchange rate would mean for your dollar holdings."}
      meta={windowText(data?.window, range) ?? (data?.as_of ? `As of ${formatDate(data.as_of)}` : undefined)}
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
          {/* Too short for the cushion: it becomes a short note under the table, not a
              tall empty card beside it. */}
          <div className={clsx("what-if__pair", data.cushion?.too_short && "what-if__pair--stacked")}>
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
