import { Card } from "../../../../components/Card";
import { formatDate } from "../../../../lib/format";
import { quoteOf, type DollarDto } from "../../../../lib/queries/currencyDollar";
import { toNum } from "../../../../lib/queries/portfolio";
import { rateText } from "./quote";

/** Keeps a marker's label inside the card: the marker stays exact, the label is nudged. */
const tagStyle = (v: number): React.CSSProperties =>
  v > 50 ? { right: `${Math.max(0, 100 - v)}%`, transform: "none" } : { left: `${v}%`, transform: "none" };

/**
 * "Since you started" as one picture: the lowest and highest rate since your first
 * transaction at the two ends, today's rate and your average rate as markers on the
 * bar. The extremes come from the server in the view's quote (low is always the
 * smaller figure); the markers are plain placement of the server's rates.
 */
export function RangeCard({ data }: { data: DollarDto }) {
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
    <Card className="dollar-since" title="Since you started" meta={data.quote.pair}>
      <div className="dollar-since__plot">
        <div className="dollar-since__above" aria-hidden>
          {nowAt !== null && now !== null ? (
            <span className="dollar-since__tag dollar-since__tag--now" style={tagStyle(nowAt)}>
              now <strong className="dollar-since__figure">{rateText(now, field)}</strong>
            </span>
          ) : null}
        </div>
        <div
          className="dollar-since__track"
          role="img"
          aria-label={`Since you started the rate ranged from ${rateText(lo, field)} to ${rateText(hi, field)}; today ${rateText(now, field)}, your average ${rateText(avg, field)}`}
        >
          {avgAt !== null ? <span className="dollar-since__avg" style={{ left: `${avgAt}%` }} /> : null}
          {nowAt !== null ? <span className="dollar-since__now" style={{ left: `${Math.max(1.5, Math.min(98.5, nowAt))}%` }} /> : null}
        </div>
        <div className="dollar-since__below" aria-hidden>
          {avgAt !== null && avg !== null ? (
            <span className="dollar-since__tag" style={tagStyle(avgAt)}>
              your average <strong className="dollar-since__figure">{rateText(avg, field)}</strong>
            </span>
          ) : null}
        </div>
      </div>
      <dl className="dollar-since__ends">
        <div className="dollar-since__end">
          <dt className="dollar-since__label">Low</dt>
          <dd className="dollar-since__value">{rateText(lo, field)}</dd>
          <dd className="dollar-since__date">{lowStat.date ? formatDate(lowStat.date) : null}</dd>
        </div>
        <div className="dollar-since__end dollar-since__end--high">
          <dt className="dollar-since__label">High</dt>
          <dd className="dollar-since__value">{rateText(hi, field)}</dd>
          <dd className="dollar-since__date">{highStat.date ? formatDate(highStat.date) : null}</dd>
        </div>
      </dl>
    </Card>
  );
}
