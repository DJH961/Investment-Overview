import type { ReactNode } from "react";
import { Card } from "../../../../components/Card";
import { KindTag } from "../../../../components/CurrencySection";
import { InfoTip } from "../../../../components/InfoTip";
import { changeOf, quoteOf, type DollarDto } from "../../../../lib/queries/currencyDollar";
import { toNum } from "../../../../lib/queries/portfolio";
import { leanOf, pct, rateText } from "./quote";

/** One side's rate figures in its own quote (euros: one dollar in euros; dollars: one euro in dollars). */
function side(d: DollarDto) {
  const field = d.quote.field;
  const pos = d.position ?? {};
  const q = (v: Parameters<typeof quoteOf>[0]) => toNum(quoteOf(v, field));
  return {
    pair: d.quote.pair,
    now: rateText(q(pos.rate_now), field),
    average: rateText(q(pos.avg_rate), field),
    since: toNum(changeOf(pos.change, field)),
    range: toNum(changeOf(pos.range_change, field)),
  };
}

type Side = ReturnType<typeof side>;

const change = (v: number | null): ReactNode =>
  v === null ? (
    "–"
  ) : (
    <>
      {pct(v)} <KindTag kind={leanOf(v)} />
    </>
  );

/** One figure, two lines: the euro side on top, the dollar side below, each marked. */
function Cell({ label, eur, usd }: { label: string; eur: ReactNode; usd: ReactNode }) {
  return (
    <div className="exposure-compare__cell">
      <dt className="exposure-compare__label">{label}</dt>
      <dd className="exposure-compare__line">
        <span className="exposure-compare__mark">EUR</span>
        <span className="exposure-compare__value">{eur}</span>
      </dd>
      <dd className="exposure-compare__line">
        <span className="exposure-compare__mark">USD</span>
        <span className="exposure-compare__value">{usd}</span>
      </dd>
    </div>
  );
}

/**
 * EUR and USD one by one: the same rate seen from each side, in that side's own quote, as
 * one compact row of figures (two lines per figure). The two lenses point opposite ways (a
 * stronger dollar helps the dollars you hold, a stronger euro helps the euros you convert),
 * so the legend names them and each change carries its own tag. All server figures.
 */
export function ExposureCompare({ eur, usd }: { eur: DollarDto; usd: DollarDto }) {
  const e: Side = side(eur);
  const u: Side = side(usd);
  const hasRange = e.range !== null || u.range !== null;
  return (
    <Card
      className="exposure-compare"
      title={
        <span className="exposure-compare__title">
          The same rate, from each side
          <InfoTip
            label="The same rate, from each side"
            content="In euros the rate is what one dollar costs and your dollars are the holding; in dollars it is what one euro buys and your euros are the ones you convert. The two moves mirror each other: a stronger dollar helps the dollars you hold and hurts the euros you convert."
          />
        </span>
      }
    >
      <p className="exposure-compare__legend">
        <span>
          <span className="exposure-compare__mark">EUR</span> {e.pair}, the dollars you hold
        </span>
        <span>
          <span className="exposure-compare__mark">USD</span> {u.pair}, the euros you convert
        </span>
      </p>
      <dl className={`exposure-compare__cells${hasRange ? "" : " exposure-compare__cells--three"}`}>
        <Cell label="Rate now" eur={e.now} usd={u.now} />
        <Cell label="Your average" eur={e.average} usd={u.average} />
        <Cell label="Since your average" eur={change(e.since)} usd={change(u.since)} />
        {hasRange ? <Cell label="Over this range" eur={change(e.range)} usd={change(u.range)} /> : null}
      </dl>
    </Card>
  );
}
