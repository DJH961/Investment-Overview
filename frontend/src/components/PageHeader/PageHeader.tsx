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

export function PageHeader({ title, subtitle, actions, className }: PageHeaderProps) {
  return (
    <header className={clsx("page-header", className)}>
      <div className="page-header__text">
        <h1 className="page-header__title">{title}</h1>
        {subtitle && <p className="page-header__subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </header>
  );
}
