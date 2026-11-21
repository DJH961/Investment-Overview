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
}

/**
 * A row of compact figures in one surface, split by hairlines (v7: the Currency
 * page's always-visible tile strip). Wraps to two columns on phones, never clips;
 * tiles that have no figure yet are simply left out by the caller.
 */
export function StatStrip({ items, label, className, phoneColumns = 2 }: StatStripProps) {
  return (
    <section className={clsx("stat-strip", phoneColumns === 3 && "stat-strip--phone-3", className)} aria-label={label}>
      <dl className="stat-strip__list">
        {items.map((s) => (
          <div key={s.key} className="stat-strip__item">
            <dt className="stat-strip__label">
              {s.label}
              {s.tip ? <InfoTip label={s.label} content={s.tip} /> : null}
            </dt>
            <dd className="stat-strip__value">{s.value}</dd>
            {s.note && <dd className="stat-strip__note">{s.note}</dd>}
          </div>
        ))}
      </dl>
    </section>
  );
}
