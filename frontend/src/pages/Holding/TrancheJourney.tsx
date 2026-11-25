import { Undo2 } from "lucide-react";
import { useState } from "react";
import { Money } from "../../components/Money";
import { Sheet } from "../../components/Sheet";
import { TrailPanel } from "../../components/MoneyTrail";
import { formatDate, formatNumber } from "../../lib/format";
import type { TrancheJourneyFields } from "../../lib/journey-types";

const n = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));

/** The 7.4 fields on a tranche row (read defensively until the generated types have them). */
export type JourneyLot = TrancheJourneyFields & { buy_id?: number | null };

/** (lane D ask) A sold lot's euro result on the tranches answer. */
export interface SoldLot {
  date: string;
  quantity: string;
  proceeds_native: string;
  /** True once its dollars went back to euros; null while they are still dollars. */
  back_in_euros: boolean | null;
  realised_eur: string | null;
  market_eur: string | null;
  currency_eur: string | null;
  conversion_cost_eur: string | null;
  conversion_id: number | null;
}

export function hasEurCost(rows: readonly JourneyLot[]): boolean {
  return rows.some((r) => r.cost_eur !== undefined);
}

/** The EUR cost and, under it, "your rate" (a button into the buy's money trail when the server names the buy). */
export function EurCost({ lot, onTrail }: { lot: JourneyLot; onTrail?: (buyId: number) => void }) {
  const rate = n(lot.your_rate);
  return (
    <>
      <Money amount={n(lot.cost_eur)} currency="EUR" digits={0} />
      <span className="holding-page__lot-sub">
        {rate === null ? (
          "ECB rate"
        ) : lot.buy_id && onTrail ? (
          <button type="button" className="holding-page__rate-link" onClick={() => onTrail(lot.buy_id!)}>
            your rate {formatNumber(rate, 4)}
          </button>
        ) : (
          `your rate ${formatNumber(rate, 4)}`
        )}
      </span>
    </>
  );
}

/** The buy's trail, from a tranche. */
export function useTrancheTrail() {
  const [buyId, setBuyId] = useState<number | null>(null);
  const sheet = (
    <Sheet open={buyId !== null} onOpenChange={(o) => !o && setBuyId(null)} title="Where these dollars came from" wide>
      {buyId !== null && <TrailPanel kind="buy" id={buyId} label="Where these dollars came from" />}
    </Sheet>
  );
  return { open: setBuyId, sheet };
}

/** Sold lots: realized in euros once their dollars went back, "still in dollars" before that. */
export function SoldLots({ lots, ccy }: { lots: readonly SoldLot[]; ccy: string }) {
  if (lots.length === 0) return null;
  return (
    <section className="holding-page__sold" aria-label="Sold lots in euros">
      <h3 className="holding-page__sold-title">Sold</h3>
      <ul className="holding-page__sold-list">
        {lots.map((l) => (
          <li key={`${l.date}-${l.quantity}`} className="holding-page__sold-row">
            <span className="holding-page__sold-what">
              {formatDate(l.date)} · <Money amount={n(l.proceeds_native)} currency={ccy} digits={0} />
            </span>
            {l.back_in_euros ? (
              <span className="holding-page__sold-result">
                <Undo2 aria-hidden className="holding-page__sold-icon" />
                realized in euros <Money amount={n(l.realised_eur)} currency="EUR" signed colored digits={0} />
                <span className="holding-page__lot-sub">
                  market <Money amount={n(l.market_eur)} currency="EUR" signed digits={0} /> · currency{" "}
                  <Money amount={n(l.currency_eur)} currency="EUR" signed digits={0} /> · cost{" "}
                  <Money amount={n(l.conversion_cost_eur)} currency="EUR" signed digits={0} />
                </span>
              </span>
            ) : (
              <span className="holding-page__sold-result holding-page__sold-result--waiting">
                still in dollars · market <Money amount={n(l.market_eur)} currency="EUR" signed colored digits={0} />
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
