import clsx from "clsx";
import "./AllocationBar.scss";

export interface AllocationSlice {
  id: string;
  label: string;
  /** Actual weight as a fraction (0.4 = 40%). */
  actual: number;
  /** Optional target weight as a fraction. */
  target?: number;
}

export interface AllocationBarProps {
  slices: AllocationSlice[];
  ariaLabel?: string;
  className?: string;
}

const pct = (r: number) => `${(r * 100).toFixed(1)}%`;

/** Normalised widths in percent (sum to 100 unless everything is zero). */
export function sliceWidths(slices: AllocationSlice[]): number[] {
  const total = slices.reduce((a, s) => a + Math.max(s.actual, 0), 0);
  return slices.map((s) => (total > 0 ? (Math.max(s.actual, 0) / total) * 100 : 0));
}

export function AllocationBar({ slices, ariaLabel = "Allocation", className }: AllocationBarProps) {
  const widths = sliceWidths(slices);
  const targetTotal = slices.reduce((a, s) => a + (s.target ?? 0), 0);
  const withTarget = targetTotal > 0 ? slices.filter((s) => s.target !== undefined) : [];
  const markers = withTarget.map((s, i) => ({
    id: s.id,
    left: (withTarget.slice(0, i + 1).reduce((a, t) => a + (t.target ?? 0), 0) / targetTotal) * 100,
    label: `${s.label} target ${pct(s.target ?? 0)}`,
  }));
  return (
    <div className={clsx("allocation-bar", className)}>
      <figure className="allocation-bar__track" aria-label={ariaLabel}>
        {slices.map((s, i) => (
          <div
            key={s.id}
            className={clsx("allocation-bar__segment", `allocation-bar__segment--c${(i % 6) + 1}`)}
            data-testid={`segment-${s.id}`}
            style={{ width: `${widths[i]}%` }}
            title={`${s.label}: ${pct(s.actual)}`}
          />
        ))}
        {markers.slice(0, -1).map((m) => (
          <div key={m.id} className="allocation-bar__marker" style={{ left: `${m.left}%` }} title={m.label} />
        ))}
      </figure>
      <ul className="allocation-bar__legend">
        {slices.map((s, i) => {
          const drift = s.target !== undefined ? s.actual - s.target : null;
          return (
            <li key={s.id} className="allocation-bar__item">
              <span className={clsx("allocation-bar__swatch", `allocation-bar__swatch--c${(i % 6) + 1}`)} aria-hidden />
              <span className="allocation-bar__name">{s.label}</span>
              <span className="allocation-bar__actual">{pct(s.actual)}</span>
              {s.target !== undefined && <span className="allocation-bar__target">target {pct(s.target)}</span>}
              {drift !== null && Math.abs(drift) >= 0.005 && (
                <span
                  className={clsx(
                    "allocation-bar__drift",
                    drift > 0 ? "allocation-bar__drift--pos" : "allocation-bar__drift--neg",
                  )}
                >
                  {drift > 0 ? "+" : "-"}
                  {(Math.abs(drift) * 100).toFixed(1)} pp
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
