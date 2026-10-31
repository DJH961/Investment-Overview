import clsx from "clsx";
import type { HTMLAttributes, ReactNode } from "react";
import "./Card.scss";

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Right-aligned header actions (buttons, segmented control). */
  actions?: ReactNode;
  /** Remove body padding (tables that run edge to edge). */
  flush?: boolean;
}

export function Card({ title, subtitle, actions, flush = false, className, children, ...rest }: CardProps) {
  const hasHeader = title || subtitle || actions;
  return (
    <section className={clsx("card", className)} {...rest}>
      {hasHeader && (
        <header className="card__header">
          <div className="card__heading">
            {title && <h2 className="card__title">{title}</h2>}
            {subtitle && <p className="card__subtitle">{subtitle}</p>}
          </div>
          {actions && <div className="card__actions">{actions}</div>}
        </header>
      )}
      <div className={clsx("card__body", flush && "card__body--flush")}>{children}</div>
    </section>
  );
}
