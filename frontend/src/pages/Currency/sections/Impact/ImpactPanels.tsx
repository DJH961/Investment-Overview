import clsx from "clsx";
import { ArrowDown, ArrowRight, ArrowUp } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Link } from "react-router";
import { Card } from "../../../../components/Card";
import { Chart, type ChartSeries } from "../../../../components/Chart";
import { KindTag } from "../../../../components/CurrencySection";
import { DivergingBar } from "../../../../components/DivergingBar";
import { InfoTip } from "../../../../components/InfoTip";
import { Money } from "../../../../components/Money";
import {
  chartMoneyFormat,
  formatAxisDate,
  formatDate,
  formatDayTime,
  formatMoney,
  formatNumber,
  formatPercent,
  formatPp,
  formatShortDay,
  formatTime,
  signOf,
} from "../../../../lib/format";
import { toNum } from "../../../../lib/queries/portfolio";
import type {
  CurrencyEffectDto,
  EffectBarDto,
  EffectRecordDto,
  HoldingEffectDto,
} from "../../../../lib/queries/currencyEffect";
import { useTimeZone } from "../../../../lib/timezone";
import { compactSigned, monthShort, periodLabel } from "./impactFormat";

type Kind = "tailwind" | "headwind" | "neutral";
const kindOf = (v: number | null): Kind => (v === null || v === 0 ? "neutral" : v > 0 ? "tailwind" : "headwind");

/** The other currency of a side: what its currency effect is about. */
export const foreignOf = (ccy: string) => (ccy === "EUR" ? "dollar" : "euro");

// ---- headline + constant-currency chart --------------------------------------------------

function HeadFigure({ label, tip, value, note }: { label: string; tip: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="impact__fig">
      <dt className="impact__fig-label">
        {label}
        <InfoTip label={label} content={tip} />
      </dt>
      <dd className="impact__fig-value">{value}</dd>
      {note ? <dd className="impact__fig-note">{note}</dd> : null}
    </div>
  );
}

/**
 * What the currency did over the range, then the picture of it: the actual value and
 * the value with the rate frozen at the range start; the hatched gap between them is the
 * currency effect (above: it helped, below: it cost).
 */
