import clsx from "clsx";
import type { ReactNode } from "react";
import { signOf } from "../../lib/format";
import "./DivergingBar.scss";

export interface DivergingBarRow {
  id: string;
  label: string;
  value: number;
  /** Formatted value (usually a Money). */
  display: ReactNode;
  /** Small status word beside the value: live / paused / last. */
  tag?: string;
  /** Striped fill (the overnight leg). */
  striped?: boolean;
  /** Force the bar width (fraction of one half, 0..1); default scales to the largest row. */
  width?: number;
}

export interface DivergingBarProps {
  rows: DivergingBarRow[];
  ariaLabel?: string;
  className?: string;
}

/** Horizontal bars growing left (negative) or right (positive) from a centre line. */
export function DivergingBar({ rows, ariaLabel, className }: DivergingBarProps) {
  const max = Math.max(0, ...rows.map((r) => Math.abs(r.value)));
  const hasTags = rows.some((r) => Boolean(r.tag));
  return (
    <ul
      className={clsx("diverging-bar", !hasTags && "diverging-bar--untagged", className)}
      aria-label={ariaLabel}
    >
      {rows.map((r) => {
        const tone = signOf(r.value);
        const frac = r.width ?? (max === 0 ? 0 : Math.abs(r.value) / max);
        return (
          <li key={r.id} className="diverging-bar__row" data-row={r.id}>
            <span className="diverging-bar__label">{r.label}</span>
            <span className="diverging-bar__track" aria-hidden>
              <span
                className={clsx(
                  "diverging-bar__fill",
                  `diverging-bar__fill--${tone}`,
                  r.striped && "diverging-bar__fill--striped",
                )}
                style={{ width: `${(frac * 50).toFixed(4)}%` }}
              />
            </span>
            <span className="diverging-bar__value">{r.display}</span>
            {hasTags && <span className="diverging-bar__tag">{r.tag ?? ""}</span>}
          </li>
        );
      })}
    </ul>
  );
}
