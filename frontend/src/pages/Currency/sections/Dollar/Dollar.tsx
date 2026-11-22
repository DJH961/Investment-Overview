import { DollarSign, Info } from "lucide-react";
import { CurrencySection } from "../../../../components/CurrencySection";
import type { StatItem } from "../../../../components/StatStrip";
import { Money } from "../../../../components/Money";
import { formatDate } from "../../../../lib/format";
import { RATE_RANGE_LABELS } from "../../../../lib/queries/currencyRate";
import { useDollar, type DollarDto, type DollarStatDto } from "../../../../lib/queries/currencyDollar";
import { toNum } from "../../../../lib/queries/portfolio";
import type { CurrencySectionComponentProps } from "../../sections";
import { PositionCard } from "./PositionCard";
import { rateText, share } from "./quote";
import { RollingPanel } from "./RollingPanel";
import { TrendPanel } from "./TrendPanel";
import "./Dollar.scss";

/** The strip: the server's figures the panels below do not already show (no duplicates). */
const STAT_META: Partial<Record<DollarStatDto["key"], { label: string; tip: string }>> = {
  low_since_start: { label: "Low since you started", tip: "The dollar's lowest rate since your first transaction, in this view's quote." },
  high_since_start: { label: "High since you started", tip: "The dollar's highest rate since your first transaction, in this view's quote." },
  avg_rate_holding: { label: "Average while holding", tip: "The average rate over the time you have held dollars (not weighted by what you bought)." },
  share_above_avg: { label: "Days above your average", tip: "The share of days since you started on which the rate was above your average rate." },
  rate_volatility: { label: "Rate swing a year", tip: "How much the rate itself typically moves in a year (annualised volatility)." },
};

function statItems(data: DollarDto): StatItem[] {
  const field = data.quote.field;
  return (data.stats ?? []).flatMap((s): StatItem[] => {
    const meta = STAT_META[s.key];
    if (!meta) return [];
    const n = toNum(s.unit === "rate" ? (s.value_display ?? s.value) : s.value);
    const value =
      s.unit === "rate" ? rateText(n, field) : s.unit === "fraction" ? share(n) : <Money amount={n} currency={s.currency ?? data.ccy} digits={0} />;
    return [{ key: s.key, label: meta.label, tip: meta.tip, value, note: s.date ? formatDate(s.date) : undefined }];
  });
}

/** The dollar: your dollars as a position, and whether the rate's move is ordinary. */
export function Dollar({ id, label, currency, range }: CurrencySectionComponentProps) {
  const q = useDollar(currency, range);
  const data = q.data;
  const state = q.isError && !data ? "error" : !data ? "loading" : !data.position?.exposure_usd && !data.trend?.regime ? "empty" : "ready";
  return (
    <CurrencySection
      id={id}
      title={label}
      explainer="Your dollars as a holding: what you own, the rate you bought at, and whether today's move is ordinary."
      meta={RATE_RANGE_LABELS[range] ? `${data?.quote.pair ?? ""} · ${range === "max" ? "since 1999" : RATE_RANGE_LABELS[range]}` : undefined}
      stats={data ? statItems(data) : undefined}
      statsLabel="The dollar at a glance"
      state={state}
      onRetry={() => void q.refetch()}
      busy={q.isFetching && !q.isPending}
      emptyIcon={<DollarSign aria-hidden />}
      emptyTitle="No dollar holdings yet"
      emptyDescription="Once you hold something priced in dollars, its position and the dollar's trend show up here."
      skeleton={["4.5rem", "18rem", "8rem"]}
      className="dollar-section"
    >
      {data ? (
        <>
          <div className="dollar-section__grid">
            <PositionCard data={data} />
            <TrendPanel data={data} />
          </div>
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
