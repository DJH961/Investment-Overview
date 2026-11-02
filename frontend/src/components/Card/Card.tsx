import clsx from "clsx";
import { ChevronDown } from "lucide-react";
import { useId, type HTMLAttributes, type ReactNode } from "react";
import { usePersistentState } from "../../lib/usePersistentState";
import "./Card.scss";

/** localStorage namespace for fold state: `iv.fold.<collapsibleId>`. */
export const FOLD_KEY_PREFIX = "fold.";

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Right-aligned header actions (buttons, segmented control). Hidden while folded. */
  actions?: ReactNode;
  /** Remove body padding (tables that run edge to edge). */
  flush?: boolean;
  /** Show a fold/unfold toggle in the header (needs a `title`). */
  collapsible?: boolean;
  /** Initial state for a collapsible card when nothing is remembered. Default: open. */
  defaultOpen?: boolean;
  /**
   * Stable id that remembers the fold state per device (`iv.fold.<id>` in
   * localStorage). Implies `collapsible`.
   */
  collapsibleId?: string;
}

export function Card({
  title,
  subtitle,
  actions,
  flush = false,
  collapsible = false,
  defaultOpen = true,
  collapsibleId,
  className,
  children,
  ...rest
}: CardProps) {
  const foldable = Boolean(title) && (collapsible || collapsibleId !== undefined);
  const [storedOpen, setOpen] = usePersistentState<boolean>(
    foldable && collapsibleId ? FOLD_KEY_PREFIX + collapsibleId : null,
    defaultOpen,
  );
  const open = !foldable || storedOpen;
  const bodyId = useId();
  const hasHeader = title || subtitle || actions;

  return (
    <section className={clsx("card", foldable && "card--collapsible", !open && "card--collapsed", className)} {...rest}>
      {hasHeader && (
        <header className="card__header">
          <div className="card__heading">
            {title && (
              <h2 className="card__title">
                {foldable ? (
                  <button
                    type="button"
                    className="card__toggle"
                    aria-expanded={open}
                    aria-controls={bodyId}
                    onClick={() => setOpen((o) => !o)}
                  >
                    <ChevronDown className="card__chevron" aria-hidden />
                    <span className="card__title-text">{title}</span>
                  </button>
                ) : (
                  title
                )}
              </h2>
            )}
            {subtitle && <p className="card__subtitle">{subtitle}</p>}
          </div>
          {actions && open && <div className="card__actions">{actions}</div>}
        </header>
      )}
      <div id={bodyId} className={clsx("card__body", flush && "card__body--flush")} hidden={!open}>
        {open && children}
      </div>
    </section>
  );
}
