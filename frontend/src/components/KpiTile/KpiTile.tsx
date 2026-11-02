import clsx from "clsx";
import { Info } from "lucide-react";
import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { Skeleton } from "../Skeleton";
import { Tooltip } from "../Tooltip";
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

/** Smallest scale the fit step may apply on top of the CSS container-query size. */
const MIN_FIT = 0.55;

/**
 * Shrinks the value's font (via `--kpi-tile-fit`) until it fits the tile width.
 * CSS already sizes the figure from the tile width (container query units);
 * this catches the long ones ("-$12,345,678.90" in a 2-column phone grid).
 */
function useFitWidth(ref: RefObject<HTMLDivElement | null>, value: ReactNode, loading: boolean) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.setProperty("--kpi-tile-fit", "1");
      const avail = el.clientWidth;
      const need = el.scrollWidth;
      if (avail > 0 && need > avail) {
        const scale = Math.max(MIN_FIT, Math.floor((avail / need) * 100) / 100);
        el.style.setProperty("--kpi-tile-fit", String(scale));
      }
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    let last = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== last) {
        last = el.clientWidth;
        fit();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, value, loading]);
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
  useFitWidth(valueRef, value, loading);
  return (
    <div className={clsx("kpi-tile", className)}>
      <div className="kpi-tile__head">
        <div className="kpi-tile__label">
          {label}
          {tooltip && (
            <Tooltip content={tooltip}>
              <button type="button" className="kpi-tile__info" aria-label={`About ${label}`}>
                <Info aria-hidden className="kpi-tile__info-icon" />
              </button>
            </Tooltip>
          )}
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
