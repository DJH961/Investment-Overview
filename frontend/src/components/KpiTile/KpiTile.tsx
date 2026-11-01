import clsx from "clsx";
import type { ReactNode } from "react";
import { Skeleton } from "../Skeleton";
import "./KpiTile.scss";

export interface KpiTileProps {
  label: string;
  /** Headline figure (usually a Money or Percent). */
  value: ReactNode;
  /** Usually a DeltaBadge. */
  delta?: ReactNode;
  hint?: ReactNode;
  /** Slot for a small sparkline. */
  sparkline?: ReactNode;
  loading?: boolean;
  className?: string;
}

export function KpiTile({ label, value, delta, hint, sparkline, loading = false, className }: KpiTileProps) {
  return (
    <div className={clsx("kpi-tile", className)}>
      <div className="kpi-tile__label">{label}</div>
      {loading ? (
        <>
          <Skeleton height="1.9rem" width="60%" />
          <Skeleton height="1rem" width="35%" />
        </>
      ) : (
        <>
          <div className="kpi-tile__value">{value}</div>
          {(delta || hint) && (
            <div className="kpi-tile__meta">
              {delta}
              {hint && <span className="kpi-tile__hint">{hint}</span>}
            </div>
          )}
          {sparkline && <div className="kpi-tile__sparkline">{sparkline}</div>}
        </>
      )}
    </div>
  );
}
