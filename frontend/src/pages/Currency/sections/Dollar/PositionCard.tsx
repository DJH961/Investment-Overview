import clsx from "clsx";
import { Card } from "../../../../components/Card";
import { KindTag } from "../../../../components/CurrencySection";
import { InfoTip } from "../../../../components/InfoTip";
import { Money } from "../../../../components/Money";
import { formatDate, formatPercent } from "../../../../lib/format";
import { quoteOf, type DollarDto } from "../../../../lib/queries/currencyDollar";
import { toNum } from "../../../../lib/queries/portfolio";
import { leanOf, pct, quoteWords, rateText, share } from "./quote";

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
  const holdingsLean = leanOf(toNum(pos.change?.inverse_pct ?? null));
  const bought = q(pos.avg_rate);
  const nowRate = q(pos.rate_now);
  // A scale around both rates (half their gap either side), so the two markers read apart.
  const lo = bought !== null && nowRate !== null ? Math.min(bought, nowRate) : 0;
  const hi = bought !== null && nowRate !== null ? Math.max(bought, nowRate) : 1;
  const pad = Math.max((hi - lo) * 0.5, hi * 0.02);
  const place = (v: number) => ((v - (lo - pad)) / (hi + pad - (lo - pad))) * 100;
  const boughtAt = bought !== null ? place(bought) : 50;
  const nowAt = nowRate !== null ? place(nowRate) : 50;
  const breakeven = q(pos.breakeven);
  const breakevenDiffers = breakeven !== null && (bought === null || breakeven.toFixed(4) !== bought.toFixed(4));
  const exposure = toNum(pos.exposure_usd ?? null);
  const next = data.next_euro;

  return (
    <Card className="dollar-position" title="Your dollar position">
      <div className="dollar-position__lenses">
        <section className="dollar-position__lens" aria-label="Your holdings">
          <p className="dollar-position__eyebrow">
            Your holdings
            <span className="dollar-position__hint">a stronger dollar helps</span>
          </p>
          <p className="dollar-position__lead">
            <span className="dollar-position__lead-figure">
              <Money amount={exposure} currency="USD" digits={0} />
            </span>
            <span className="dollar-position__lead-note">
              {pos.exposure_share ? `${share(toNum(pos.exposure_share))} of your holdings` : "priced in dollars"}
              {data.ccy === "EUR" && pos.exposure_value ? (
                <>
                  {" · worth "}
                  <Money amount={toNum(pos.exposure_value)} currency="EUR" digits={0} />
                </>
              ) : null}
            </span>
          </p>
          {bought !== null && nowRate !== null ? (
            <div className="dollar-scale" role="img" aria-label={`Bought at ${rateText(bought, field)}, now ${rateText(nowRate, field)}`}>
              <div className="dollar-scale__track">
                <span
                  className={clsx("dollar-scale__gap", `dollar-scale__gap--${holdingsLean}`)}
                  style={{ left: `${Math.min(boughtAt, nowAt)}%`, width: `${Math.abs(nowAt - boughtAt)}%` }}
                />
                <span className="dollar-scale__mark" style={{ left: `${boughtAt}%` }} />
                <span className="dollar-scale__mark dollar-scale__mark--now" style={{ left: `${nowAt}%` }} />
              </div>
              <p className="dollar-scale__ends" aria-hidden>
                <span className="dollar-scale__end" style={{ left: `${boughtAt}%` }}>
                  bought
                </span>
                <span className="dollar-scale__end dollar-scale__end--now" style={{ left: `${nowAt}%` }}>
                  now
                </span>
              </p>
            </div>
          ) : null}
          <dl className="dollar-position__figs">
            <div className="dollar-position__fig">
              <dt className="dollar-position__label">Bought at</dt>
              <dd className="dollar-position__value">{rateText(q(pos.avg_rate), field)}</dd>
              <dd className="dollar-position__note">your average rate</dd>
            </div>
            <div className="dollar-position__fig">
              <dt className="dollar-position__label">Now</dt>
              <dd className="dollar-position__value">{rateText(q(pos.rate_now), field)}</dd>
              <dd className="dollar-position__note">today {pct(today, 2)}</dd>
            </div>
            <div className="dollar-position__fig">
              <dt className="dollar-position__label">Since buying</dt>
              <dd className="dollar-position__value">{pct(sinceBuying)}</dd>
              <dd className="dollar-position__note">
                <KindTag kind={holdingsLean} />
              </dd>
            </div>
            {breakevenDiffers ? (
              <div className="dollar-position__fig">
                <dt className="dollar-position__label">
                  Break-even
                  <InfoTip
                    label="Break-even"
                    content={`The rate (${quoteWords(field)}) at which the currency effect on your holdings is zero.`}
                  />
                </dt>
                <dd className="dollar-position__value">{rateText(breakeven, field)}</dd>
              </div>
            ) : null}
          </dl>
        </section>
        {next ? <NextEuro next={next} /> : null}
      </div>
    </Card>
  );
}

