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

function Tile({ name, lens, s }: { name: string; lens: string; s: Side }) {
  const rows: { key: string; label: string; value: ReactNode }[] = [
    { key: "now", label: "Rate now", value: s.now },
    { key: "avg", label: "Your average", value: s.average },
    {
      key: "since",
      label: "Since your average",
      value: (
        <>
          {pct(s.since)} <KindTag kind={leanOf(s.since)} />
        </>
      ),
    },
    ...(s.range === null
      ? []
      : [
          {
            key: "range",
            label: "Over this range",
            value: (
              <>
                {pct(s.range)} <KindTag kind={leanOf(s.range)} />
              </>
            ),
          },
        ]),
  ];
  return (
    <section className="exposure-compare__tile" aria-label={`${name}, ${lens}`}>
      <p className="exposure-compare__eyebrow">
        {name}
        <span className="exposure-compare__lens">{lens}</span>
        <span className="exposure-compare__pair">{s.pair}</span>
      </p>
      <dl className="exposure-compare__rows">
        {rows.map((r) => (
          <div key={r.key} className="exposure-compare__row">
            <dt className="exposure-compare__label">{r.label}</dt>
            <dd className="exposure-compare__value">{r.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * EUR and USD one by one: the same rate seen from each side, in that side's own quote.
 * The two lenses point opposite ways (a stronger dollar helps the dollars you hold, a stronger
 * euro helps the euros you convert), so each tile names its lens and its change carries its
 * own tag. All server figures.
 */
export function ExposureCompare({ eur, usd }: { eur: DollarDto; usd: DollarDto }) {
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
      <div className="exposure-compare__tiles">
        <Tile name="In euros" lens="Dollars you hold" s={side(eur)} />
        <Tile name="In dollars" lens="Euros you convert" s={side(usd)} />
      </div>
    </Card>
  );
}
