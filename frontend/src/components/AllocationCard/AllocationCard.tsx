import { useMemo } from "react";
import { Card } from "../Card";
import { ErrorState } from "../ErrorState";
import { SegmentedControl } from "../SegmentedControl";
import { Skeleton } from "../Skeleton";
import { Treemap, type TreemapItem } from "../Treemap";
import { formatMoney, formatPercent } from "../../lib/format";
import { toNum, useHoldings } from "../../lib/queries/portfolio";
import type { ReportingCurrency } from "../../lib/prefs";
import { usePersistentState } from "../../lib/usePersistentState";
import "./AllocationCard.scss";

export type AllocationView = "category" | "fund";

const isView = (v: unknown): v is AllocationView => v === "category" || v === "fund";

export interface AllocationCardProps {
  /** Reporting currency. */
  currency: ReportingCurrency;
  /** Treemap height in px (default: its own); the Overview matches it to the cards beside it. */
  height?: number;
}

const toneOf = (t: number | null): TreemapItem["tone"] =>
  t === null || t === 0 ? "neutral" : t > 0 ? "pos" : "neg";

/** Overview treemap: categories (the default) or holdings by value, tinted by today's move. */
export function AllocationCard({ currency, height }: AllocationCardProps) {
  const [view, setView] = usePersistentState<AllocationView>("overview.allocView", "category", isView);
  // Category view reads the server's per-group day %, which live ticks keep current.
  const holdings = useHoldings(currency, view === "category" ? "category" : "none");
  const items = useMemo(() => {
    const held = (holdings.data?.holdings ?? [])
      .map((h) => ({ h, value: toNum(h.value) ?? 0 }))
      .filter((x) => x.value > 0);
    if (view === "fund") {
      return held.map(({ h, value }) => {
        const t = toNum(h.today_pct);
        return {
          id: h.symbol,
          label: h.symbol,
          value,
          tone: toneOf(t),
          detail: t === null ? undefined : formatPercent(t, { signed: true }),
        };
      });
    }
    // A category's day % is the server's (REST group or live tick), never computed here.
    const groups = holdings.data?.groups ?? [];
    return groups
      .map((g) => ({ g, value: toNum(g.value) ?? 0 }))
      .filter((x) => x.value > 0)
      .map(({ g, value }) => {
        const t = toNum(g.today_pct);
        return {
          id: g.key,
          label: g.key,
          value,
          tone: toneOf(t),
          detail: t === null ? undefined : formatPercent(t, { signed: true }),
        };
      });
  }, [holdings.data, view]);

  return (
    <Card
      className="allocation-card"
      title="Allocation"
      collapsibleId="overview.allocation"
      actions={
        <SegmentedControl
          ariaLabel="Allocation view"
          size="sm"
          options={[
            { value: "category", label: "Category" },
            { value: "fund", label: "Fund" },
          ]}
          value={view}
          onChange={setView}
        />
      }
    >
      {holdings.isError && !holdings.data ? (
        <ErrorState message={holdings.error.message} onRetry={() => void holdings.refetch()} />
      ) : holdings.isPending ? (
        <Skeleton height="12rem" />
      ) : (
        <Treemap
          items={items}
          height={height}
          valueFormat={(v) => formatMoney(v, currency, { compact: true })}
          detailLabel="Today"
          ariaLabel={view === "category" ? "Categories by value" : "Holdings by value"}
        />
      )}
    </Card>
  );
}
