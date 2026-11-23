import clsx from "clsx";
import { ChevronDown } from "lucide-react";
import { useId, type ReactNode } from "react";

export interface FoldProps {
  open: boolean;
  onToggle: () => void;
  title: ReactNode;
  /** Quiet line under the title ("3 conversions · €5,000 → US$5,500"). */
  meta?: ReactNode;
  children: ReactNode;
}

/**
 * A year that folds its rows away. Same look as the month cards on the
 * Transactions page: a card with the chevron, the title and one quiet line, the rows flush
 * inside it. The children are only rendered while open, so a list of hundreds of rows costs
 * nothing until a group is opened.
 */
export function Fold({ open, onToggle, title, meta, children }: FoldProps) {
  const bodyId = useId();
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
