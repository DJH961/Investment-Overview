import { Card } from "../../../../components/Card";
import { KindTag } from "../../../../components/CurrencySection";
import { InfoTip } from "../../../../components/InfoTip";
import { Money } from "../../../../components/Money";
import type { CurrencyEffectDto } from "../../../../lib/queries/currencyEffect";
import { toNum } from "../../../../lib/queries/portfolio";

type Kind = "tailwind" | "headwind" | "neutral" | "mixed";

/** What the rate did on one side, in that side's own currency and lens (no conversion). */
function sideEffect(d: CurrencyEffectDto): { amount: number | null; kind: Kind; basis: string } {
  const inv = d.investing ?? null;
  // USD = the deposit lens (dollars received for the euros sent in); EUR = the book lens.
  if (inv) return { amount: toNum(inv.effect), kind: inv.kind, basis: "on the euros you sent in" };
  return { amount: toNum(d.headline.effect), kind: d.headline.kind, basis: "on what you hold" };
}

/** True when the two lenses genuinely point opposite ways (one helped, the other cost). */
export function lensesDisagree(a: Kind, b: Kind): boolean {
  const sign = (k: Kind) => (k === "tailwind" ? 1 : k === "headwind" ? -1 : 0);
  return sign(a) * sign(b) < 0;
}

const VERB = { tailwind: "helped", headwind: "cost" } as const;

/**
 * EUR and USD one by one: two lens tiles, each in its own currency (euros: your book;
 * dollars: your deposits). Every figure is the server's; nothing here is converted or
 * combined. When the two lenses point opposite ways it says so in a Mixed line.
 */
export function ImpactCompare({ eur, usd }: { eur: CurrencyEffectDto; usd: CurrencyEffectDto }) {
  const e = sideEffect(eur);
  const u = sideEffect(usd);
  const mixed = lensesDisagree(e.kind, u.kind);
  const tile = (key: string, title: string, lens: string, currency: "EUR" | "USD", s: ReturnType<typeof sideEffect>) => (
    <section className="impact-compare__tile" aria-label={`${title}, ${lens}`}>
      <p className="impact-compare__eyebrow">
        {title}
        <span className="impact-compare__lens">{lens}</span>
      </p>
      <p className="impact-compare__figure" data-key={key}>
        <Money amount={s.amount} currency={currency} signed colored digits={0} />
      </p>
      <p className="impact-compare__tag">
        <KindTag kind={s.kind} />
      </p>
      <p className="impact-compare__basis">{s.basis}</p>
    </section>
  );
  return (
    <Card
      className="impact-compare"
      title={
        <span className="impact-compare__title">
          What the rate did, in each currency
          <InfoTip
            label="What the rate did, in each currency"
            content="The same range in each currency on its own. Euros look at what you hold, revalued each day; dollars look at the euros you sent into your dollar accounts. Neither is converted into the other."
          />
        </span>
      }
    >
      <div className="impact-compare__tiles">
        {tile("eur", "In euros", "your book", "EUR", e)}
        {tile("usd", "In dollars", "your deposits", "USD", u)}
      </div>
      {mixed ? (
        <p className="impact-compare__mixed" data-testid="lens-mixed">
          <KindTag kind="mixed" />
          <span>
            The same rate move {VERB[e.kind as "tailwind" | "headwind"]} your euro book and {VERB[u.kind as "tailwind" | "headwind"]} the euros you sent in:
            a stronger euro shrinks dollar holdings in euros, and makes each euro you send buy more dollars.
          </span>
        </p>
      ) : null}
    </Card>
  );
}
