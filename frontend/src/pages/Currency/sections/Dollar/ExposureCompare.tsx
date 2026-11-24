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
  const since = toNum(changeOf(pos.change, field));
  const range = toNum(changeOf(pos.range_change, field));
  return {
    pair: d.quote.pair,
    now: rateText(q(pos.rate_now), field),
    average: rateText(q(pos.avg_rate), field),
    since,
    range,
  };
}

/**
 * EUR and USD one by one: the same rate seen from each side, in that side's own quote.
 * The two lenses point opposite ways (a stronger dollar helps the dollars you hold, a stronger
 * euro helps the euros you convert), so each change carries its own tag. All server figures.
 */
export function ExposureCompare({ eur, usd }: { eur: DollarDto; usd: DollarDto }) {
  const e = side(eur);
  const u = side(usd);
  const rows: { key: string; label: string; e: React.ReactNode; u: React.ReactNode }[] = [
    { key: "now", label: "Rate now", e: e.now, u: u.now },
    { key: "avg", label: "Your average", e: e.average, u: u.average },
    {
      key: "since",
      label: "Since your average",
      e: (
        <>
          {pct(e.since)} <KindTag kind={leanOf(e.since)} />
        </>
      ),
      u: (
        <>
          {pct(u.since)} <KindTag kind={leanOf(u.since)} />
        </>
      ),
    },
    ...(e.range === null && u.range === null
      ? []
      : [
          {
            key: "range",
            label: "Over this range",
            e: (
              <>
                {pct(e.range)} <KindTag kind={leanOf(e.range)} />
              </>
            ),
            u: (
              <>
                {pct(u.range)} <KindTag kind={leanOf(u.range)} />
              </>
            ),
          },
        ]),
  ];
  return (
    <Card
      className="exposure-compare"
      title={
        <span className="exposure-compare__title">
          Euros and dollars, side by side
          <InfoTip
            label="Euros and dollars, side by side"
            content="The same exchange rate from each side. In euros it is what one dollar costs and your dollars are the holding; in dollars it is what one euro buys and your euros are the ones you convert. The two moves mirror each other, so a gain on one side is a loss on the other."
          />
        </span>
      }
    >
      <table className="exposure-compare__table">
        <thead>
          <tr>
            <td />
            <th scope="col" className="exposure-compare__head">
              In euros
              <span className="exposure-compare__lens">{e.pair}</span>
            </th>
            <th scope="col" className="exposure-compare__head">
              In dollars
              <span className="exposure-compare__lens">{u.pair}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row" className="exposure-compare__row">
                {r.label}
              </th>
              <td className="exposure-compare__cell">{r.e}</td>
              <td className="exposure-compare__cell">{r.u}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
