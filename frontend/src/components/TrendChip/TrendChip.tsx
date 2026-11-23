import clsx from "clsx";
import { MoveRight, TrendingDown, TrendingUp } from "lucide-react";
import { Tooltip } from "../Tooltip";
import { formatDate, formatPercent } from "../../lib/format";
import { toNum } from "../../lib/queries/portfolio";
import type { RateTrendDto } from "../../lib/queries/currencyRate";
import "./TrendChip.scss";

export const TREND_WORD = {
  dollar_up: { word: "strengthening", Icon: TrendingUp },
  dollar_down: { word: "weakening", Icon: TrendingDown },
  sideways: { word: "sideways", Icon: MoveRight },
} as const;

/**
 * The two lenses of one dollar move (owner, 2026-11-21): dollars you hold and euros you
 * still convert gain in opposite directions, so neither reads as simply bad.
 */
export function lensWords(direction: RateTrendDto["direction"]): { holdings: string; next: string } {
  if (direction === "dollar_up") return { holdings: "your holdings ▲", next: "your next euro ▼" };
  if (direction === "dollar_down") return { holdings: "your holdings ▼", next: "your next euro ▲" };
  return { holdings: "your holdings ≈", next: "your next euro ≈" };
}

/** "unusual" only outside the normal range (the server's 95th percentile); a large month is still normal. */
export const isUnusual = (trend: RateTrendDto) => trend.normal === "unusual";

const pct = (v: string | null | undefined) => formatPercent(toNum(v ?? null), { signed: true, digits: 1 });

export interface TrendChipProps {
  trend: RateTrendDto;
  className?: string;
}

/**
 * The quiet Overview hint: `↘ Dollar weakening · normal`. The chip never colors the
 * direction good or bad (it is good for one lens and bad for the other); only an
 * unusual move gets the warning tint, and always with the word. Tap or hover for both
 * lenses and the numbers behind the label (all from the server's trend block).
 */
export function TrendChip({ trend, className }: TrendChipProps) {
  const dir = TREND_WORD[trend.direction];
  const unusual = isUnusual(trend);
  const lens = lensWords(trend.direction);
  const label = `Dollar ${dir.word} · ${unusual ? "unusual" : "normal"}`;
  return (
    <Tooltip
      content={
        <span className="trend-chip__tip">
          <span className="trend-chip__tip-line">
            Dollar {dir.word}
            {trend.since ? ` since ${formatDate(trend.since)} (${pct(trend.since_change_pct)})` : ""}, {trend.vs_ma200} its
            200-day average.
          </span>
          <span className="trend-chip__tip-line trend-chip__tip-line--strong">
            {lens.holdings} · {lens.next}
          </span>
          <span className="trend-chip__tip-line">
            Last {trend.window_days} trading days {pct(trend.move_pct)}; a typical move is ±
            {formatPercent(toNum(trend.typical_move_pct), { digits: 1 })}: {unusual ? "outside" : "inside"} the normal range.
          </span>
          <span className="trend-chip__tip-line trend-chip__tip-line--muted">Describes the past; it does not predict.</span>
        </span>
      }
    >
      <button
        type="button"
        className={clsx("trend-chip", unusual && "trend-chip--unusual", className)}
        aria-label={`${label}. ${lens.holdings}, ${lens.next}.`}
        data-testid="trend-chip"
      >
        <dir.Icon aria-hidden className="trend-chip__icon" />
        <span className="trend-chip__label">
          Dollar {dir.word}
          <span className="trend-chip__sep" aria-hidden>
            ·
          </span>
          <span className="trend-chip__normal">{unusual ? "unusual" : "normal"}</span>
        </span>
      </button>
    </Tooltip>
  );
}
