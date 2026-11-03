import clsx from "clsx";
import "./Freshness.scss";

export type FreshnessStatus = "live" | "closed" | "stale" | "loading" | "updating";

export interface FreshnessProps {
  status: FreshnessStatus;
  /** For example "Live · 14:32 ET" or "Closed · prices as of Fri 22:00". */
  label: string;
  /** Full text when `label` is a shortened form (shown on hover). */
  title?: string;
  className?: string;
}

export function Freshness({ status, label, title, className }: FreshnessProps) {
  return (
    <output className={clsx("freshness", `freshness--${status}`, className)} title={title}>
      <span className="freshness__dot" aria-hidden />
      <span className="freshness__label">{label}</span>
    </output>
  );
}
