import { Card } from "../../../../components/Card";
import { EmptyState } from "../../../../components/EmptyState";
import { ErrorState } from "../../../../components/ErrorState";
import { Money } from "../../../../components/Money";
import { Skeleton } from "../../../../components/Skeleton";
import { formatDate } from "../../../../lib/format";
import { effectRangeFor, useCurrencyEffect } from "../../../../lib/queries/currencyEffect";
import { toNum } from "../../../../lib/queries/portfolio";
import type { CurrencySubPageProps } from "../../sections";
import { HoldingsTable, sortHoldings } from "./ImpactPanels";
import "./Impact.scss";

/** `/currency/holdings`: every holding's price move, dividends and currency effect over the range. */
export function ImpactHoldings({ currency, range }: CurrencySubPageProps) {
  const q = useCurrencyEffect(effectRangeFor(range), currency);
  const data = q.data;
  if (q.isError && !data) return <ErrorState title="Per-holding split could not be loaded" onRetry={() => void q.refetch()} />;
  if (!data) return <Skeleton height="20rem" />;
  const rows = sortHoldings(data.holdings ?? []);
  if (!rows.length) return <EmptyState title="No holdings in this range" />;
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
