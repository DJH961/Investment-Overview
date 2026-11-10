import clsx from "clsx";
import { useRef, type ReactNode } from "react";
import { InfoTip } from "../InfoTip";
import { Skeleton } from "../Skeleton";
import { useFitWidth } from "./useFitWidth";
import "./KpiTile.scss";

export interface KpiTileProps {
  label: string;
  /** Headline figure (usually a Money or Percent). */
  value: ReactNode;
  /** Usually a DeltaBadge. */
  delta?: ReactNode;
  hint?: ReactNode;
  /** The same figure in the other currency (small, under the value). */
  secondary?: ReactNode;
  /** Top-right stamp, e.g. "live" or "16:00". */
  corner?: ReactNode;
  /** Explanation shown from an info button beside the label. */
  tooltip?: string;
  /** Slot for a small sparkline. */
  sparkline?: ReactNode;
  loading?: boolean;
  className?: string;
}

export function KpiTile({
  label,
  value,
  delta,
  hint,
  secondary,
  corner,
  tooltip,
  sparkline,
  loading = false,
  className,
}: KpiTileProps) {
  const valueRef = useRef<HTMLDivElement>(null);
  useFitWidth(valueRef, loading);
  return (
    <div className={clsx("kpi-tile", className)}>
      <div className="kpi-tile__head">
        <div className="kpi-tile__label">
          {label}
          {tooltip && <InfoTip content={tooltip} label={label} />}
        </div>
        {corner && !loading && <div className="kpi-tile__corner">{corner}</div>}
      </div>
      {loading ? (
        <>
          <Skeleton height="1.9rem" width="60%" />
          <Skeleton height="1rem" width="35%" />
        </>
      ) : (
        <>
          <div className="kpi-tile__value" ref={valueRef}>
            {value}
          </div>
          {secondary && <div className="kpi-tile__secondary">{secondary}</div>}
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
