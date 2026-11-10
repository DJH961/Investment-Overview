import clsx from "clsx";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { AllocationBar } from "../../components/AllocationBar";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Money } from "../../components/Money";
import { Percent } from "../../components/Percent";
import { SegmentedControl } from "../../components/SegmentedControl";
import { assetClassLabel, formatPercent, formatPp } from "../../lib/format";
import type { ReportingCurrency } from "../../lib/prefs";
import type { AllocationsData } from "../../lib/queries/allocations";
import { usePersistentState } from "../../lib/usePersistentState";

type DriftRow = AllocationsData["drift"][number];
type CategoryRow = NonNullable<AllocationsData["drift_by_category"]>[number];
export type DriftView = "category" | "fund";

const isView = (v: unknown): v is DriftView => v === "category" || v === "fund";

/** Rows shown before "Show all" (the largest drifts first). */
const FOLD_AT = 8;
/** The stacked bar only reads well with a handful of distinct colours. */
const BAR_MAX = 6;

/** Share now (fill) against its target (marker), on a scale shared by the whole list. */
export function NowTargetBar({ now, target, scale }: { now: number; target: number | null; scale: number }) {
  const pos = (v: number) => `${Math.min((v / (scale || 1)) * 100, 100)}%`;
  return (
    <span className="allocations__meter" aria-hidden>
      <span className="allocations__meter-fill" style={{ width: pos(now) }} />
      {target !== null && <span className="allocations__meter-target" style={{ left: pos(target) }} />}
    </span>
  );
}

/** Drift arrives in percentage points ("-1.2"); the shared formatter takes a ratio. */
const pp = (v: string) => formatPp(Number(v) / 100, 1);

interface LineProps {
  id: string;
  label: string;
  sub?: string;
  current: string;
  target: string;
  drift: string;
  delta?: string | null;
  scale: number;
  ccy: ReportingCurrency;
  nested?: boolean;
  toggle?: { open: boolean; onToggle: () => void; controls: string };
}

function DriftLine({ id, label, sub, current, target, drift, delta, scale, ccy, nested, toggle }: LineProps) {
  const off = Math.abs(Number(drift));
  return (
    <li className={clsx("allocations__drift-row", nested && "allocations__drift-row--nested")} data-row={id}>
      <span className="allocations__drift-who">
        {toggle ? (
          <button
            type="button"
            className="allocations__drift-toggle"
            aria-expanded={toggle.open}
            aria-controls={toggle.controls}
            onClick={toggle.onToggle}
          >
            <ChevronRight
              className={clsx("allocations__drift-chevron", toggle.open && "allocations__drift-chevron--open")}
              aria-hidden
            />
            <span className="allocations__drift-label">{label}</span>
          </button>
        ) : (
          <span className="allocations__drift-label">{label}</span>
        )}
        {sub && <span className="allocations__drift-sub">{sub}</span>}
      </span>
      <span className="allocations__drift-shares">
        <Percent ratio={Number(current)} digits={1} />
        <span className="allocations__drift-of">
          {" "}
          of <Percent ratio={Number(target)} digits={1} />
        </span>
      </span>
      <span className="allocations__drift-bar">
        <NowTargetBar now={Number(current)} target={Number(target)} scale={scale} />
      </span>
      <span className={clsx("allocations__drift-pp", off < 0.5 && "allocations__drift-pp--ok")}>{pp(drift)}</span>
      <span className="allocations__drift-delta">
        {delta && Math.abs(Number(delta)) >= 0.5 ? <Money amount={Number(delta)} currency={ccy} signed colored digits={0} /> : "–"}
      </span>
    </li>
  );
}

export interface DriftCardProps {
  data: AllocationsData;
  ccy: ReportingCurrency;
}

