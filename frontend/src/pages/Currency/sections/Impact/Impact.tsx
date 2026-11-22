import { Euro } from "lucide-react";
import { useCallback } from "react";
import { CurrencySection, serverStatItem, type StatMeta } from "../../../../components/CurrencySection";
import { InfoTip } from "../../../../components/InfoTip";
import { Money } from "../../../../components/Money";
import type { StatItem } from "../../../../components/StatStrip";
import { formatDate, formatNumber, formatPercent } from "../../../../lib/format";
import { RATE_RANGE_LABELS } from "../../../../lib/queries/currencyRate";
import { effectRangeFor, useCurrencyEffect, type CurrencyEffectDto, type EffectStatDto } from "../../../../lib/queries/currencyEffect";
import { toNum } from "../../../../lib/queries/portfolio";
import type { CurrencyRange } from "../../range";
import type { CurrencySectionComponentProps } from "../../sections";
import { BridgeCard, foreignOf, HoldingsCard, ImpactHero, MonthsCard, RecordsCard, RollingCard, SessionCard } from "./ImpactPanels";
import "./Impact.scss";

/** The section's secondary figures' words (the hero carries the returns and the effect). */
const STAT_LABELS: Record<string, StatMeta> = {
  tailwind_share: { label: "Months it helped", tip: "In how many of this range's months the exchange rate added value." },
  typical_day: {
    label: "Typical day",
    tip: "The middle size of a day's currency effect in this range, either way: half the days moved less.",
  },
  largest_day: { label: "Largest day", tip: "The day with the biggest currency effect in this range, either way." },
  rate_range_today: { label: "Today's range", tip: "The lowest and highest rate today." },
  typical_month: { label: "Typical month", tip: "The middle size of a month's currency effect, either way." },
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
  "months_of_contributions",
]);
/** Sizes, not gains: shown as ± without a sign or colour. */
const UNSIGNED = new Set(["typical_day", "typical_month"]);

export function stripItems(stats: EffectStatDto[], ccy: string): StatItem[] {
  return stats
    .filter((s) => !ELSEWHERE.has(s.key) && STAT_LABELS[s.key])
    .map((s) => {
      const meta = STAT_LABELS[s.key];
      if (s.key === "tailwind_share") {
        const n = toNum(s.secondary ?? null);
        const share = toNum(s.value) ?? 0;
        // A count of months reads better than a share of them.
        const value = n !== null && n > 0 ? `${Math.round(share * n)} of ${formatNumber(n, 0)}` : formatPercent(share, { digits: 0 });
        return { key: s.key, label: meta.label, tip: meta.tip, value };
      }
      if (UNSIGNED.has(s.key)) {
        const v = toNum(s.value);
        return {
          key: s.key,
          label: meta.label,
          tip: meta.tip,
          value:
            v === null ? (
              "–"
            ) : (
              <>
                ±<Money amount={Math.abs(v)} currency={s.currency ?? ccy} digits={0} />
              </>
            ),
        };
      }
      // Left after the special cases: money and rate figures (no counts reach here).
      const base = serverStatItem(
        { ...s, unit: s.unit === "count" ? "rate" : s.unit, secondary_unit: s.secondary_unit === "count" ? null : s.secondary_unit },
        meta,
        ccy,
      );
      const note = s.label && /^\d{4}-\d{2}-\d{2}/.test(s.label) ? formatDate(s.label.slice(0, 10)) : base.note;
      return { ...base, note };
    });
}

function rangeMeta(range: CurrencyRange, data: CurrencyEffectDto | undefined): string {
  const label = RATE_RANGE_LABELS[range];
  if (!data?.start_on || !data.end_on) return label;
  const all = effectRangeFor(range) === "all";
  // 5Y / 10Y / Max are not split further than your own time: say which window this is.
  return all
    ? `${range === "max" ? "Max" : label}: all your time, since ${formatDate(data.start_on)}`
    : `${label} · ${formatDate(data.start_on)} – ${formatDate(data.end_on)}`;
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
          <ImpactHero data={data} range={shownRange} figures={stripItems(data.stats ?? [], data.ccy)} />
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
