import clsx from "clsx";
import type { ReactNode } from "react";
import { Card } from "../../../../components/Card";
import { KindTag } from "../../../../components/CurrencySection";
import { InfoTip } from "../../../../components/InfoTip";
import { Money } from "../../../../components/Money";
import { formatDate } from "../../../../lib/format";
import { quoteOf, type DollarDto } from "../../../../lib/queries/currencyDollar";
import { toNum } from "../../../../lib/queries/portfolio";
import { euroText, investDigits } from "../../numbers";
import { leanOf, pct, quoteWords, rateText, share } from "./quote";
import { SinceStarted } from "./RangeCard";

/**
 * One anatomy for both lenses, so they read as siblings: an eyebrow with a quiet hint, a
 * display headline with one quiet line, one picture (each the one that fits its story),
 * then three small figures. The rows line up across the two lenses (CSS subgrid).
 */
function Lens({
  name,
  hint,
  headline,
  note,
  visual,
  figs,
  next,
}: {
  name: string;
  hint: string;
  headline: ReactNode;
  note: ReactNode;
  visual: ReactNode;
  figs: { key: string; label: string; tip?: string; value: ReactNode; note?: ReactNode }[];
  next?: boolean;
}) {
  return (
    <section className={clsx("dollar-position__lens", next && "dollar-position__lens--next")} aria-label={name}>
      <p className="dollar-position__eyebrow">
        {name}
        <span className="dollar-position__hint">{hint}</span>
      </p>
      <p className="dollar-position__lead">
        <span className="dollar-position__lead-figure">{headline}</span>
        <span className="dollar-position__lead-note">{note}</span>
      </p>
      <div className="dollar-position__visual">{visual}</div>
      <dl className="dollar-position__figs">
        {figs.map((f) => (
          <div key={f.key} className="dollar-position__fig">
            <dt className="dollar-position__label">
              {f.label}
              {f.tip ? <InfoTip label={f.label} content={f.tip} /> : null}
            </dt>
            <dd className="dollar-position__value">{f.value}</dd>
            {f.note ? <dd className="dollar-position__note">{f.note}</dd> : null}
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * The dollar as a holding (IBKR "Forex P&L" style), through both lenses side by side:
 * "Your holdings" (what you own; a stronger dollar helps) and "Your next euro" (what you
 * convert next; a stronger euro helps). Every figure is the server's.
 */
export function PositionCard({ data }: { data: DollarDto }) {
  const field = data.quote.field;
  const pos = data.position ?? {};
  const q = (v: Parameters<typeof quoteOf>[0]) => toNum(quoteOf(v, field));
  // The holdings lens speaks of the dollar in both views; only the rates follow the quote.
  const sinceBuying = toNum(pos.change?.inverse_pct ?? null);
  const today = toNum(pos.today?.inverse_pct ?? null);
  const holdingsLean = leanOf(sinceBuying);
  const bought = q(pos.avg_rate);
  const nowRate = q(pos.rate_now);
  const breakeven = q(pos.breakeven);
  const breakevenDiffers = breakeven !== null && (bought === null || breakeven.toFixed(4) !== bought.toFixed(4));
  const exposure = toNum(pos.exposure_usd ?? null);
  const next = data.next_euro;

  if (data.ccy === "USD") {
    return (
      <Card className="dollar-position" title="Your euro position">
        <div className="dollar-position__lenses">
          <BuyingPower data={data} />
          {next ? <NextEuro next={next} data={data} /> : null}
        </div>
      </Card>
    );
  }

  return (
    <Card className="dollar-position" title="Your dollar position">
      <div className="dollar-position__lenses">
        <Lens
          name="Your holdings"
          hint="a stronger dollar helps"
          headline={<Money amount={exposure} currency="USD" digits={0} />}
          note={
            <>
              {pos.exposure_share ? `${share(toNum(pos.exposure_share))} of your holdings` : "priced in dollars"}
              {data.ccy === "EUR" && pos.exposure_value ? (
                <>
                  {" · worth "}
                  <Money amount={toNum(pos.exposure_value)} currency="EUR" digits={0} />
                </>
              ) : null}
            </>
          }
          visual={<SinceStarted data={data} lean={holdingsLean} />}
          figs={[
            { key: "bought", label: "Bought at", value: rateText(bought, field), note: "your average" },
            { key: "now", label: "Now", value: rateText(nowRate, field), note: `${pct(today)} today` },
            {
              key: "since",
              label: "Since buying",
              tip: breakevenDiffers
                ? `The dollar's change since your average rate. Break-even is ${rateText(breakeven, field)} (${quoteWords(field)}): the rate at which the currency effect on your holdings is zero.`
                : "The dollar's change since your average rate. You are back to break-even at your average rate.",
              value: pct(sinceBuying),
              note: <KindTag kind={holdingsLean} />,
            },
          ]}
        />
        {next ? <NextEuro next={next} data={data} /> : null}
      </div>
    </Card>
  );
}

/**
 * The USD view mirrored on investing: "Your buying power". You convert euros into
 * dollars, so a stronger euro helps: your average conversion rate against now (are your
 * euros buying more or fewer dollars than on average?), the rate since you started with
 * your average marked, and the change over the page range. Every figure is the server's.
 */
function BuyingPower({ data }: { data: DollarDto }) {
  const field = data.quote.field;
  const pos = data.position ?? {};
  const q = (v: Parameters<typeof quoteOf>[0]) => toNum(quoteOf(v, field));
  const vsAverage = toNum(pos.change?.rate_pct ?? null);
  const today = toNum(pos.today?.rate_pct ?? null);
  const overRange = toNum(pos.range_change?.rate_pct ?? null);
  const lean = leanOf(vsAverage);
  const other = toNum(pos.other_value ?? null);
  const figs: { key: string; label: string; tip?: string; value: ReactNode; note?: ReactNode }[] = [
    {
      key: "bought",
      label: "Your average",
      tip: "The average rate at which your euros became dollars.",
      value: rateText(q(pos.avg_rate), field),
      note: "euros into dollars",
    },
    { key: "now", label: "Now", value: rateText(q(pos.rate_now), field), note: `${pct(today)} today` },
    // 1D has no settled change of its own ("Now … today" already says it): no empty tile.
    ...(overRange === null
      ? []
      : [
    {
      key: "range",
      label: "Over this range",
      tip: "The euro's change against the dollar from the start of the chosen range to the last close: up means each euro buys more dollars.",
      value: pct(overRange),
      note: <KindTag kind={leanOf(overRange)} />,
    },
        ]),
  ];
  if (other !== null && Math.round(other) !== 0) {
    figs.push({
      key: "outside",
      label: "Held outside dollars",
      tip: "Holdings not priced in dollars, valued in dollars at today's rate.",
      value: <Money amount={other} currency="USD" digits={0} />,
      note: pos.other_share ? `${share(toNum(pos.other_share))} of your holdings` : "",
    });
  }
  return (
    <Lens
      name="Your buying power"
      hint="a stronger euro helps"
      headline={
        vsAverage === null ? (
          rateText(q(pos.rate_now), field)
        ) : (
          <>
            {pct(vsAverage)} <KindTag kind={lean} />
          </>
        )
      }
      note={
        vsAverage === null
          ? "per euro at today's rate"
          : `Each euro buys ${vsAverage < 0 ? "fewer" : "more"} dollars now than at your average rate.`
      }
      visual={<SinceStarted data={data} lean={lean} />}
      figs={figs}
    />
  );
}

type NextDto = NonNullable<DollarDto["next_euro"]>;

type Extreme = { t: number; v: number; kind: "best" | "worst" };

/**
 * "Your next euro" picture: what EUR 1,000 bought each week of the past year (server
 * points), the year-ago column outlined and today's solid, on a scale starting near the
 * year's low. The year's best and worst day (the server's 52-week high and low, as
 * EUR 1,000 x EUR/USD: linear presentation only) sit on it as small labelled points;
 * when the two are close, their labels lean apart so they never overlap.
 */
function WeekColumns({ pts, extremes, amount }: { pts: { t: number; v: number }[]; extremes: Extreme[]; amount: number }) {
  const dg = investDigits(amount);
  const vs = [...pts.map((p) => p.v), ...extremes.map((e) => e.v)];
  const max = Math.max(...vs);
  const min = Math.min(...vs);
  const base = min - (max - min) * 0.6;
  const h = (v: number) => (max === base ? 100 : ((v - base) / (max - base)) * 100);
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const x = (t: number) => Math.max(0, Math.min(100, ((t - t0) / (t1 - t0 || 1)) * 100));
  const placed = extremes.map((e) => ({ ...e, x: x(e.t), y: h(e.v) }));
  // Close together (or near an edge): anchor each label away from the other / the edge.
  const close = placed.length === 2 && Math.abs(placed[0].x - placed[1].x) < 22;
  const anchor = (e: (typeof placed)[number]): "start" | "middle" | "end" => {
    if (close) {
      const other = placed.find((o) => o !== e)!;
      return e.x >= other.x ? "start" : "end";
    }
    return e.x < 12 ? "start" : e.x > 88 ? "end" : "middle";
  };
  // A label is about a quarter of the plot wide. It sits above the tallest column under
  // it (its own span), joined to its point by a thin leader, so neighbors never cover it.
  const LABEL_SPAN = 26;
  const lift = (e: (typeof placed)[number]) => {
    const a = anchor(e);
    const lo = a === "start" ? e.x : a === "end" ? e.x - LABEL_SPAN : e.x - LABEL_SPAN / 2;
    const hi = lo + LABEL_SPAN;
    const under = pts.filter((p) => {
      const px = x(p.t);
      return px >= lo && px <= hi;
    });
    return Math.max(e.y, ...under.map((p) => h(p.v)));
  };
  return (
    <div className="next-cols">
      <p className="next-cols__caption">Each week of the past year</p>
      <div className="next-cols__frame">
        <ol className="next-cols__plot" aria-label={`What ${euroText(amount)} bought each week of the past year`}>
          {pts.map((p, i) => (
            <li
              key={p.t}
              className={clsx("next-cols__col", i === pts.length - 1 && "next-cols__col--today", i === 0 && "next-cols__col--then")}
              style={{ height: `${h(p.v)}%` }}
              title={`${formatDate(new Date(p.t).toISOString().slice(0, 10))}: $${p.v.toFixed(dg)}`}
            />
          ))}
        </ol>
        {placed.map((e) => {
          const top = lift(e);
          return (
            <span key={e.kind} className="next-cols__mark">
              {top > e.y ? (
                <span className="next-cols__leader" style={{ left: `${e.x}%`, bottom: `${e.y}%`, height: `${top - e.y}%` }} />
              ) : null}
              <span className="next-cols__point" style={{ left: `${e.x}%`, bottom: `${e.y}%` }} />
              <span
                className={clsx("next-cols__point-label", `next-cols__point-label--${anchor(e)}`)}
                style={{ left: `${e.x}%`, bottom: `${top}%` }}
              >
                {e.kind === "best" ? "best" : "worst"} <Money amount={e.v} currency="USD" digits={dg} />
              </span>
            </span>
          );
        })}
      </div>
      <p className="next-cols__ends" aria-hidden>
        <span>a year ago</span>
        <span>today</span>
      </p>
    </div>
  );
}

function NextEuro({ next, data }: { next: NextDto; data: DollarDto }) {
  const now = toNum(next.usd_now);
  const ago = toNum(next.usd_year_ago ?? null);
  const change = toNum(next.change_pct ?? null);
  const better = toNum(next.better_than_share ?? null);
  const amount = toNum(next.amount_eur) ?? 100;
  const dg = investDigits(amount);
  const pts = (next.spark ?? [])
    .map((p) => ({ t: Date.parse(p.t), v: toNum(p.usd) }))
    .filter((p): p is { t: number; v: number } => p.v !== null && Number.isFinite(p.t));
  if (now !== null && pts.length) pts.push({ t: pts[pts.length - 1].t + 86_400_000, v: now });
  // The year's best and worst day for converting: the 52-week high and low of EUR/USD.
  const w = data.trend?.week52;
  const extremes: Extreme[] = [];
  for (const pt of w ? [w.low, w.high] : []) {
    const rate = toNum(pt.rate);
    const t = Date.parse(pt.t.length === 10 ? `${pt.t}T12:00:00Z` : pt.t);
    if (rate !== null && Number.isFinite(t)) extremes.push({ t, v: rate * amount, kind: "worst" });
  }
  if (extremes.length === 2) {
    extremes.sort((p, q) => p.v - q.v);
    extremes[1].kind = "best";
  }
  return (
    <Lens
      next
      name="Your next euro"
      hint="a stronger euro helps"
      headline={
        <>
          <Money amount={toNum(next.amount_eur)} currency="EUR" digits={Number.isInteger(amount) ? 0 : 2} /> buys <Money amount={now} currency="USD" digits={dg} />
        </>
      }
      note="at today's rate"
      visual={pts.length > 2 ? <WeekColumns pts={pts} extremes={extremes.length === 2 ? extremes : []} amount={amount} /> : null}
      figs={[
        {
          key: "ago",
          label: "A year ago",
          value: ago !== null ? <Money amount={ago} currency="USD" digits={dg} /> : "–",
          note: `for the same ${euroText(amount)}`,
        },
        {
          key: "change",
          label: "Change",
          value: pct(change),
          note: <KindTag kind={leanOf(change)} />,
        },
        {
          key: "better",
          label: "Better than",
          tip: "On how many days since your first transaction a euro bought fewer dollars than it does today.",
          value: better !== null ? share(better) : "–",
          note: "of days since start",
        },
      ]}
    />
  );
}
