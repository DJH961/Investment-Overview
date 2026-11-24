import { DollarSign, Info } from "lucide-react";
import { CurrencySection } from "../../../../components/CurrencySection";
import { RATE_RANGE_LABELS } from "../../../../lib/queries/currencyRate";
import { useDollar, useDollarBoth } from "../../../../lib/queries/currencyDollar";
import { ExposureCompare } from "./ExposureCompare";
import { windowText } from "../../numbers";
import type { CurrencySectionComponentProps } from "../../sections";
import { PositionCard } from "./PositionCard";
import { RollingPanel } from "./RollingPanel";
import { TrendPanel } from "./TrendPanel";
import "./Dollar.scss";
import "./ExposureCompare.scss";

/** The dollar: where it stands since you started, your position, and whether the rate's move is ordinary. */
export function Dollar({ id, label, currency, range }: CurrencySectionComponentProps) {
  const q = useDollar(currency, range);
  const data = q.data;
  const both = useDollarBoth(range).data;
  const state = q.isError && !data ? "error" : !data ? "loading" : !data.position?.exposure_usd && !data.trend?.regime ? "empty" : "ready";
  return (
    <CurrencySection
      id={id}
      title={label}
      explainer={
        currency === "USD"
          ? "Your euros as buying power: your average conversion rate against now, what your next euro buys, and whether the rate's move is ordinary."
          : "Your dollars as a holding: what you own, the rate you bought at, and whether today's move is ordinary."
      }
      meta={data ? [data.quote.pair, windowText(data.window, range) ?? RATE_RANGE_LABELS[range]].filter(Boolean).join(" · ") : undefined}
      state={state}
      onRetry={() => void q.refetch()}
      busy={q.isFetching && !q.isPending}
      emptyIcon={<DollarSign aria-hidden />}
      emptyTitle="No dollar holdings yet"
      emptyDescription="Once you hold something priced in dollars, its position and the dollar's trend show up here."
      skeleton={["8rem", "14rem", "18rem"]}
      className="dollar-section"
    >
      {data ? (
        <>
          <PositionCard data={data} />
          {both?.EUR && both.USD ? <ExposureCompare eur={both.EUR} usd={both.USD} /> : null}
          <TrendPanel data={data} />
          <RollingPanel data={data} />
          <p className="dollar-section__caption">
            <Info aria-hidden className="dollar-section__caption-icon" />
            {data.caption}
          </p>
        </>
      ) : null}
    </CurrencySection>
  );
}
