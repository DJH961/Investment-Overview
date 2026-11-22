import { Euro } from "lucide-react";
import { useCallback } from "react";
import { CurrencySection, serverStatItem, type StatMeta } from "../../../../components/CurrencySection";
import { InfoTip } from "../../../../components/InfoTip";
import { formatDate, formatNumber } from "../../../../lib/format";
import { RATE_RANGE_LABELS } from "../../../../lib/queries/currencyRate";
import { effectRangeFor, useCurrencyEffect, type CurrencyEffectDto, type EffectStatDto } from "../../../../lib/queries/currencyEffect";
import { toNum } from "../../../../lib/queries/portfolio";
import type { CurrencyRange } from "../../range";
import type { CurrencySectionComponentProps } from "../../sections";
import { BridgeCard, foreignOf, HoldingsCard, ImpactHero, MonthsCard, RecordsCard, RollingCard, SessionCard } from "./ImpactPanels";
import "./Impact.scss";

/** The section strip's words. The headline (returns, effect, share) is in the hero, not repeated here. */
const STAT_LABELS: Record<string, StatMeta> = {
  tailwind_share: { label: "Months it helped", tip: "The share of months in this range in which the exchange rate added value.", fractionFormat: "percent" },
  typical_day: { label: "Typical day", tip: "The middle size of a day's currency effect in this range: half the days moved less." },
  largest_day: { label: "Largest day", tip: "The day with the biggest currency effect in this range, either way." },
  months_of_contributions: { label: "In months of deposits", tip: "The lifetime currency effect divided by your average monthly deposit." },
  rate_range_today: { label: "Today's range", tip: "The lowest and highest rate today." },
  typical_month: { label: "Typical month", tip: "The middle size of a month's currency effect." },
};
/** Shown in their own panels (hero, records, run, market hours, buys): never twice. */
const ELSEWHERE = new Set([
  "eur_return",
  "usd_return",
  "effect_pp",
  "effect",
  "currency_share",
  "best_month",
  "worst_month",
  "longest_tailwind",
  "longest_headwind",
  "inside_hours",
  "outside_hours",
  "buys_now",
]);

function stripItems(stats: EffectStatDto[], ccy: string) {
  return stats
    .filter((s) => !ELSEWHERE.has(s.key))
    .map((s) => {
      // `count` figures (months) are plain numbers; a stat's own period goes in its note.
      const base = serverStatItem(
        {
          ...s,
          unit: s.unit === "count" ? "rate" : s.unit,
          secondary: s.secondary_unit === "count" ? null : s.secondary,
          secondary_unit: s.secondary_unit === "count" ? null : s.secondary_unit,
        },
        STAT_LABELS[s.key],
        ccy,
      );
      const value = s.unit === "count" ? formatNumber(toNum(s.value), 1) : base.value;
      const note =
        s.key === "tailwind_share" && s.secondary
          ? `of ${s.secondary} months`
          : s.label
            ? /^\d{4}-\d{2}-\d{2}/.test(s.label)
              ? formatDate(s.label.slice(0, 10))
              : s.label
            : base.note;
      return { ...base, value, note };
    });
}

function rangeMeta(range: CurrencyRange, data: CurrencyEffectDto | undefined): string {
  const label = RATE_RANGE_LABELS[range];
  if (!data?.start_on || !data.end_on) return label;
  const all = effectRangeFor(range) === "all";
  // 5Y / 10Y / Max are not split further than your own time: say which window this is.
  return all ? `${range === "max" ? "Max" : label}: all your time, since ${formatDate(data.start_on)}` : `${label} · ${formatDate(data.start_on)} – ${formatDate(data.end_on)}`;
}

/** Impact: what the exchange rate did to you over the page range. */
export function Impact({ id, label, currency, range }: CurrencySectionComponentProps) {
  const effectRange = effectRangeFor(range);
  const q = useCurrencyEffect(effectRange, currency);
  const { refetch: qRefetch } = q;
  const refetch = useCallback(() => void qRefetch(), [qRefetch]);
  const data = q.data;
  const shownRange = data?.range ?? effectRange;
  const intraday = data?.granularity === "intraday";
  const empty = data && (data.series ?? []).length < 2 && !data.bridge && !(data.months ?? []).length;

  return (
    <CurrencySection
      id={id}
      title={label}
      explainer={`What the ${foreignOf(currency)}'s moves added to or took from your portfolio, in ${currency === "EUR" ? "euros" : "dollars"}.`}
      meta={
        data ? (
          <span className="impact__meta">
            {rangeMeta(range, data)}
            {data.explainer ? <InfoTip label="How lifetime is counted" content={data.explainer} /> : null}
          </span>
        ) : undefined
      }
      stats={data ? stripItems(data.stats ?? [], data.ccy) : undefined}
      state={q.isError && !data ? "error" : !data ? "loading" : empty ? "empty" : "ready"}
      busy={q.isFetching && !q.isPending && q.isPlaceholderData}
      onRetry={refetch}
      emptyIcon={<Euro aria-hidden />}
      emptyTitle="No currency effect for this range"
      emptyDescription="Once you hold assets in another currency over this window, what the exchange rate did shows up here."
      skeleton={["20rem", "12rem"]}
    >
      {data ? (
        <div className="impact">
          <ImpactHero data={data} range={shownRange} />
          <div className="impact__pair">
            {intraday ? <SessionCard data={data} /> : null}
            <BridgeCard data={data} />
            {!intraday ? <RecordsCard data={data} /> : null}
          </div>
          <MonthsCard data={data} />
          <RollingCard data={data} range={shownRange} />
          <HoldingsCard data={data} range={range} />
        </div>
      ) : null}
    </CurrencySection>
  );
}