export function ImpactHero({ data, range }: { data: CurrencyEffectDto; range: string }) {
  const timeZone = useTimeZone();
  const ccy = data.ccy;
  const h = data.headline;
  const effect = toNum(h.effect);
  const share = toNum(h.currency_share);
  const pts = data.series ?? [];
  const intraday = data.granularity === "intraday";

  const series = useMemo<ChartSeries[]>(
    () => [
      { id: "value", label: "Actual value", points: pts.map((p) => ({ t: p.t, v: toNum(p.value) })), tone: "primary" },
      {
        id: "constant",
        label: "At the start rate",
        points: pts.map((p) => ({ t: p.t, v: toNum(p.constant_currency) })),
        tone: "ink",
      },
    ],
    [pts],
  );
  const byTime = useMemo(() => new Map(pts.map((p) => [Date.parse(p.t), toNum(p.currency)])), [pts]);
  const long = range === "all" || range === "3y" || range === "1y" || /^\d{4}$/.test(range);
  const timeFormat = (t: number) =>
    range === "1d" ? formatTime(new Date(t), timeZone) : range === "1w" ? formatShortDay(t, timeZone) : formatAxisDate(t, long ? Infinity : 0);
  const tooltipTimeFormat = (t: number) =>
    range === "1d" ? formatTime(new Date(t), timeZone) : range === "1w" ? formatDayTime(t, timeZone) : formatDate(new Date(t), "medium");

  return (
    <Card className="impact__hero">
      <dl className="impact__figs">
        <HeadFigure
          label="EUR return"
          tip="Your time-weighted return in euros over this range, counted from euro cashflows at their own day's rate."
          value={formatPercent(toNum(h.eur_return), { signed: true, digits: 1 })}
        />
        <HeadFigure
          label="USD return"
          tip="The same portfolio's time-weighted return in dollars, from dollar cashflows. The gap between the two is the currency."
          value={formatPercent(toNum(h.usd_return), { signed: true, digits: 1 })}
        />
        <HeadFigure
          label="Currency"
          tip="The EUR return minus the USD return, each computed on its own, and the effect in money: what the exchange rate added or took."
          value={
            <span className="impact__effect">
              <Money amount={effect} currency={ccy} signed colored digits={0} />
            </span>
          }
          note={
            <span className="impact__fig-line">
              {h.effect_pp !== null && h.effect_pp !== undefined ? <span>{formatPp(toNum(h.effect_pp), 1)}</span> : null}
              <KindTag kind={h.kind} />
            </span>
          }
        />
      </dl>
      {share !== null ? (
        <p className="impact__share">
          The currency explains <strong>{formatPercent(share, { digits: 0 })}</strong> of this period&apos;s change
          {toNum(h.market) !== null ? (
            <>
              {" "}
              (market <Money amount={toNum(h.market)} currency={ccy} signed digits={0} />)
            </>
          ) : null}
          .
        </p>
      ) : null}
      {pts.length > 1 ? (
        <Chart
          className="impact__chart"
          series={series}
          band={{ upper: "value", lower: "constant", label: "Currency effect" }}
          tooltipExtra={(t) => {
            const c = byTime.get(t);
            return c === undefined || c === null ? null : `Currency ${formatMoney(c, ccy, { signed: true, digits: 0 })}`;
          }}
          valueFormat={chartMoneyFormat(ccy, "axis")}
          xMode={intraday && range === "1d" ? "time" : "date"}
          timeFormat={timeFormat}
          tooltipTimeFormat={tooltipTimeFormat}
          height={240}
          ariaLabel={`Your value with and without the ${foreignOf(ccy)}'s moves`}
        />
      ) : null}
      {pts.length > 1 ? (
        <p className="impact__caption">
          The hatched gap is what the exchange rate did: where the line runs above the dashed one it helped, below it it cost.
        </p>
      ) : null}
    </Card>
  );
}

// ---- bridge -------------------------------------------------------------------------------

/**
 * Start + deposits + market + currency = end (exact on the server), as a horizontal
 * waterfall on one scale. The start and end bars are levels; the three steps float
 * from where the previous one ended. Colour names the part (currency is the gold hatch
 * of the chart above); the direction, the arrow and the sign carry gain or loss.
 */
export function BridgeCard({ data }: { data: CurrencyEffectDto }) {
  const b = data.bridge;
  if (!b) return null;
  const ccy = data.ccy;
  const start = toNum(b.start) ?? 0;
  const dep = toNum(b.deposits) ?? 0;
  const mkt = toNum(b.market) ?? 0;
  const cur = toNum(b.currency) ?? 0;
  const end = toNum(b.end) ?? start + dep + mkt + cur;
  const levels = [start, start + dep, start + dep + mkt, end];
  const hi = Math.max(...levels);
  const minL = Math.min(...levels);
  // A level far above zero would leave the steps as slivers: start the axis near the lowest level.
  const span = hi - minL;
  const base = minL - span * 1.5 > 0 ? minL - span * 1.5 : Math.min(minL, 0);
  const pos = (v: number) => (hi === base ? 0 : ((v - base) / (hi - base)) * 100);
  const truncated = base > 0;
  const rows: { id: string; label: string; from: number; to: number; amount: ReactNode; part: string; signed?: boolean }[] = [
    { id: "start", label: `Start ${formatDate(b.start_on)}`, from: base, to: start, amount: <Money amount={start} currency={ccy} digits={0} />, part: "level" },
    { id: "deposits", label: "Deposits", from: start, to: start + dep, amount: <Money amount={dep} currency={ccy} signed digits={0} />, part: "deposits", signed: true },
    { id: "market", label: "Market", from: start + dep, to: start + dep + mkt, amount: <Money amount={mkt} currency={ccy} signed colored digits={0} />, part: "market", signed: true },
    { id: "currency", label: "Currency", from: start + dep + mkt, to: end, amount: <Money amount={cur} currency={ccy} signed colored digits={0} />, part: "currency", signed: true },
    { id: "end", label: `End ${formatDate(b.end_on)}`, from: base, to: end, amount: <Money amount={end} currency={ccy} digits={0} />, part: "level" },
  ];
  return (
    <Card
      className="impact__bridge"
      title={
        <span className="impact__title">
          From start to end
          <InfoTip
            label="From start to end"
            content="Start value, plus what you paid in, plus what the markets did, plus what the exchange rate did, equals the end value. Each part is valued at its own day's rate."
          />
        </span>
      }
    >
      <ul className="bridge" aria-label="Start, deposits, market, currency, end">
        {rows.map((r) => {
          const a = pos(Math.min(r.from, r.to));
          const w = Math.max(0.6, Math.abs(pos(r.to) - pos(r.from)));
          const step = r.to - r.from;
          const Dir = step > 0 ? ArrowUp : ArrowDown;
          return (
            <li key={r.id} className={clsx("bridge__row", `bridge__row--${r.part}`)} data-part={r.id}>
              <span className="bridge__label">{r.label}</span>
              <span className="bridge__track" aria-hidden>
                <span className={clsx("bridge__bar", `bridge__bar--${r.part}`)} style={{ left: `${a}%`, width: `${w}%` }} />
              </span>
              <span className="bridge__amount">
                {r.signed && step !== 0 ? <Dir aria-hidden className="bridge__dir" /> : null}
                {r.amount}
              </span>
            </li>
          );
        })}
      </ul>
      {truncated ? <p className="impact__caption">The bars start at {formatMoney(base, ccy, { compact: true, narrow: true })}, not zero, so the steps stay visible.</p> : null}
    </Card>
  );
}

