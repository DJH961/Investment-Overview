import clsx from "clsx";
import type { ReactNode } from "react";
import "./PageHeader.scss";

export interface PageHeaderProps {
  title: string;
  subtitle?: ReactNode;
  /** Right-aligned actions (buttons, tabs). */
  actions?: ReactNode;
  className?: string;
}

/**
 * Page title row. On phones the title is visually hidden (the top bar already
 * shows it) but stays the page's h1 for screen readers; subtitle and actions stay.
 */
export function PageHeader({ title, subtitle, actions, className }: PageHeaderProps) {
  return (
    <header className={clsx("page-header", !subtitle && !actions && "page-header--bare", className)}>
      <div className="page-header__text">
        <h1 className="page-header__title">{title}</h1>
        {subtitle && <p className="page-header__subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </header>
  );
}
