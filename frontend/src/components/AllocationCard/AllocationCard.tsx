import { useMemo } from "react";
import { Card } from "../Card";
import { ErrorState } from "../ErrorState";
import { SegmentedControl } from "../SegmentedControl";
import { Skeleton } from "../Skeleton";
import { Treemap, type TreemapItem } from "../Treemap";
import { formatPercent } from "../../lib/format";
import { toNum, useHoldings } from "../../lib/queries/portfolio";
import type { ReportingCurrency } from "../../lib/prefs";
import { usePersistentState } from "../../lib/usePersistentState";
import "./AllocationCard.scss";

export type AllocationView = "category" | "fund";

const isView = (v: unknown): v is AllocationView => v === "category" || v === "fund";

export interface AllocationCardProps {
  /** Reporting currency. */
  currency: ReportingCurrency;
}

const toneOf = (t: number | null): TreemapItem["tone"] =>
  t === null || t === 0 ? "neutral" : t > 0 ? "pos" : "neg";

/** Overview treemap: categories (the default) or holdings by value, tinted by today's move. */
export function AllocationCard({ currency }: AllocationCardProps) {
  const holdings = useHoldings(currency);
  const [view, setView] = usePersistentState<AllocationView>("overview.allocView", "category", isView);
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
    // A category's move today: its members' moves over their value before the move.
    const cats = new Map<string, { value: number; move: number; base: number; priced: boolean }>();
    for (const { h, value } of held) {
      const c = cats.get(h.category) ?? { value: 0, move: 0, base: 0, priced: false };
      const move = toNum(h.today_move);
      c.value += value;
      if (move !== null) {
        c.move += move;
        c.base += value - move;
        c.priced = true;
      }
      cats.set(h.category, c);
    }
    return [...cats].map(([name, c]) => {
      const t = c.priced && c.base > 0 ? c.move / c.base : null;
      return {
        id: name,
        label: name,
        value: c.value,
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
        <Treemap items={items} ariaLabel={view === "category" ? "Categories by value" : "Holdings by value"} />
      )}
    </Card>
  );
}
