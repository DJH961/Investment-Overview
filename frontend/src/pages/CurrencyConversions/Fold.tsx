import clsx from "clsx";
import { ChevronDown } from "lucide-react";
import { useId, type ReactNode } from "react";

export interface FoldProps {
  open: boolean;
  onToggle: () => void;
  title: ReactNode;
  /** Quiet line under the title ("3 conversions · €5,000 → US$5,500"). */
  meta?: ReactNode;
  /** A month inside a year: inset under the year's header instead of a card of its own. */
  nested?: boolean;
  children: ReactNode;
}

/**
 * A month (or an older year) that folds its rows away. Same look as the month cards on the
 * Transactions page: a card with the chevron, the title and one quiet line, the rows flush
 * inside it. The children are only rendered while open, so a list of hundreds of rows costs
 * nothing until a group is opened.
 */
export function Fold({ open, onToggle, title, meta, nested = false, children }: FoldProps) {
  const bodyId = useId();
  if (nested) {
    return (
      <section className={clsx("fold", open && "fold--open")}>
        <h3 className="fold__heading">
          <button type="button" className="fold__button" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
            <ChevronDown aria-hidden className="fold__chevron" />
            <span className="fold__title">{title}</span>
          </button>
        </h3>
        {meta && <p className="fold__meta">{meta}</p>}
        <div id={bodyId} className="fold__body" hidden={!open}>
          {open ? children : null}
        </div>
      </section>
    );
  }
  return (
    <section className={clsx("card", "card--collapsible", !open && "card--collapsed")}>
      <header className="card__header">
        <div className="card__heading">
          <h2 className="card__title">
            <button type="button" className="card__toggle" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
              <ChevronDown className="card__chevron" aria-hidden />
              <span className="card__title-text">{title}</span>
            </button>
          </h2>
          {meta && <p className="card__subtitle">{meta}</p>}
        </div>
      </header>
      <div id={bodyId} className="card__body card__body--flush" hidden={!open}>
        {open ? children : null}
      </div>
    </section>
  );
}
