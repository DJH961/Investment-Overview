import { Card } from "../../../../components/Card";
import { EmptyState } from "../../../../components/EmptyState";
import { ErrorState } from "../../../../components/ErrorState";
import { Money } from "../../../../components/Money";
import { Skeleton } from "../../../../components/Skeleton";
import { formatDate } from "../../../../lib/format";
import { useCurrencyEffect } from "../../../../lib/queries/currencyEffect";
import { toNum } from "../../../../lib/queries/portfolio";
import type { CurrencySubPageProps } from "../../sections";
import { DepositsTable } from "./ImpactInvesting";
import { HoldingsTable, noEffectLine, sortHoldings, withCurrencyEffect } from "./ImpactPanels";
import "./Impact.scss";

/** `/currency/holdings`: every holding's price move, dividends and currency effect over the range. */
export function ImpactHoldings({ currency, range }: CurrencySubPageProps) {
  const q = useCurrencyEffect(range, currency);
  const data = q.data;
  if (q.isError && !data) return <ErrorState title="Per-holding split could not be loaded" onRetry={() => void q.refetch()} />;
  if (!data) return <Skeleton height="20rem" />;
  const inv = data.investing;
  if (inv) {
    // The USD view: every deposit of the range against the start rate.
    const deps = inv.deposits ?? [];
    if (!deps.length) return <EmptyState title="No deposits in this range" />;
    return (
      <Card
        className="impact__holdings impact__holdings--all"
        title={`${deps.length} ${deps.length === 1 ? "deposit" : "deposits"}`}
        meta={`${formatDate(inv.start_on)} – ${formatDate(inv.end_on)}`}
      >
        <DepositsTable rows={deps} />
        <dl className="impact__sums">
          <div className="impact__sum">
            <dt className="impact__sum-label">Sent</dt>
            <dd className="impact__sum-value">
              <Money amount={toNum(inv.eur_sent)} currency="EUR" digits={0} />
            </dd>
          </div>
          <div className="impact__sum">
            <dt className="impact__sum-label">Received</dt>
            <dd className="impact__sum-value">
              <Money amount={toNum(inv.usd_received)} currency="USD" digits={0} />
            </dd>
          </div>
          <div className="impact__sum">
            <dt className="impact__sum-label">Currency</dt>
            <dd className="impact__sum-value">
              <Money amount={toNum(inv.effect)} currency="USD" signed colored digits={0} />
            </dd>
          </div>
        </dl>
      </Card>
    );
  }
  const all = data.holdings ?? [];
  if (!all.length) return <EmptyState title="No holdings in this range" />;
  // Only the holdings the exchange rate moved in this view.
  const rows = sortHoldings(withCurrencyEffect(all, data.ccy));
  if (!rows.length) return <EmptyState title="No currency effect on your holdings" description={data.holdings_note || noEffectLine(all, data.ccy)} />;
  const sum = (k: "price" | "dividends" | "currency" | "total") => rows.reduce((a, h) => a + (toNum(h[k]) ?? 0), 0);
  return (
    <Card
      className="impact__holdings impact__holdings--all"
      title={`${rows.length} holdings`}
      meta={data.start_on && data.end_on ? `${formatDate(data.start_on)} – ${formatDate(data.end_on)}` : undefined}
    >
      <HoldingsTable rows={rows} ccy={data.ccy} />
      <dl className="impact__sums">
        {(["price", "dividends", "currency", "total"] as const).map((k) => (
          <div key={k} className="impact__sum">
            <dt className="impact__sum-label">{k === "total" ? "Change" : k[0].toUpperCase() + k.slice(1)}</dt>
            <dd className="impact__sum-value">
              <Money amount={sum(k)} currency={data.ccy} signed colored digits={0} />
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
