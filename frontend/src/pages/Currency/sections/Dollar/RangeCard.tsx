import clsx from "clsx";
import type { CSSProperties } from "react";
import { formatDate } from "../../../../lib/format";
import { quoteOf, type DollarDto } from "../../../../lib/queries/currencyDollar";
import { toNum } from "../../../../lib/queries/portfolio";
import { rateText, type Lean } from "./quote";

/** Keeps a marker's label inside the bar's width: the marker stays exact, the label is nudged. */
const tagStyle = (v: number): CSSProperties =>
  v > 50 ? { right: `${Math.max(0, 100 - v)}%`, transform: "none" } : { left: `${v}%`, transform: "none" };

/**
 * The holdings story as one picture: the lowest and highest rate since your first
 * transaction at the ends, your average rate (open marker) and today (filled marker),
 * and the stretch between them colored by what it did to your dollars (with the
 * tailwind/headwind word beside the figures, never color alone). The extremes come from
 * the server in the view's quote; the markers are plain placement of the server's rates.
 */
export function SinceStarted({ data, lean }: { data: DollarDto; lean: Lean }) {
  const field = data.quote.field;
  const stat = (key: string) => (data.stats ?? []).find((s) => s.key === key);
  const lowStat = stat("low_since_start");
  const highStat = stat("high_since_start");
  const lo = toNum(lowStat?.value_display ?? null);
  const hi = toNum(highStat?.value_display ?? null);
  if (!lowStat || !highStat || lo === null || hi === null || hi <= lo) return null;
  const now = toNum(quoteOf(data.position?.rate_now ?? null, field));
  const avg = toNum(quoteOf(data.position?.avg_rate ?? null, field));
  const place = (v: number) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  const nowAt = now !== null ? place(now) : null;
  const avgAt = avg !== null ? place(avg) : null;
  return (
    <div className="dollar-since">
      <p className="dollar-since__caption">Since you started</p>
      <div className="dollar-since__above" aria-hidden>
        {nowAt !== null && now !== null ? (
          <span className="dollar-since__tag dollar-since__tag--now" style={tagStyle(nowAt)}>
            now <strong className="dollar-since__figure">{rateText(now, field)}</strong>
          </span>
        ) : null}
      </div>
      <span className="u-sr-only">{`Since you started the rate ranged from ${rateText(lo, field)} to ${rateText(hi, field)}; today ${rateText(now, field)}, your average ${rateText(avg, field)}`}</span>
      <div className="dollar-since__track" aria-hidden="true">
        {avgAt !== null && nowAt !== null ? (
          <span
            className={clsx("dollar-since__gap", `dollar-since__gap--${lean}`)}
            style={{ left: `${Math.min(avgAt, nowAt)}%`, width: `${Math.abs(nowAt - avgAt)}%` }}
          />
        ) : null}
        {avgAt !== null ? <span className="dollar-since__avg" style={{ left: `${avgAt}%` }} /> : null}
        {nowAt !== null ? <span className="dollar-since__now" style={{ left: `${nowAt}%` }} /> : null}
      </div>
      <div className="dollar-since__below" aria-hidden>
        {avgAt !== null && avg !== null ? (
          <span className="dollar-since__tag" style={tagStyle(avgAt)}>
            your average <strong className="dollar-since__figure">{rateText(avg, field)}</strong>
          </span>
        ) : null}
      </div>
      <p className="dollar-since__ends">
        <span>
          low {rateText(lo, field)}
          {lowStat.date ? ` · ${formatDate(lowStat.date)}` : ""}
        </span>
        <span>
          high {rateText(hi, field)}
          {highStat.date ? ` · ${formatDate(highStat.date)}` : ""}
        </span>
      </p>
    </div>
  );
}
