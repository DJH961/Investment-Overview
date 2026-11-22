import { Card } from "../../../../components/Card";
import { KindTag } from "../../../../components/CurrencySection";
import { InfoTip } from "../../../../components/InfoTip";
import { Money } from "../../../../components/Money";
import { formatPercent } from "../../../../lib/format";
import { changeOf, quoteOf, type DollarDto } from "../../../../lib/queries/currencyDollar";
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
  const sinceBuying = toNum(changeOf(pos.change, field));
  const today = toNum(changeOf(pos.today, field));
  // The holdings lens reads the dollar's own change, whatever the quote shown.
  const holdingsLean = leanOf(toNum(pos.change?.inverse_pct ?? null));
  const exposure = toNum(pos.exposure_usd ?? null);
  const next = data.next_euro;
  const nextChange = toNum(next?.change_pct ?? null);
  const better = toNum(next?.better_than_share ?? null);

  return (
    <Card className="dollar-position" title="Your dollar position">
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
        <dl className="dollar-position__figs">
          <div className="dollar-position__fig">
            <dt className="dollar-position__label">Bought at</dt>
            <dd className="dollar-position__value">{rateText(q(pos.avg_rate), field)}</dd>
            <dd className="dollar-position__note">your average</dd>
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
          <div className="dollar-position__fig">
            <dt className="dollar-position__label">
              FX gain/loss
              <InfoTip
                label="FX gain/loss"
                content="What the exchange rate did to your holdings since you bought them, in euros (the same figure as the Overview's lifetime card)."
              />
            </dt>
            <dd className="dollar-position__value">
              <Money amount={toNum(pos.fx_gain_eur ?? null)} currency="EUR" signed colored digits={0} />
            </dd>
          </div>
          <div className="dollar-position__fig">
            <dt className="dollar-position__label">
              Break-even
              <InfoTip
                label="Break-even"
                content={`The rate (${quoteWords(field)}) at which the currency effect on your holdings is zero.`}
              />
            </dt>
            <dd className="dollar-position__value">{rateText(q(pos.breakeven), field)}</dd>
          </div>
        </dl>
      </section>
      {next ? (
        <section className="dollar-position__lens dollar-position__lens--next" aria-label="Your next euro">
          <p className="dollar-position__eyebrow">
            Your next euro
            <span className="dollar-position__hint">a stronger euro helps</span>
          </p>
          <p className="dollar-position__next">
            <Money amount={toNum(next.amount_eur)} currency="EUR" digits={0} /> buys{" "}
            <strong className="dollar-position__next-figure">
              <Money amount={toNum(next.usd_now)} currency="USD" digits={0} />
            </strong>{" "}
            now
          </p>
          <p className="dollar-position__next-sub">
            {next.usd_year_ago ? (
              <>
                <Money amount={toNum(next.usd_year_ago)} currency="USD" digits={0} /> a year ago
                {nextChange !== null ? (
                  <>
                    {" · "}
                    <span className="dollar-position__next-change">{pct(nextChange)}</span>{" "}
                    <KindTag kind={leanOf(nextChange)} />
                  </>
                ) : null}
              </>
            ) : null}
          </p>
          {better !== null ? (
            <p className="dollar-position__next-sub">
              Better than on {formatPercent(better, { digits: 0 })} of days since you started
            </p>
          ) : null}
        </section>
      ) : null}
    </Card>
  );
}
