import clsx from "clsx";
import type { ReactNode } from "react";
import { InfoTip } from "../InfoTip";
import "./StatStrip.scss";

export interface StatItem {
  key: string;
  label: string;
  /** The figure (Money / Percent / text). Values come from the server as they are. */
  value: ReactNode;
  /** One quiet line under the figure ("avg 1.0751", "since close"). */
  note?: ReactNode;
  /** One sentence on what the figure means; shows an (i) beside the label. */
  tip?: string;
}

export interface StatStripProps {
  items: StatItem[];
  /** Accessible name of the strip ("Currency at a glance"). */
  label: string;
  className?: string;
  /** Phone: three narrow columns instead of two (a strip of exactly three figures). */
  phoneColumns?: 2 | 3;
  /** Six figures: one row of six on desktop, 3 × 2 on tablets, 2 × 3 on phones. */
  six?: boolean;
}

/**
 * A row of compact figures in one surface, split by hairlines (v7: the Currency
 * page's always-visible tile strip). Wraps to two columns on phones, never clips;
 * tiles that have no figure yet are simply left out by the caller.
 */
export function StatStrip({ items, label, className, phoneColumns = 2, six = false }: StatStripProps) {
  // Phones: a short last row stretches across the width instead of leaving an empty
  // cell (5 figures in 3 columns = 3 + 2 wide; 3 in 2 = 2 + 1 full).
  const rest = items.length % phoneColumns;
  const fillFrom = rest === 0 ? items.length : items.length - rest;
  const fill = rest === 1 ? "full" : "half";
  return (
    <section
      className={clsx(
        "stat-strip",
        phoneColumns === 3 && "stat-strip--phone-3",
        six && items.length === 6 && "stat-strip--six",
        className,
      )}
      aria-label={label}
    >
      <dl className="stat-strip__list">
        {items.map((s, i) => (
          <div
            key={s.key}
            className={clsx("stat-strip__item", i >= fillFrom && `stat-strip__item--fill-${fill}`)}
          >
            <dt className="stat-strip__label">
              {s.tip ? <LabelWithTip label={s.label} tip={s.tip} /> : s.label}
            </dt>
            <dd className="stat-strip__value">{s.value}</dd>
            {s.note && <dd className="stat-strip__note">{s.note}</dd>}
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The label with its (i) glued to the last word (a CSS word joiner, so the label
 *  text stays as it is), so a wrap never strands the icon on a line of its own. */
function LabelWithTip({ label, tip }: { label: string; tip: string }) {
  return (
    <>
      {label}
      <span className="stat-strip__tip">
        <InfoTip label={label} content={tip} />
      </span>
    </>
  );
}
