import clsx from "clsx";
import "./Freshness.scss";

export type FreshnessStatus = "live" | "closed" | "stale" | "loading";

export interface FreshnessProps {
  status: FreshnessStatus;
  /** For example "Live · 14:32 ET" or "Closed · prices as of Fri 22:00". */
  label: string;
  className?: string;
}

export function Freshness({ status, label, className }: FreshnessProps) {
  return (
    <output className={clsx("freshness", `freshness--${status}`, className)}>
      <span className="freshness__dot" aria-hidden />
      <span className="freshness__label">{label}</span>
    </output>
  );
}