/** The active target against today's mix, by category (default) or by fund. */
export function DriftCard({ data, ccy }: DriftCardProps) {
  const [view, setView] = usePersistentState<DriftView>("alloc.driftView", "category", isView);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState(false);
  const active = data.targets.find((t) => t.id === data.active_target_id);
  const funds = data.drift;
  const cats = data.drift_by_category ?? [];

  if (funds.length === 0) {
    const buckets = data.current_by_asset_class;
    return (
      <Card
        collapsibleId="allocations.drift"
        title="Current allocation"
        subtitle="No active target yet. Save one above to track drift here. Share of portfolio value by asset class."
      >
        <AllocationBar
          slices={buckets.map((b) => ({ id: b.label, label: assetClassLabel(b.label), actual: Number(b.pct) }))}
          ariaLabel="Current allocation by asset class"
        />
      </Card>
    );
  }

  const scale = Math.max(...funds.map((r) => Math.max(Number(r.current_pct), Number(r.target_pct))), 0.0001);
  const catScale = Math.max(...cats.map((r) => Math.max(Number(r.current_pct), Number(r.target_pct))), 0.0001);
  const byCat = new Map<string, DriftRow[]>();
  for (const r of funds) byCat.set(r.category, [...(byCat.get(r.category) ?? []), r]);
  const offBy = funds.reduce((a, r) => a + Math.abs(Number(r.drift_pp)), 0) / 2;
  const list: (DriftRow | CategoryRow)[] = view === "category" ? cats : funds;
  const shown = showAll ? list : list.slice(0, FOLD_AT);

  return (
    <Card
      collapsibleId="allocations.drift"
      title={`Targets & drift${active ? ` · ${active.name}` : ""}`}
      subtitle={`${formatPercent(offBy / 100, { digits: 1 })} of the portfolio is off target. Bar: today's share. Line: target.`}
      actions={
        <SegmentedControl
          ariaLabel="Drift view"
          size="sm"
          options={[
            { value: "category", label: "Category" },
            { value: "fund", label: "Fund" },
          ]}
          value={view}
          onChange={(v) => {
            setView(v);
            setShowAll(false);
          }}
        />
      }
    >
      {view === "category" && cats.length > 1 && cats.length <= BAR_MAX && (
        <AllocationBar
          className="allocations__drift-mix"
          slices={cats.map((c) => ({ id: c.key, label: c.label, actual: Number(c.current_pct), target: Number(c.target_pct) }))}
          ariaLabel="Current mix by category with target markers"
        />
      )}
      <div className="allocations__drift-head" aria-hidden>
        <span>{view === "category" ? "Category" : "Fund"}</span>
        <span>Now of target</span>
        <span />
        <span>Drift</span>
        <span>To target</span>
      </div>
      <ul className="allocations__drift-list" aria-label={view === "category" ? "Drift by category" : "Drift by fund"}>
        {view === "category"
          ? (shown as CategoryRow[]).map((c) => {
              const members = byCat.get(c.key) ?? [];
              const open = Boolean(expanded[c.key]);
              const listId = `drift-members-${c.key.replace(/\W+/g, "-")}`;
              return (
                <li key={c.key} className="allocations__drift-group">
                  <ul className="allocations__drift-list">
                    <DriftLine
                      id={c.key}
                      label={c.label}
                      sub={`${c.funds} ${c.funds === 1 ? "fund" : "funds"}`}
                      current={c.current_pct}
                      target={c.target_pct}
                      drift={c.drift_pp}
                      delta={c.delta_value}
                      scale={catScale}
                      ccy={ccy}
                      toggle={
                        members.length > 1
                          ? { open, controls: listId, onToggle: () => setExpanded((e) => ({ ...e, [c.key]: !open })) }
                          : undefined
                      }
                    />
                  </ul>
                  {open && (
                    <ul id={listId} className="allocations__drift-list allocations__drift-list--nested">
                      {members.map((r) => (
                        <DriftLine
                          key={r.key}
                          id={r.key}
                          label={r.label}
                          current={r.current_pct}
                          target={r.target_pct}
                          drift={r.drift_pp}
                          delta={r.delta_value}
                          scale={catScale}
                          ccy={ccy}
                          nested
                        />
                      ))}
                    </ul>
                  )}
                </li>
              );
            })
          : (shown as DriftRow[]).map((r) => (
              <DriftLine
                key={r.key}
                id={r.key}
                label={r.label}
                sub={r.category}
                current={r.current_pct}
                target={r.target_pct}
                drift={r.drift_pp}
                delta={r.delta_value}
                scale={scale}
                ccy={ccy}
              />
            ))}
      </ul>
      {list.length > FOLD_AT && (
        <Button className="allocations__drift-more" size="sm" variant="ghost" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show the largest drifts only" : `Show all ${list.length}`}
        </Button>
      )}
    </Card>
  );
}