type NextDto = NonNullable<DollarDto["next_euro"]>;

/** Dollars one euro-notional buys over the last year (weekly), today's dot and the year-ago point marked. */
function NextEuro({ next }: { next: NextDto }) {
  const now = toNum(next.usd_now);
  const ago = toNum(next.usd_year_ago ?? null);
  const change = toNum(next.change_pct ?? null);
  const better = toNum(next.better_than_share ?? null);
  const pts = (next.spark ?? [])
    .map((p) => ({ t: Date.parse(p.t), v: toNum(p.usd) }))
    .filter((p): p is { t: number; v: number } => p.v !== null && Number.isFinite(p.t));
  // Today's spot closes the line (it can differ from the last settled day).
  if (now !== null && pts.length) pts.push({ t: pts[pts.length - 1].t + 86_400_000, v: now });
  const W = 300;
  const H = 72;
  let spark: React.ReactNode = null;
  if (pts.length > 2) {
    const vs = pts.map((p) => p.v);
    const lo = Math.min(...vs);
    const hi = Math.max(...vs);
    const room = (hi - lo) * 0.15 || 1;
    const t0 = pts[0].t;
    const t1 = pts[pts.length - 1].t;
    const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * 100;
    const y = (v: number) => 100 - ((v - (lo - room)) / (hi - lo + room * 2)) * 100;
    const d = pts.map((p, i) => `${i ? "L" : "M"}${((x(p.t) / 100) * W).toFixed(1)},${((y(p.v) / 100) * H).toFixed(1)}`).join(" ");
    const first = pts[0];
    spark = (
      <div className="dollar-spark">
        <div className="dollar-spark__plot">
          <svg
            className="dollar-spark__svg"
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`Dollars a euro buys over the last year, from ${ago !== null ? Math.round(ago) : "?"} to ${now !== null ? Math.round(now) : "?"}`}
          >
            <path className="dollar-spark__line" d={d} />
          </svg>
          <span className="dollar-spark__dot dollar-spark__dot--then" style={{ left: `${x(first.t)}%`, top: `${y(first.v)}%` }} />
          <span className="dollar-spark__dot" style={{ left: "100%", top: `${y(pts[pts.length - 1].v)}%` }} />
        </div>
        <p className="dollar-spark__ends" aria-hidden>
          <span>{next.year_ago_date ? formatDate(next.year_ago_date) : "a year ago"}</span>
          <span>now</span>
        </p>
      </div>
    );
  }
  return (
    <section className="dollar-position__lens dollar-position__lens--next" aria-label="Your next euro">
      <p className="dollar-position__eyebrow">
        Your next euro
        <span className="dollar-position__hint">a stronger euro helps</span>
      </p>
      <p className="dollar-position__lead">
        <span className="dollar-position__lead-figure">
          <Money amount={toNum(next.amount_eur)} currency="EUR" digits={0} /> buys <Money amount={now} currency="USD" digits={0} />
        </span>
        <span className="dollar-position__lead-note">at today's rate</span>
      </p>
      {spark}
      {ago !== null ? (
        <p className="dollar-position__next-sub">
          <Money amount={ago} currency="USD" digits={0} /> a year ago
          {change !== null ? (
            <>
              {" · "}
              <span className="dollar-position__next-change">{pct(change)}</span>
              {change === 0 ? null : change > 0 ? " more dollars" : " fewer dollars"}
              <KindTag kind={leanOf(change)} />
            </>
          ) : null}
        </p>
      ) : null}
      {better !== null ? (
        <div className="dollar-range">
          <div
            className="dollar-range__track"
            role="img"
            aria-label={`A euro buys more dollars today than on ${formatPercent(better, { digits: 0 })} of days since you started`}
          >
            <span className="dollar-range__fill" style={{ width: `${better * 100}%` }} />
            <span className="dollar-range__dot" style={{ left: `${Math.max(2, Math.min(98, better * 100))}%` }} />
          </div>
          <p className="dollar-range__ends" aria-hidden>
            <span>fewest dollars</span>
            <span>most dollars</span>
          </p>
          <p className="dollar-position__next-sub">Better than on {formatPercent(better, { digits: 0 })} of days since you started</p>
        </div>
      ) : null}
    </section>
  );
}
