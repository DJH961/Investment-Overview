import clsx from "clsx";
import "./Freshness.scss";

export type FreshnessStatus = "live" | "closed" | "stale" | "loading" | "updating";

export interface FreshnessProps {
  status: FreshnessStatus;
  /** For example "Live · 14:32 ET" or "Closed · prices as of Fri 22:00". */
  label: string;
  /** Full text when `label` is a shortened form (shown on hover). */
  title?: string;
  /** Two lines: the state ("Closed") over its detail ("Prices 22:00 (close)"). */
  stacked?: boolean;
  className?: string;
}

/**
 * "Closed · prices as of today 22:00 (close)" -> ["Closed", "Prices 22:00 (close)"].
 * The state stays whole on its own line; the detail drops the filler words ("as of",
 * "today"), keeping any other day ("Prices Fri 22:00 (close)"). No " · ": one line.
 */
export function splitFreshness(label: string): [string, string | null] {
  const at = label.indexOf(" · ");
  if (at < 0) return [label, null];
  const detail = label
    .slice(at + 3)
    .replace(/^prices as of (today )?/i, "Prices ")
    .trim();
  return [label.slice(0, at), detail ? detail.charAt(0).toUpperCase() + detail.slice(1) : null];
}

export function Freshness({ status, label, title, stacked = false, className }: FreshnessProps) {
  const [head, detail] = stacked ? splitFreshness(label) : [label, null];
  return (
    <output
      className={clsx("freshness", `freshness--${status}`, detail && "freshness--stacked", className)}
      title={title ?? label}
    >
      <span className="freshness__dot" aria-hidden />
      {detail ? (
        <span className="freshness__label">
          <span className="freshness__head">{head}</span>
          <span className="freshness__detail">{detail}</span>
        </span>
      ) : (
        // One line on phones: the label may be cut with an ellipsis (full text in the title).
        <span className="freshness__label" data-truncate-ok>
          {label}
        </span>
      )}
    </output>
  );
}
