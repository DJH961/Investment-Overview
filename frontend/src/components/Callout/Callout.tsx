import clsx from "clsx";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "../IconButton";
import "./Callout.scss";

export type CalloutTone = "accent" | "neutral" | "warn";

export interface CalloutProps {
  /** Small uppercase line above the title ("Since you last looked"). */
  eyebrow?: ReactNode;
  title?: ReactNode;
  /** Leading icon (lucide, `aria-hidden`). */
  icon?: ReactNode;
  tone?: CalloutTone;
  /** Right-hand figure (a Money or Percent): the headline number of the note. */
  figure?: ReactNode;
  /** Buttons or links under the body. */
  actions?: ReactNode;
  /** Shows a close button; the caller remembers the dismissal (server or device). */
  onDismiss?: () => void;
  dismissLabel?: string;
  /** Accessible name of the region. */
  label: string;
  className?: string;
  children?: ReactNode;
}

/**
 * A note that sits above the page's content: a soft tinted surface with a left
 * rule, an icon, a sentence and an optional headline figure (v7: the Daily Brief
 * above the Overview hero). Renders nothing special when empty; callers decide
 * whether it shows at all.
 */
export function Callout({
  eyebrow,
  title,
  icon,
  tone = "accent",
  figure,
  actions,
  onDismiss,
  dismissLabel = "Dismiss",
  label,
  className,
  children,
}: CalloutProps) {
  return (
    <section className={clsx("callout", `callout--${tone}`, !icon && "callout--plain", "u-enter", className)} aria-label={label}>
      {icon && <span className="callout__icon">{icon}</span>}
      <div className="callout__main">
        {eyebrow && <p className="callout__eyebrow">{eyebrow}</p>}
        {title && <h2 className="callout__title">{title}</h2>}
        {children && <div className="callout__body">{children}</div>}
        {actions && <div className="callout__actions">{actions}</div>}
      </div>
      {figure && <div className="callout__figure">{figure}</div>}
      {onDismiss && (
        <IconButton className="callout__dismiss" label={dismissLabel} size="sm" icon={<X aria-hidden />} onClick={onDismiss} />
      )}
    </section>
  );
}
