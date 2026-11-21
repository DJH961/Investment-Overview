import clsx from "clsx";
import type { ReactNode } from "react";

export interface TwoLineRowProps {
  /** Line 1, left: the kind (icon + word). */
  lead: ReactNode;
  /** Line 1, right: the amount. */
  amount: ReactNode;
  /** Line 2, left: date · account. */
  meta: ReactNode;
  /** Line 2, right: "50 sh @ $264.65", "$0.36 / sh". */
  detail?: ReactNode;
  /** Opens the row (the transaction edit); the row becomes a button. */
  onOpen?: () => void;
  openLabel?: string;
}

/**
 * The one row grammar of the holding page's lists (Transactions, Dividends, phone
 * tranches): two lines, kind and amount first, date · account and the per-share
 * detail under them, every row the same shape.
 */
export function TwoLineRow({ lead, amount, meta, detail, onOpen, openLabel }: TwoLineRowProps) {
  const body = (
    <>
      <span className="holding-page__row-lead">{lead}</span>
      <span className="holding-page__row-amount">{amount}</span>
      <span className="holding-page__row-meta">{meta}</span>
      <span className="holding-page__row-detail">{detail}</span>
    </>
  );
  return (
    <li className="holding-page__row-item">
      {onOpen ? (
        <button
          type="button"
          className={clsx("holding-page__row", "holding-page__row--button")}
          onClick={onOpen}
        >
          {body}
          {openLabel && <span className="holding-page__sr">{openLabel}</span>}
        </button>
      ) : (
        <div className="holding-page__row">{body}</div>
      )}
    </li>
  );
}

/** A year line over a group of rows: "2026" left, the year's summary right. */
export function YearLine({ year, summary }: { year: string | number; summary?: ReactNode }) {
  return (
    <li className="holding-page__year" aria-label={`${year}`}>
      <span className="holding-page__year-label">{year}</span>
      {summary && <span className="holding-page__year-summary">{summary}</span>}
    </li>
  );
}

/** The kind as an icon + a word. */
export function KindTag({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span className="holding-page__kind">
      <span className="holding-page__kind-icon">{icon}</span>
      {label}
    </span>
  );
}