// ---- months / years -----------------------------------------------------------------------

/** Diverging bars, blue up / orange down, each with an arrow, so the sign never rests on colour. */
function Bars({ bars, ccy, kind }: { bars: EffectBarDto[]; ccy: string; kind: "month" | "year" }) {
  const max = Math.max(0, ...bars.map((b) => Math.abs(toNum(b.currency) ?? 0)));
  const yearOf = (l: string) => l.slice(0, 4);
  return (
    <ol className={clsx("effect-bars", `effect-bars--${kind}`, bars.length > 16 && "effect-bars--dense")} aria-label={kind === "month" ? "Currency effect by month" : "Currency effect by year"}>
      {bars.map((b, i) => {
        const v = toNum(b.currency) ?? 0;
        const h = max === 0 ? 0 : (Math.abs(v) / max) * 100;
        const tone = signOf(v, 0);
        const name = kind === "month" ? `${monthShort(b.label)} ${yearOf(b.label)}` : b.label;
        const newYear = kind === "month" && (i === 0 || yearOf(bars[i - 1].label) !== yearOf(b.label));
        return (
          <li
            key={b.label}
            className={clsx("effect-bars__col", newYear && i > 0 && "effect-bars__col--year")}
            aria-label={`${name}: ${formatMoney(v, ccy, { signed: true, digits: 0 })}`}
            title={`${name}: ${formatMoney(v, ccy, { signed: true, digits: 0 })}`}
          >
            <span className="effect-bars__half effect-bars__half--up">
              {v > 0 ? (
                <span className="effect-bars__bar effect-bars__bar--pos" style={{ height: `${h}%` }}>
                  <ArrowUp aria-hidden className="effect-bars__arrow" />
                </span>
              ) : null}
            </span>
            <span className="effect-bars__half effect-bars__half--down">
              {v < 0 ? (
                <span className="effect-bars__bar effect-bars__bar--neg" style={{ height: `${h}%` }}>
                  <ArrowDown aria-hidden className="effect-bars__arrow" />
                </span>
              ) : null}
            </span>
            <span className={clsx("effect-bars__label", tone === "flat" && "effect-bars__label--flat")} aria-hidden>
              {kind === "month" ? monthShort(b.label).slice(0, bars.length > 16 ? 1 : 3) : b.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function YearGrid({ data }: { data: CurrencyEffectDto }) {
  const grid = data.grid ?? [];
  if (!grid.length) return null;
  const ccy = data.ccy;
  const months = Array.from({ length: 12 }, (_, i) => monthShort(`2000-${String(i + 1).padStart(2, "0")}`));
  return (
    <div className="year-grid" data-scrollable>
      <table className="year-grid__table">
        <caption className="year-grid__caption">Currency effect per month and year, {ccy}</caption>
        <thead>
          <tr>
            <th scope="col" className="year-grid__head year-grid__head--year">
              Year
            </th>
            {months.map((m) => (
              <th key={m} scope="col" className="year-grid__head">
                {m}
              </th>
            ))}
            <th scope="col" className="year-grid__head year-grid__head--total">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {[...grid].reverse().map((row) => (
            <tr key={row.year}>
              <th scope="row" className="year-grid__year">
                {row.year}
              </th>
              {row.months.map((cell, i) => {
                const v = toNum(cell ?? null);
                return (
                  <td key={i} className={clsx("year-grid__cell", v !== null && `year-grid__cell--${signOf(v, 0)}`)}>
                    {v === null ? <span className="year-grid__none">·</span> : compactSigned(v, ccy)}
                  </td>
                );
              })}
              <td className={clsx("year-grid__cell year-grid__cell--total", `year-grid__cell--${signOf(toNum(row.total), 0)}`)}>
                {compactSigned(toNum(row.total), ccy)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MonthsCard({ data }: { data: CurrencyEffectDto }) {
  const months = data.months ?? [];
  const years = data.years ?? [];
  // Up to two years of months read as bars; a longer range reads as year bars, the grid keeps every month.
  const showMonths = months.length >= 2 && months.length <= 26;
  const showYears = !showMonths && years.length >= 2;
  if (!showMonths && !showYears && !(data.grid ?? []).length) return null;
  const helped = (showMonths ? months : years).filter((b) => (toNum(b.currency) ?? 0) > 0).length;
  const n = (showMonths ? months : years).length;
  return (
    <Card
      className="impact__months"
      title={showMonths ? "Effect by month" : "Effect by year"}
      meta={n > 0 ? `${foreignOf(data.ccy) === "dollar" ? "The dollar" : "The euro"} helped in ${helped} of ${n}` : undefined}
    >
      {showMonths ? (
        <div className="effect-bars-scroll" role="region" tabIndex={0} aria-label="Currency effect by month">
          <p className="effect-bars-scroll__hint">Swipe sideways to see all months</p>
          <div className="effect-bars-scroll__viewport" data-scrollable>
            <Bars bars={months} ccy={data.ccy} kind="month" />
          </div>
        </div>
      ) : null}
      {showYears ? <Bars bars={years} ccy={data.ccy} kind="year" /> : null}
      <YearGrid data={data} />
    </Card>
  );
}

// ---- rolling 12 months -------------------------------------------------------------------

export function RollingCard({ data, range }: { data: CurrencyEffectDto; range: string }) {
  const pts = data.rolling ?? [];
  const series = useMemo<ChartSeries[]>(
    () => [{ id: "rolling", label: "Rolling 12 months", points: pts.map((p) => ({ t: p.t, v: toNum(p.currency) })), tone: "primary" }],
    [pts],
  );
  if (pts.length < 2) return null;
  const run = data.run;
  const long = range === "all" || range === "3y" || range === "1y";
  return (
    <Card
      className="impact__rolling"
      title={
        <span className="impact__title">
          Rolling 12-month effect
          <InfoTip
            label="Rolling 12-month effect"
            content="At each date, what the exchange rate did over the twelve months before it. Above zero it was helping, below zero holding you back. It shows the effect's trend, not the rate's."
          />
        </span>
      }
    >
      {run ? (
        <p className="impact__run">
          <KindTag kind={run.kind} />
          {" "}
          <span>{run.statement}</span>
          <Money amount={toNum(run.currency)} currency={data.ccy} signed colored digits={0} />
        </p>
      ) : null}
      <Chart
        series={series}
        referenceLine={{ value: 0 }}
        valueFormat={chartMoneyFormat(data.ccy, "axis")}
        timeFormat={(t) => formatAxisDate(t, long ? Infinity : 0)}
        tooltipTimeFormat={(t) => formatDate(new Date(t), "medium")}
        height={180}
        ariaLabel="Rolling 12-month currency effect"
      />
    </Card>
  );
}

// ---- records ------------------------------------------------------------------------------

export function RecordsCard({ data }: { data: CurrencyEffectDto }) {
  const r = data.records;
  const rows: { id: string; label: string; rec: EffectRecordDto | null | undefined }[] = [
    { id: "best_day", label: "Best day", rec: r?.best_day },
    { id: "worst_day", label: "Worst day", rec: r?.worst_day },
    { id: "best_month", label: "Best month", rec: r?.best_month },
    { id: "worst_month", label: "Worst month", rec: r?.worst_month },
    { id: "best_year", label: "Best year", rec: r?.best_year },
    { id: "worst_year", label: "Worst year", rec: r?.worst_year },
  ];
  const shown = rows.filter((x) => x.rec);
  const life = toNum(r?.lifetime_effect);
  const months = toNum(r?.lifetime_months_of_contributions);
  const avg = toNum(r?.average_monthly_contribution);
  if (!shown.length) return null;
  return (
    <Card className="impact__records" title="Records">
      <dl className="records">
        {shown.map((x) => (
          <div key={x.id} className="records__row" data-record={x.id}>
            <dt className="records__label">{x.label}</dt>
            <dd className="records__when">{periodLabel(x.rec!.label)}</dd>
            <dd className="records__amount">
              <Money amount={toNum(x.rec!.currency)} currency={data.ccy} signed colored digits={0} />
            </dd>
          </div>
        ))}
      </dl>
      {life !== null && months !== null && avg !== null ? (
        <p className="records__life">
          Since you started: <Money amount={life} currency={data.ccy} signed colored digits={0} />, about{" "}
          <strong>{formatNumber(Math.abs(months), 1)}</strong> {Math.abs(months) === 1 ? "month" : "months"} of deposits (
          <Money amount={avg} currency={data.ccy} digits={0} /> a month).
        </p>
      ) : null}
    </Card>
  );
}

// ---- per holding --------------------------------------------------------------------------

export function sortHoldings(rows: HoldingEffectDto[]): HoldingEffectDto[] {
  return [...rows].sort((a, b) => Math.abs(toNum(b.currency) ?? 0) - Math.abs(toNum(a.currency) ?? 0) || Math.abs(toNum(b.total) ?? 0) - Math.abs(toNum(a.total) ?? 0));
}

/** Price gain · dividends · currency = change, per holding. Phones: one row per holding, figures under the name. */
export function HoldingsTable({ rows, ccy }: { rows: HoldingEffectDto[]; ccy: string }) {
  return (
    <div className="holding-split-scroll" role="region" tabIndex={0} aria-label="Per-holding currency effect table">
      <p className="holding-split-scroll__hint">Swipe sideways to see all columns</p>
      <div className="holding-split-scroll__viewport" data-scrollable>
      <table className="holding-split">
      <thead>
        <tr>
          <th scope="col" className="holding-split__head holding-split__head--name">
            Holding
          </th>
          <th scope="col" className="holding-split__head">
            Price
          </th>
          <th scope="col" className="holding-split__head">
            Dividends
          </th>
          <th scope="col" className="holding-split__head">
            Currency
          </th>
          <th scope="col" className="holding-split__head">
            Change
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((h) => (
          <tr key={h.instrument_id} className="holding-split__row">
            <th scope="row" className="holding-split__name">
              <span className="holding-split__symbol">{h.symbol}</span>
              {h.name ? <span className="holding-split__long">{h.name}</span> : null}
            </th>
            <td className="holding-split__cell" data-label="Price">
              <Money amount={toNum(h.price)} currency={ccy} signed colored digits={0} />
            </td>
            <td className="holding-split__cell" data-label="Dividends">
              <Money amount={toNum(h.dividends)} currency={ccy} signed colored digits={0} />
            </td>
            <td className="holding-split__cell holding-split__cell--fx" data-label="Currency">
              {h.native_ccy === ccy ? (
                <span className="holding-split__none" title={`Held in ${ccy}: no currency effect`}>
                  none
                </span>
              ) : (
                <Money amount={toNum(h.currency)} currency={ccy} signed colored digits={0} />
              )}
            </td>
            <td className="holding-split__cell holding-split__cell--total" data-label="Change">
              <Money amount={toNum(h.total)} currency={ccy} signed colored digits={0} />
            </td>
          </tr>
        ))}
      </tbody>
      </table>
      </div>
    </div>
  );
}

export const TOP_HOLDINGS = 5;

export function HoldingsCard({ data, range }: { data: CurrencyEffectDto; range: string }) {
  const rows = sortHoldings(data.holdings ?? []);
  if (!rows.length) return null;
  const more = rows.length > TOP_HOLDINGS;
  return (
    <Card
      className="impact__holdings"
      title={
        <span className="impact__title">
          Per holding
          <InfoTip
            label="Per holding"
            content="Each holding's change over this range in three parts: its price move, the dividends it paid (each at its own day's rate) and what the exchange rate did to it."
          />
        </span>
      }
      meta={more ? `Top ${TOP_HOLDINGS} of ${rows.length} by currency effect` : undefined}
    >
      <HoldingsTable rows={rows.slice(0, TOP_HOLDINGS)} ccy={data.ccy} />
      {more ? (
        <Link className="impact__more" to={`/currency/holdings?range=${range}`}>
          Show all {rows.length} <ArrowRight aria-hidden className="impact__more-icon" />
        </Link>
      ) : null}
    </Card>
  );
}

// ---- 1D / 1W: market hours and investing power ---------------------------------------------

export function SessionCard({ data }: { data: CurrencyEffectDto }) {
  const split = data.session_split;
  const buys = data.buys;
  if (!split && !buys) return null;
  const ccy = data.ccy;
  const inside = toNum(split?.inside);
  const outside = toNum(split?.outside);
  const uncovered = toNum(split?.uncovered_currency);
  return (
    <Card
      className="impact__session"
      title={
        <span className="impact__title">
          When it happened
          <InfoTip
            label="When it happened"
            content="The currency effect while US markets were open, and while they were closed (evenings, nights, weekends). Recorded from each session's opening and closing rate."
          />
        </span>
      }
    >
      {split && inside !== null && outside !== null ? (
        <DivergingBar
          ariaLabel="Currency effect inside and outside US market hours"
          rows={[
            { id: "inside", label: "Market hours", value: inside, display: <Money amount={inside} currency={ccy} signed colored digits={0} /> },
            {
              id: "outside",
              label: "Outside market hours",
              value: outside,
              striped: true,
              display: <Money amount={outside} currency={ccy} signed colored digits={0} />,
            },
          ]}
        />
      ) : null}
      {split?.note && split.available_from ? (
        <p className="impact__note">
          Split not available before {formatDate(split.available_from)}
          {uncovered !== null && uncovered !== 0 ? (
            <>
              {" "}
              (<Money amount={uncovered} currency={ccy} signed digits={0} /> before then)
            </>
          ) : null}
          .
        </p>
      ) : null}
      {buys ? <BuysLine buys={buys} /> : null}
    </Card>
  );
}

function BuysLine({ buys }: { buys: NonNullable<CurrencyEffectDto["buys"]> }) {
  const amount = toNum(buys.amount_eur);
  const now = toNum(buys.usd_now);
  const prev = toNum(buys.usd_prev);
  const change = toNum(buys.change_usd);
  return (
    <p className="impact__buys">
      <Money amount={amount} currency="EUR" digits={0} /> buys <strong><Money amount={now} currency="USD" /></strong>
      {prev !== null ? (
        <>
          {" "}
          · yesterday <Money amount={prev} currency="USD" />
        </>
      ) : null}
      {change !== null ? (
        <>
          {" "}
          (<Money amount={change} currency="USD" signed colored />)
        </>
      ) : null}
    </p>
  );
}

export { kindOf };
