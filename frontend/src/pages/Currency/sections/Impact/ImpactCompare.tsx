import { Card } from "../../../../components/Card";
import { KindTag } from "../../../../components/CurrencySection";
import { InfoTip } from "../../../../components/InfoTip";
import { Money } from "../../../../components/Money";
import type { CurrencyEffectDto } from "../../../../lib/queries/currencyEffect";
import { toNum } from "../../../../lib/queries/portfolio";

type Kind = "tailwind" | "headwind" | "neutral";

/** What the rate did on one side, in that side's own currency and lens (no conversion). */
function sideEffect(d: CurrencyEffectDto): { amount: number | null; kind: Kind; basis: string } {
  const inv = d.investing ?? null;
  // USD = the deposit lens (dollars received for the euros sent in); EUR = the book lens.
  if (inv) return { amount: toNum(inv.effect), kind: inv.kind, basis: "on the euros you sent in" };
  return { amount: toNum(d.headline.effect), kind: d.headline.kind, basis: "on what you hold" };
}

/**
 * EUR and USD one by one: the same rows, each side in its own currency and its own lens
 * (euros: your book; dollars: your deposits). Every figure is the server's; nothing here is
 * converted or combined.
 */
export function ImpactCompare({ eur, usd }: { eur: CurrencyEffectDto; usd: CurrencyEffectDto }) {
  const e = sideEffect(eur);
  const u = sideEffect(usd);
  return (
    <Card
      className="impact-compare"
      title={
        <span className="impact-compare__title">
          Euros and dollars, side by side
          <InfoTip
            label="Euros and dollars, side by side"
            content="The same range in each currency on its own. Euros look at what you hold, revalued each day; dollars look at the euros you sent into your dollar accounts. Neither is converted into the other."
          />
        </span>
      }
    >
      <table className="impact-compare__table">
        <thead>
          <tr>
            <td />
            <th scope="col" className="impact-compare__head">
              In euros
              <span className="impact-compare__lens">your book</span>
            </th>
            <th scope="col" className="impact-compare__head">
              In dollars
              <span className="impact-compare__lens">your deposits</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row" className="impact-compare__row">
              What the rate did to you
            </th>
            <td className="impact-compare__cell">
              <span className="impact-compare__figure">
                <Money amount={e.amount} currency="EUR" signed colored digits={0} />
              </span>
              <KindTag kind={e.kind} />
              <span className="impact-compare__basis">{e.basis}</span>
            </td>
            <td className="impact-compare__cell">
              <span className="impact-compare__figure">
                <Money amount={u.amount} currency="USD" signed colored digits={0} />
              </span>
              <KindTag kind={u.kind} />
              <span className="impact-compare__basis">{u.basis}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </Card>
  );
}
