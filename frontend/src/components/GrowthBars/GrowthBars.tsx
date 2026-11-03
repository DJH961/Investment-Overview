import clsx from "clsx";
import { formatPercent } from "../../lib/format";
import "./GrowthBars.scss";

export interface GrowthBar {
  id: string;
  /** Axis / tooltip label ("Oct 2026", "2025"). */
  label: string;
  /** Growth as a fraction (0.024 = +2.4 %); null draws an empty slot. */
  value: number | null;
}

export interface GrowthBarsProps {
  bars: GrowthBar[];
  ariaLabel: string;
  className?: string;
}

/**
 * Period growth as bars around a zero line: gains up (blue), losses down
 * (orange), like the v5 "Growth per month" chart. Pure CSS layout, so it
 * fits any width without measuring.
 */
export function GrowthBars({ bars, ariaLabel, className }: GrowthBarsProps) {
  const values = bars.map((b) => b.value ?? 0);
  const maxPos = Math.max(0, ...values);
  const maxNeg = Math.max(0, ...values.map((v) => -v));
  const span = maxPos + maxNeg;
  if (bars.length === 0 || span === 0) return null;
  // Share of the plot height above the zero line (at least a sliver each side).
  const up = Math.min(0.92, Math.max(0.08, maxPos / span));
  const ticks = bars.length > 2 ? [0, Math.floor((bars.length - 1) / 2), bars.length - 1] : bars.map((_, i) => i);
  return (
    <figure className={clsx("growth-bars", className)} aria-label={ariaLabel}>
      <div className="growth-bars__frame" aria-hidden>
        <div className="growth-bars__scale" aria-hidden>
          <span className="growth-bars__tick">{formatPercent(maxPos, { signed: true, digits: 1 })}</span>
          <span className="growth-bars__tick">{maxNeg > 0 ? formatPercent(-maxNeg, { signed: true, digits: 1 }) : ""}</span>
        </div>
        <div className="growth-bars__plot" style={{ gridTemplateRows: `${up}fr ${1 - up}fr` }}>
          {bars.map((b, i) => {
            const v = b.value ?? 0;
            const pos = v >= 0;
            const h = pos ? (maxPos ? v / maxPos : 0) : maxNeg ? -v / maxNeg : 0;
            return (
              <div
                key={b.id}
                className="growth-bars__col"
                style={{ gridColumn: i + 1 }}
                title={`${b.label}: ${b.value === null ? "–" : formatPercent(b.value, { signed: true })}`}
              >
                <span className="growth-bars__half growth-bars__half--up">
                  {pos && <span className="growth-bars__bar growth-bars__bar--pos" style={{ height: `${h * 100}%` }} />}
                </span>
                <span className="growth-bars__half growth-bars__half--down">
                  {!pos && <span className="growth-bars__bar growth-bars__bar--neg" style={{ height: `${h * 100}%` }} />}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <figcaption className="growth-bars__axis" aria-hidden>
        {ticks.map((i) => (
          <span key={bars[i].id} className="growth-bars__tick">
            {bars[i].label}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
