import clsx from "clsx";
import { Check, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { Button } from "../../components/Button";
import { Select } from "../../components/Select";
import { Sheet } from "../../components/Sheet";
import { PERIOD_ALL } from "./grouping";

export interface ConversionFilters {
  period: string;
  /** "all" or a provider value. */
  provider: string;
  /** Conversions with dollars still in the pool. */
  pool: boolean;
  /** 7.4: to dollars, back to euros, or both. */
  direction: DirectionFilter;
}

export type DirectionFilter = "all" | "to_usd" | "to_eur";

export const DIRECTION_FILTER_OPTIONS: { value: DirectionFilter; label: string }[] = [
  { value: "all", label: "Both directions" },
  { value: "to_usd", label: "To dollars" },
  { value: "to_eur", label: "Back to euros" },
];

export const NO_FILTERS: ConversionFilters = { period: PERIOD_ALL, provider: "all", pool: false, direction: "all" };

export const PROVIDER_FILTER_OPTIONS = [
  { value: "all", label: "All providers" },
  { value: "wise", label: "Wise" },
  { value: "revolut", label: "Revolut" },
  { value: "other", label: "Other" },
];

export function activeCount(f: ConversionFilters): number {
  return [f.period !== PERIOD_ALL, f.provider !== "all", f.pool, f.direction !== "all"].filter(Boolean).length;
}

/** A pill that switches a filter on or off; the check mark carries the state, not only the color. */
export function ToggleChip({
  pressed,
  onPressedChange,
  children,
}: {
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
  children: string;
}) {
  return (
    <button
      type="button"
      className={clsx("toggle-chip", pressed && "toggle-chip--on")}
      aria-pressed={pressed}
      onClick={() => onPressedChange(!pressed)}
    >
      {pressed && <Check aria-hidden className="toggle-chip__icon" />}
      {children}
    </button>
  );
}

interface FilterBarProps {
  /** Show the direction filter (once there is a conversion back to euros). */
  directions?: boolean;
  value: ConversionFilters;
  onChange: (next: ConversionFilters) => void;
  periods: { value: string; label: string }[];
  /** Showing N of M conversions. */
  shown: number;
  total: number;
}

/**
 * Compact toolbar above the list. Desktop: period, provider and "Still in the pool" in one
 * row. Phone: one Filters button that opens a sheet with the same three controls.
 */
export function FilterBar({ value, onChange, periods, shown, total, directions = false }: FilterBarProps) {
  const [sheet, setSheet] = useState(false);
  const n = activeCount(value);
  const patch = (p: Partial<ConversionFilters>) => onChange({ ...value, ...p });
  const controls = (
    <>
      {directions && (
        <Select
          className="filter-bar__select"
          ariaLabel="Direction"
          value={value.direction}
          onValueChange={(direction) => patch({ direction: direction as DirectionFilter })}
          options={DIRECTION_FILTER_OPTIONS}
        />
      )}
      <Select className="filter-bar__select" ariaLabel="Period" value={value.period} onValueChange={(period) => patch({ period })} options={periods} />
      <Select
        className="filter-bar__select"
        ariaLabel="Provider"
        value={value.provider}
        onValueChange={(provider) => patch({ provider })}
        options={PROVIDER_FILTER_OPTIONS}
      />
      <ToggleChip pressed={value.pool} onPressedChange={(pool) => patch({ pool })}>
        Still in the pool
      </ToggleChip>
    </>
  );
  return (
    <div className="filter-bar">
      <div className="filter-bar__inline">{controls}</div>
      <div className="filter-bar__phone">
        <Button
          size="sm"
          variant="secondary"
          leftIcon={<SlidersHorizontal aria-hidden />}
          onClick={() => setSheet(true)}
        >
          {n > 0 ? `Filters · ${n}` : "Filters"}
        </Button>
      </div>
      <p className="filter-bar__count" aria-live="polite">
        {n > 0 ? `Showing ${shown} of ${total}` : `${total} ${total === 1 ? "conversion" : "conversions"}`}
        {n > 0 && (
          <>
            {" · "}
            <button type="button" className="filter-bar__clear" onClick={() => onChange(NO_FILTERS)}>
              Clear filters
            </button>
          </>
        )}
      </p>
      <Sheet open={sheet} onOpenChange={setSheet} title="Filter conversions">
        <div className="filter-bar__sheet">
          {controls}
          <div className="filter-bar__sheet-actions">
            {n > 0 && (
              <Button variant="ghost" onClick={() => onChange(NO_FILTERS)}>
                Clear filters
              </Button>
            )}
            <Button variant="primary" onClick={() => setSheet(false)}>
              Show {shown} of {total}
            </Button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}
