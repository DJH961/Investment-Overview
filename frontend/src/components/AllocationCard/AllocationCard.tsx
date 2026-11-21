import { useMemo } from "react";
import { ASSET_CLASS_LOOK } from "../AssetClassCard";
import { Card } from "../Card";
import { EmptyState } from "../EmptyState";
import { ErrorState } from "../ErrorState";
import { SegmentedControl } from "../SegmentedControl";
import { Skeleton } from "../Skeleton";
import { Treemap, type TreemapItem } from "../Treemap";
import { formatMoney, formatPercent } from "../../lib/format";
import { toNum, useAllocations, useHoldings } from "../../lib/queries/portfolio";
import type { ReportingCurrency } from "../../lib/prefs";
import { usePersistentState } from "../../lib/usePersistentState";
import "./AllocationCard.scss";

export type AllocationView = "category" | "fund" | "currency";

const isView = (v: unknown): v is AllocationView => v === "category" || v === "fund" || v === "currency";

export interface AllocationCardProps {
  /** Reporting currency. */
  currency: ReportingCurrency;
  /** Treemap height in px (default: its own); the Overview matches it to the cards beside it. */
  height?: number;
}

const toneOf = (t: number | null): TreemapItem["tone"] =>
  t === null || t === 0 ? "neutral" : t > 0 ? "pos" : "neg";

/** Overview treemap: categories (the default), holdings by value, or the trading currency. */
export function AllocationCard({ currency, height }: AllocationCardProps) {
  const [view, setView] = usePersistentState<AllocationView>("overview.allocView", "category", isView);
  // Category view reads the server's per-group day %, which live ticks keep current.
  const holdings = useHoldings(currency, view === "category" ? "category" : "none");
  // Currency view (v7.2): the server's share by trading currency (the Allocations payload,
  // already loaded for the asset-class card under this one).
  const allocations = useAllocations(currency);
  const byCurrency = view === "currency";
  const source = byCurrency ? allocations : holdings;
  const items = useMemo(() => {
    if (view === "currency") {
      return (allocations.data?.current_by_currency ?? [])
        .map((b) => ({ b, value: toNum(b.value) ?? 0 }))
        .filter((x) => x.value > 0)
        .map(({ b, value }) => ({
          id: b.label,
          label: b.label,
          value,
          tone: "neutral" as const,
          detail: formatPercent(toNum(b.pct), { digits: 1 }),
        }));
    }
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
          accent: ASSET_CLASS_LOOK[h.asset_class]?.color,
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
  }, [holdings.data, allocations.data, view]);
  const note = byCurrency ? allocations.data?.currency_note : null;

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
            { value: "currency", label: "Currency" },
          ]}
          value={view}
          onChange={setView}
        />
      }
    >
      {source.isError && !source.data ? (
        <ErrorState message={source.error.message} onRetry={() => void source.refetch()} />
      ) : source.isPending ? (
        <Skeleton height="12rem" />
      ) : items.length === 0 ? (
        <EmptyState
          title="Nothing to map yet"
          description={
            view === "category"
              ? "No categories with a value. Try the Fund view."
              : view === "currency"
                ? "No holdings with a trading currency yet."
                : "No holdings with a value."
          }
        />
      ) : (
        <>
          <Treemap
            items={items}
            height={height}
            valueFormat={(v) => formatMoney(v, currency, { compact: true })}
            detailLabel={byCurrency ? "Share" : "Today"}
            ariaLabel={
              view === "category" ? "Categories by value" : byCurrency ? "Holdings by trading currency" : "Holdings by value"
            }
          />
          {note ? <p className="allocation-card__note">{note}</p> : null}
        </>
      )}
    </Card>
  );
}
