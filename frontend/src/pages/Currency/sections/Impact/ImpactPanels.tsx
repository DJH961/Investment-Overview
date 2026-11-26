import clsx from "clsx";
import { ArrowDown, ArrowRight, ArrowUp } from "lucide-react";
import { useMemo, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router";
import { Card } from "../../../../components/Card";
import { Chart, type ChartSeries } from "../../../../components/Chart";
import { KindTag } from "../../../../components/CurrencySection";
import { DivergingBar } from "../../../../components/DivergingBar";
import { InfoTip } from "../../../../components/InfoTip";
import { Money } from "../../../../components/Money";
import type { StatItem } from "../../../../components/StatStrip";
import {
  chartMoneyFormat,
  formatAxisDate,
  formatDate,
  formatDayTime,
  formatMoney,
  formatNumber,
  formatPercent,
  formatShortDay,
  formatTime,
  signOf,
} from "../../../../lib/format";
import { toNum } from "../../../../lib/queries/portfolio";
import type { CurrencyEffectDto, EffectBarDto, EffectRecordDto, HoldingEffectDto } from "../../../../lib/queries/currencyEffect";
import { useTimeZone } from "../../../../lib/timezone";
import { contextUntilMs, fractionTone, pctText, ppText, spanOf } from "../../numbers";
import { compactSigned, gapWords, monthShort, periodLabel, ppDirection, ppFlat, ppSize, RETURNS_TIP, sessionsFromTimes } from "./impactFormat";
import { CurrencyBar, InvestingHeadline } from "./ImpactInvesting";

type Kind = "tailwind" | "headwind" | "neutral";
const kindOf = (v: number | null): Kind => (v === null || v === 0 ? "neutral" : v > 0 ? "tailwind" : "headwind");

/** The other currency of a side: what its currency effect is about. */
export const foreignOf = (ccy: string) => (ccy === "EUR" ? "dollar" : "euro");

// ---- headline + constant-currency chart --------------------------------------------------

/**
 * Your return in each currency as two bars from one zero; the gap between their ends is
 * the currency, hatched like the gap on the chart below. Your currency's bar is solid,
 * the other's outlined and dashed, so they differ by more than color.
 */
function ReturnBars({ eur, usd, pp, ccy }: { eur: number | null; usd: number | null; pp: number | null; ccy: string }) {
  if (eur === null || usd === null) return null;
  const rows =
    ccy === "EUR"
      ? ([
          ["EUR", eur],
          ["USD", usd],
        ] as const)
      : ([
          ["USD", usd],
          ["EUR", eur],
        ] as const);
  const lo = Math.min(0, eur, usd);
  const hi = Math.max(0, eur, usd);
  const span = hi - lo || 1;
  const at = (v: number) => ((v - lo) / span) * 100;
  const zero = at(0);
  const [mine, other] = [rows[0][1], rows[1][1]];
  const gapFrom = Math.min(at(mine), at(other));
  const gapTo = Math.max(at(mine), at(other));
  return (
    <figure
      className="return-bars"
      aria-label={`Return in EUR ${pctText(eur)}, in USD ${pctText(usd)}`}
    >
      {rows.map(([c, v], i) => (
        <div key={c} className={clsx("return-bars__row", i === 0 ? "return-bars__row--mine" : "return-bars__row--other")}>
          <span className="return-bars__label">{c} return</span>
          <span className="return-bars__track" aria-hidden>
            <span className="return-bars__zero" style={{ left: `${zero}%` }} />
            <span className="return-bars__bar" style={{ left: `${Math.min(zero, at(v))}%`, width: `${Math.abs(at(v) - zero)}%` }} />
          </span>
          <span className="return-bars__value">{pctText(v)}</span>
        </div>
      ))}
      <div className="return-bars__row return-bars__row--gap">
        <span className="return-bars__label">Currency</span>
        <span className="return-bars__track return-bars__track--bare" aria-hidden>
          <span className="return-bars__gap" style={{ left: `${gapFrom}%`, width: `${Math.max(0.8, gapTo - gapFrom)}%` }} />
        </span>
        <span className="return-bars__value">{ppText(pp)}</span>
      </div>
    </figure>
  );
}

/** How this range's change splits between the markets and the exchange rate, as one bar. */
function ShareBar({ share, market, effect, ccy }: { share: number; market: number; effect: number | null; ccy: string }) {
  const cur = Math.max(0, Math.min(1, share));
  return (
    <div className="share-bar">
      <span className="share-bar__track" aria-hidden>
        <span className="share-bar__market" style={{ width: `${(1 - cur) * 100}%` }} />
        <span className="share-bar__currency" style={{ width: `${cur * 100}%` }} />
      </span>
      <p className="share-bar__legend">
        <span className="share-bar__key share-bar__key--market">
          Markets <Money amount={market} currency={ccy} signed digits={0} />
        </span>
        <span className="share-bar__key share-bar__key--currency">
          Exchange rate <Money amount={effect} currency={ccy} signed digits={0} /> · {formatPercent(cur, { digits: 0 })} of the move
        </span>
      </p>
    </div>
  );
}

/** "euros" / "dollars" for a currency code (the plain word in a sentence). */
const ccyWords = (ccy: string) => (ccy === "EUR" ? "euros" : ccy === "USD" ? "dollars" : ccy);

/** The headline leads with the gap in points: the rate did nothing to this side's book. */
export const isGapLead = (data: CurrencyEffectDto) => data.headline.lead === "gap";


function NoteTip({ note }: { note: string | null | undefined }) {
  return note ? <InfoTip label="Why these point different ways" content={note} /> : null;
}

/**
 * The money effect leads (the EUR view, and any view whose book the rate moved): what
 * the foreign currency did to you in this side's money, the tag from that figure, and
 * the gap between the two returns in words beside it.
 */
function EffectHeadline({ data }: { data: CurrencyEffectDto }) {
  const ccy = data.ccy;
  const h = data.headline;
  const effect = toNum(h.effect);
  const share = toNum(h.currency_share ?? null);
  const market = toNum(h.market);
  const pp = toNum(h.effect_pp ?? null);
  const foreign = foreignOf(ccy);
  return (
    <div className="impact__headline">
      <p className="impact__fig-label">
        What the {foreign} did to you, in {ccyWords(ccy)}
        <InfoTip
          label="What the exchange rate did"
          content={`Each day, what you held in ${foreign}s was revalued from the day before's rate to that day's, and the results are added up over this range. The bars show your return worked out in euros and in dollars, each on its own; the gap between them is the same effect in points. ${RETURNS_TIP}`}
        />
      </p>
      <p className="impact__headline-value">
        <Money amount={effect} currency={ccy} signed colored digits={0} />
      </p>
      <p className="impact__fig-line">
        <KindTag kind={h.kind} />
        {pp !== null ? (
          <span>{gapWords(pp)}</span>
        ) : null}
        <NoteTip note={h.note} />
      </p>
      {share !== null && market !== null ? <ShareBar share={share} market={market} effect={effect} ccy={ccy} /> : null}
    </div>
  );
}

/**
 * The gap leads (the USD view of an all-dollar book: the rate never changes its dollar
 * value, so "+US$0" says nothing): how much lower or higher your result was in euros
 * than in dollars, and what the dollar did to you in euros (the EUR side's own figure).
 */
function GapHeadline({ data }: { data: CurrencyEffectDto }) {
  const h = data.headline;
  const pp = toNum(h.effect_pp ?? null);
  const other = toNum(h.other_effect ?? null);
  const otherCcy = h.other_ccy ?? null;
  const tone = fractionTone(pp);
  return (
    <div className="impact__headline">
      <p className="impact__fig-label">
        Euros against dollars
        <InfoTip
          label="Euros against dollars"
          content={`Your return worked out in euros minus the same return worked out in dollars, each in its own currency. Your holdings are all in ${ccyWords(data.ccy)}, so the exchange rate did not change their value in ${ccyWords(data.ccy)}; it changes what they are worth in the other currency. ${RETURNS_TIP}`}
        />
      </p>
      <p className={clsx("impact__headline-value", tone !== "flat" && `impact__headline-value--${tone}`)}>
        {ppText(pp ?? 0)}
      </p>
      <p className="impact__lede">
        {pp === null || ppFlat(pp)
          ? "Your result was about the same in euros and in dollars."
          : `Your result in euros was ${ppSize(pp)} ${ppDirection(pp)} than in dollars.`}
      </p>
      <p className="impact__fig-line">
        <KindTag kind={h.kind} />
        {other !== null && otherCcy && Math.round(other) !== 0 ? (
          <span>
            What the {foreignOf(otherCcy)} did to you in {ccyWords(otherCcy)}:{" "}
            <Money amount={other} currency={otherCcy} signed colored digits={0} />
          </span>
        ) : null}
        <NoteTip note={h.note} />
      </p>
    </div>
  );
}

/**
 * What the currency did over the range, then the picture of it: the actual value and
 * the value with the rate frozen at the range start; the hatched gap between them is the
 * currency effect (above: it helped, below: it cost).
 */
export function ImpactHero({ data, range, figures = [] }: { data: CurrencyEffectDto; range: string; figures?: StatItem[] }) {
  const timeZone = useTimeZone();
  const ccy = data.ccy;
  const h = data.headline;
  const inv = data.investing ?? null;
  const pts = useMemo(() => (inv ? inv.series : data.series) ?? [], [inv, data.series]);
  // The investing line is one point per deposit day, never intraday.
  const intraday = (data.window?.intraday ?? data.granularity === "intraday") && !inv;
  // Max: the days before you started are context only (never part of your figures).
  const ctx = contextUntilMs(data.window);
  const series = useMemo<ChartSeries[]>(() => {
    const own = (t: string) => ctx === null || Date.parse(t) > ctx;
    return [
      {
        id: "value",
        label: inv ? "Dollars received" : "Actual value",
        points: pts.map((p) => ({ t: p.t, v: own(p.t) ? toNum(p.value) : null })),
        tone: "primary",
      },
      {
        id: "constant",
        label: "At the start rate",
        points: pts.map((p) => ({ t: p.t, v: own(p.t) ? toNum(p.constant_currency) : null })),
        tone: "ink",
      },
    ];
  }, [pts, inv, ctx]);
  const byTime = useMemo(() => new Map(pts.map((p) => [Date.parse(p.t), toNum(p.currency)])), [pts]);
  const before = ctx !== null && pts.length > 0 && Date.parse(pts[0].t) <= ctx ? { from: pts[0].t, to: ctx } : null;
  // The real span of what is drawn, so a 1M axis reads days and a 5Y one months.
  const span = spanOf(pts.map((p) => Date.parse(p.t)));
  const timeFormat = (t: number) =>
    !intraday ? formatAxisDate(t, span) : range === "1d" ? formatTime(new Date(t), timeZone) : formatShortDay(t, timeZone);
  const tooltipTimeFormat = (t: number) =>
    !intraday ? formatDate(new Date(t), "medium") : range === "1d" ? formatTime(new Date(t), timeZone) : formatDayTime(t, timeZone);

  // 1W: the Overview's session axis, so nights and the weekend do not show as flat stretches.
  const sessions = useMemo(() => (intraday && range === "1w" ? sessionsFromTimes(pts.map((p) => Date.parse(p.t))) : []), [intraday, range, pts]);

  const gapLead = isGapLead(data);
  // The chart only says something when the rate moved this side's book.
  const showChart = pts.length > 1 && !gapLead && (!inv || inv.deposit_count > 0);

  return (
    <Card className="impact__hero">
      <div className="impact__top">
        {inv ? <InvestingHeadline data={data} inv={inv} /> : gapLead ? <GapHeadline data={data} /> : <EffectHeadline data={data} />}
        <ReturnBars eur={toNum(h.eur_return)} usd={toNum(h.usd_return)} pp={toNum(h.effect_pp ?? null)} ccy={ccy} />
      </div>
      {showChart ? (
        <Chart
          className="impact__chart"
          series={series}
          band={{ upper: "value", lower: "constant", label: "Currency effect" }}
          tooltipExtra={(t) => {
            const c = byTime.get(t);
            return c === undefined || c === null ? null : `Currency ${formatMoney(c, ccy, { signed: true, digits: 0 })}`;
          }}
          valueFormat={chartMoneyFormat(ccy, "axis")}
          xMode={intraday && range === "1d" ? "time" : sessions.length ? "session" : "date"}
          sessions={sessions}
          shade={before ? [before] : undefined}
          timeFormat={timeFormat}
          tooltipTimeFormat={tooltipTimeFormat}
          height={240}
          ariaLabel={inv ? "Dollars received, and the same euros at the start rate" : `Your value with and without the ${foreignOf(ccy)}'s moves`}
        />
      ) : null}
      {showChart ? (
        <p className="impact__caption">
          {inv
            ? "The hatched gap is what the exchange rate did to your deposits: where the line runs above the dashed one your euros bought more dollars than at the start rate, below it fewer."
            : "The hatched gap is what the exchange rate did: where the line runs above the dashed one it helped, below it it cost."}
          {before && data.window?.context_until ? ` The shaded part is before you started (until ${formatDate(data.window.context_until)}): context only, not in these figures.` : ""}
        </p>
      ) : null}
      {figures.length ? (
        <dl className="impact-facts" aria-label="More about this range">
          {figures.map((f) => (
            <div key={f.key} className="impact-facts__item">
              <dt className="impact-facts__label">
                {f.label}
                {f.tip ? <InfoTip label={f.label} content={f.tip} /> : null}
              </dt>
              <dd className="impact-facts__value">
                {f.value}
                {f.note ? <span className="impact-facts__note">{f.note}</span> : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </Card>
  );
}

// ---- bridge -------------------------------------------------------------------------------

type BridgeWithCashOut = NonNullable<CurrencyEffectDto["bridge"]> & {
  cashed_out?: string | null;
  cashed_out_eur?: string | null;
};

/**
 * Start + deposits - cash-outs + market + currency = end (exact on the server), as a
 * horizontal waterfall on one scale. The start and end bars are levels; the steps float
 * from where the previous one ended. Color names the part (currency is the gold hatch
 * of the chart above); the direction, the arrow and the sign carry gain or loss.
 */
export function BridgeCard({ data }: { data: CurrencyEffectDto }) {
  const b = data.bridge as BridgeWithCashOut | null | undefined;
  if (!b) return null;
  const ccy = data.ccy;
  const start = toNum(b.start) ?? 0;
  const dep = toNum(b.deposits) ?? 0;
  const cashOutRaw = toNum(b.cashed_out ?? (ccy === "EUR" ? b.cashed_out_eur : null));
  const showCashOut = cashOutRaw !== null && Math.round(cashOutRaw) !== 0;
  const cashOut = showCashOut ? -Math.abs(cashOutRaw) : 0;
  const mkt = toNum(b.market) ?? 0;
  const cur = toNum(b.currency) ?? 0;
  const end = toNum(b.end) ?? start + dep + cashOut + mkt + cur;
  const afterFlow = start + dep + cashOut;
  const levels = [start, start + dep, afterFlow, afterFlow + mkt, end];
  const hi = Math.max(...levels);
  const minL = Math.min(...levels);
  // A level far above zero would leave the steps as slivers: start the axis near the lowest level.
  const span = hi - minL;
  const base = minL - span * 1.5 > 0 ? minL - span * 1.5 : Math.min(minL, 0);
  const pos = (v: number) => (hi === base ? 0 : ((v - base) / (hi - base)) * 100);
  const truncated = base > 0;
  // A currency step of zero (the dollar view of an all-dollar book) is left out.
  const showCurrency = Math.round(cur) !== 0;
  const allRows: { id: string; label: string; from: number; to: number; amount: ReactNode; part: string; signed?: boolean }[] = [
    {
      id: "start",
      label: `Start ${formatDate(b.start_on)}`,
      from: base,
      to: start,
      amount: <Money amount={start} currency={ccy} digits={0} />,
      part: "level",
    },
    {
      id: "deposits",
      label: dep < 0 ? "Net withdrawals" : "Net deposits",
      from: start,
      to: start + dep,
      amount: <Money amount={dep} currency={ccy} signed digits={0} />,
      part: "deposits",
      signed: true,
    },
    ...(showCashOut
      ? [
          {
            id: "cashed_out",
            label: "Cashed out",
            from: start + dep,
            to: afterFlow,
            amount: <Money amount={cashOut} currency={ccy} signed digits={0} />,
            part: "cashed_out",
            signed: true,
          },
        ]
      : []),
    {
      id: "market",
      label: "Market",
      from: afterFlow,
      to: afterFlow + mkt,
      amount: <Money amount={mkt} currency={ccy} signed colored digits={0} />,
      part: "market",
      signed: true,
    },
    {
      id: "currency",
      label: "Currency",
      from: afterFlow + mkt,
      to: end,
      amount: <Money amount={cur} currency={ccy} signed colored digits={0} />,
      part: "currency",
      signed: true,
    },
    {
      id: "end",
      label: `End ${formatDate(b.end_on)}`,
      from: base,
      to: end,
      amount: <Money amount={end} currency={ccy} digits={0} />,
      part: "level",
    },
  ];
  const rows = showCurrency ? allRows : allRows.filter((r) => r.id !== "currency");
  const bridgeLabel = [
    "Start",
    "deposits",
    showCashOut ? "cashed out" : null,
    "market",
    showCurrency ? "currency" : null,
    "end",
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <Card
      className="impact__bridge"
      title={
        <span className="impact__title">
          From start to end
          <InfoTip
            label="From start to end"
            content={
              showCurrency
                ? `Start value, plus what you paid in${showCashOut ? ", less what you cashed out" : ""}, plus what the markets did, plus what the exchange rate did, equals the end value. Each part is valued at its own day's rate.`
                : `Start value, plus what you paid in${showCashOut ? ", less what you cashed out" : ""}, plus what the markets did, equals the end value. Your holdings are all in ${ccyWords(ccy)}, so the exchange rate adds nothing here.`
            }
          />
        </span>
      }
    >
      <ul className="bridge" aria-label={bridgeLabel}>
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
      {showCurrency ? <CurrencyParts bridge={b} ccy={ccy} /> : null}
      {truncated ? (
        <p className="impact__caption">
          The bars start at {formatMoney(base, ccy, { compact: true, narrow: true })}, not zero, so the steps stay visible.
        </p>
      ) : null}
    </Card>
  );
}

/** The currency step's parts, as the server splits it (they add up to it exactly). */
export const CURRENCY_PARTS = [
  {
    key: "revaluation",
    label: "Revaluation",
    tip: "What the rate's moves did to the dollars you already held, day by day.",
  },
  {
    key: "waiting",
    label: "While your dollars waited",
    tip: "The rate's move between converting your euros and depositing the dollars.",
  },
  {
    key: "conversion_cost",
    label: "Conversion cost",
    tip: "Fees and spread against the ECB reference when you converted. Minus means it cost you.",
  },
] as const;

/**
 * Revaluation + waiting + conversion cost = currency (exact on the server). Lines that
 * are exactly zero are left out; with a single line it would only repeat the currency step.
 */
export function CurrencyParts({ bridge, ccy }: { bridge: NonNullable<CurrencyEffectDto["bridge"]>; ccy: string }) {
  const parts = CURRENCY_PARTS.map((p) => ({ ...p, v: toNum(bridge[p.key] ?? null) })).filter(
    (p): p is (typeof p) & { v: number } => p.v !== null && p.v !== 0,
  );
  if (parts.length < 2) return null;
  return (
    <dl className="impact__parts" aria-label="The currency step in parts">
      {parts.map((p) => (
        <div key={p.key} className="impact__part" data-part={p.key}>
          <dt className="impact__part-label">
            {p.label}
            <InfoTip label={p.label} content={p.tip} />
          </dt>
          <dd className="impact__part-value">
            <Money amount={p.v} currency={ccy} signed colored digits={0} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ---- months / years -----------------------------------------------------------------------

/** Diverging bars, blue up / orange down, each with an arrow, so the sign never rests on color. */
function Bars({ bars, ccy, kind }: { bars: EffectBarDto[]; ccy: string; kind: "month" | "year" }) {
  const vals = bars.map((b) => toNum(b.currency) ?? 0);
  const maxUp = Math.max(0, ...vals);
  const maxDown = Math.max(0, ...vals.map((v) => -v));
  const max = Math.max(maxUp, maxDown);
  // One scale for both sides: the zero line sits where neither half is left empty
  // (bounded, so a lone small bar on one side still has room for its arrow).
  const up = max === 0 ? 0.5 : Math.min(0.85, Math.max(0.15, maxUp / (maxUp + maxDown || 1)));
  const yearOf = (l: string) => l.slice(0, 4);
  return (
    <ol
      className={clsx("effect-bars", `effect-bars--${kind}`, bars.length > 16 && "effect-bars--dense")}
      aria-label={kind === "month" ? "Currency effect by month" : "Currency effect by year"}
      style={{ "--effect-up": up } as CSSProperties}
    >
      {bars.map((b, i) => {
        const v = toNum(b.currency) ?? 0;
        const h = max === 0 ? 0 : (Math.abs(v) / (v > 0 ? maxUp : maxDown)) * 100;
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
              {kind === "month" ? (
                <>
                  <span className="effect-bars__name">{monthShort(b.label).slice(0, bars.length > 16 ? 1 : 3)}</span>
                  <span className="effect-bars__initial">{monthShort(b.label).slice(0, 1)}</span>
                </>
              ) : (
                b.label
              )}
              {kind === "month" && newYear ? (
                <span className="effect-bars__year">
                  <span className="effect-bars__name">{yearOf(b.label)}</span>
                  <span className="effect-bars__initial">’{yearOf(b.label).slice(2)}</span>
                </span>
              ) : null}
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
  const months = Array.from({ length: 12 }, (_, i) => monthShort(`2000-${String(i + 1).padStart(2, "0")}`).slice(0, 3));
  const years = [...grid].reverse();
  return (
    <>
      <ul className="year-totals" aria-label={`Currency effect per year, ${ccy}`}>
        {years.map((row) => {
          const total = toNum(row.total);
          const known = row.months.filter((c) => c !== null && c !== undefined);
          const helped = known.filter((c) => (toNum(c ?? null) ?? 0) > 0).length;
          return (
            <li key={row.year} className="year-totals__row">
              <span className="year-totals__year">{row.year}</span>
              <span className="year-totals__helped">
                helped {helped} of {known.length} months
              </span>
              <span className={clsx("year-totals__total", `year-totals__total--${signOf(total, 0)}`)}>{compactSigned(total, ccy)}</span>
            </li>
          );
        })}
      </ul>
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
            {years.map((row) => (
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
    </>
  );
}

export function MonthsCard({ data }: { data: CurrencyEffectDto }) {
  const months = data.months ?? [];
  const years = data.years ?? [];
  // Up to two years of months read as bars; a longer range reads as year bars, the grid keeps every month.
  const showMonths = months.length >= 2 && months.length <= 26;
  const showYears = !showMonths && years.length >= 2;
  if (!showMonths && !showYears && !(data.grid ?? []).length) return null;
  const run = data.run;
  return (
    <Card
      className="impact__months"
      title={showMonths ? "Effect by month" : "Effect by year"}
      subtitle={
        run ? (
          <span className="impact__run">
            <KindTag kind={run.kind} />
            <span className="impact__run-text">
              {run.statement.replace(/\.$/, "")}: <Money amount={toNum(run.currency)} currency={data.ccy} signed colored digits={0} /> in
              those months.
            </span>
          </span>
        ) : undefined
      }
    >
      {showMonths ? <Bars bars={months} ccy={data.ccy} kind="month" /> : null}
      {showYears ? <Bars bars={years} ccy={data.ccy} kind="year" /> : null}
      <YearGrid data={data} />
    </Card>
  );
}

// ---- rolling 12 months -------------------------------------------------------------------

export function RollingCard({ data }: { data: CurrencyEffectDto; range?: string }) {
  const pts = useMemo(() => data.rolling ?? [], [data.rolling]);
  const ctx = contextUntilMs(data.window);
  const series = useMemo<ChartSeries[]>(() => {
    const before = (t: string) => ctx !== null && Date.parse(t) <= ctx;
    const out: ChartSeries[] = [
      {
        id: "rolling",
        label: "Rolling 12 months",
        points: pts.map((p) => ({ t: p.t, v: before(p.t) ? null : toNum(p.currency) })),
        tone: "primary",
      },
    ];
    // Max: the stretch before you started, muted and dashed, never summed into your figures.
    if (pts.some((p) => before(p.t))) {
      out.push({
        id: "context",
        label: "Before you started",
        points: pts.map((p) => ({ t: p.t, v: before(p.t) ? toNum(p.currency) : null })),
        tone: "muted",
      });
    }
    return out;
  }, [pts, ctx]);
  if (pts.length < 2) return null;
  const span = spanOf(pts.map((p) => Date.parse(p.t)));
  return (
    <Card
      className="impact__rolling"
      title={
        <span className="impact__title">
          Rolling 12-month effect
          <InfoTip
            label="Rolling 12-month effect"
            content={
              data.investing
                ? "At each date, what the exchange rate did to the deposits of the twelve months before it, against the rate twelve months earlier. Above zero your euros were buying more dollars."
                : "At each date, what the exchange rate did over the twelve months before it. Above zero it was helping, below zero holding you back. It shows the effect's trend, not the rate's."
            }
          />
        </span>
      }
    >
      <Chart
        series={series}
        referenceLine={{ value: 0 }}
        valueFormat={chartMoneyFormat(data.ccy, "axis")}
        timeFormat={(t) => formatAxisDate(t, span)}
        tooltipTimeFormat={(t) => formatDate(new Date(t), "medium")}
        height={180}
        ariaLabel="Rolling 12-month currency effect"
      />
    </Card>
  );
}

// ---- records ------------------------------------------------------------------------------

export function RecordsCard({ data, dayLabel = "Day" }: { data: CurrencyEffectDto; dayLabel?: string }) {
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
  // Day, month and year as rows, best and worst side by side: six records in three lines.
  const periods = (["day", "month", "year"] as const)
    .map((p) => ({ p, best: rows.find((x) => x.id === `best_${p}`)!, worst: rows.find((x) => x.id === `worst_${p}`)! }))
    .filter(({ best, worst }) => best.rec || worst.rec);
  // A "worst" that cost nothing (or a "best" that gained nothing) is not a record: with All,
  // the first deposit sits exactly at the start rate, so its $0 would fill the cell.
  const counts = (x: (typeof rows)[number]) => {
    const v = toNum(x.rec?.currency ?? null);
    if (v === null) return false;
    return x.id.startsWith("worst_") ? v < -0.5 : v > 0.5;
  };
  const cell = (x: (typeof rows)[number]) =>
    x.rec && counts(x) ? (
      <td className="records__cell" data-record={x.id} aria-label={x.label}>
        <span className="records__amount">
          <Money amount={toNum(x.rec.currency)} currency={data.ccy} signed colored digits={0} />
        </span>
        <span className="records__when">{periodLabel(x.rec.label)}</span>
      </td>
    ) : (
      <td className="records__cell records__cell--none" title="None in this range">none</td>
    );
  return (
    <Card className="impact__records" title="Records">
      <table className="records">
        <thead>
          <tr>
            <td>
              <span className="u-sr-only">Period</span>
            </td>
            <th scope="col" className="records__head">
              Best
            </th>
            <th scope="col" className="records__head">
              Worst
            </th>
          </tr>
        </thead>
        <tbody>
          {periods.map(({ p, best, worst }) => (
            <tr key={p} className="records__row">
              <th scope="row" className="records__label">
                {p === "day" ? dayLabel : p === "month" ? "Month" : "Year"}
              </th>
              {cell(best)}
              {cell(worst)}
            </tr>
          ))}
        </tbody>
      </table>
      {life !== null && months !== null && avg !== null && Math.abs(months) >= 0.5 ? (
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
  return [...rows].sort(
    (a, b) =>
      Math.abs(toNum(b.currency) ?? 0) - Math.abs(toNum(a.currency) ?? 0) || Math.abs(toNum(b.total) ?? 0) - Math.abs(toNum(a.total) ?? 0),
  );
}

/** Price · dividends · currency = change, per holding; the currency effect drawn as a bar. */
export function HoldingsTable({ rows, ccy }: { rows: HoldingEffectDto[]; ccy: string }) {
  const fx = (h: HoldingEffectDto) => (h.native_ccy === ccy ? null : toNum(h.currency));
  const max = Math.max(0, ...rows.map((h) => Math.abs(fx(h) ?? 0)));
  const money = (v: number | null) => <Money amount={v} currency={ccy} signed colored digits={0} />;
  return (
    <div className="holding-split">
      <div className="holding-split__row holding-split__row--head" aria-hidden>
        <span className="holding-split__name">Holding</span>
        <span className="holding-split__bar holding-split__bar--head">
          <span>cost</span>
          <span>helped</span>
        </span>
        <span className="holding-split__fig holding-split__fig--fx">Currency</span>
        <span className="holding-split__fig holding-split__fig--price">Price</span>
        <span className="holding-split__fig holding-split__fig--div">Dividends</span>
        <span className="holding-split__fig holding-split__fig--total">Change</span>
      </div>
      <ul className="holding-split__list" aria-label="Change per holding: currency, price and dividends">
        {rows.map((h) => {
          const v = fx(h);
          return (
            <li key={h.instrument_id} className="holding-split__row">
              <span className="holding-split__name">
                <span className="holding-split__symbol">{h.symbol}</span>
                {h.name ? <span className="holding-split__long" data-truncate-ok>{h.name}</span> : null}
              </span>
              <span className="holding-split__bar">
                <CurrencyBar v={v} max={max} />
              </span>
              <span className="holding-split__fig holding-split__fig--fx">
                <span className="holding-split__label">Currency</span>
                {v === null ? (
                  <span className="holding-split__none" title={`Held in ${ccy}: no currency effect`}>
                    <span aria-hidden>none</span>
                    <span className="u-sr-only">, held in {ccy}</span>
                  </span>
                ) : (
                  money(v)
                )}
              </span>
              <span className="holding-split__fig holding-split__fig--price">
                <span className="holding-split__label">Price</span>
                {money(toNum(h.price))}
              </span>
              <span className="holding-split__fig holding-split__fig--div">
                <span className="holding-split__label">Dividends</span>
                {money(toNum(h.dividends))}
              </span>
              <span className="holding-split__fig holding-split__fig--total">
                <span className="holding-split__label">Change</span>
                {money(toNum(h.total))}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export const TOP_HOLDINGS = 5;

/** The holdings the exchange rate moved in this view (a zero or "none" row says nothing). */
export function withCurrencyEffect(rows: HoldingEffectDto[], ccy: string): HoldingEffectDto[] {
  return rows.filter((h) => h.native_ccy !== ccy && Math.round(toNum(h.currency) ?? 0) !== 0);
}

/** One line for a list the filter emptied. */
export function noEffectLine(rows: HoldingEffectDto[], ccy: string): string {
  return rows.every((h) => h.native_ccy === ccy)
    ? `All your holdings are in ${ccyWords(ccy)}, so the exchange rate did not change their value in ${ccyWords(ccy)}.`
    : "No holding had a currency effect in this range.";
}

export function HoldingsCard({ data, range }: { data: CurrencyEffectDto; range: string }) {
  const all = data.holdings ?? [];
  if (!all.length) return null;
  const rows = sortHoldings(withCurrencyEffect(all, data.ccy));
  if (!rows.length) {
    return (
      <Card className="impact__holdings" title="Per holding">
        <p className="impact__note">{data.holdings_note || noEffectLine(all, data.ccy)}</p>
      </Card>
    );
  }
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
            {
              id: "inside",
              label: "Market hours",
              value: inside,
              display: <Money amount={inside} currency={ccy} signed colored digits={0} />,
            },
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
      <Money amount={amount} currency="EUR" digits={Number.isInteger(amount) ? 0 : 2} /> buys{" "}
      <strong>
        <Money amount={now} currency="USD" />
      </strong>
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
