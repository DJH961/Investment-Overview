import clsx from "clsx";
import type { HTMLAttributes, ReactNode } from "react";
import "./Chip.scss";

export type ChipTone = "neutral" | "accent" | "pos" | "neg" | "warn" | "estimate";

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  /** Leading icon (lucide, `aria-hidden`). Status chips always carry one or a word: never color alone. */
  icon?: ReactNode;
  tone?: ChipTone;
  size?: "sm" | "md";
  /** Outlined instead of a soft fill (a quieter tag, e.g. "Last session"). */
  outline?: boolean;
  children: ReactNode;
}

/**
 * A small pill: a status, a tag, a clock ("Opens 15:30"). The tone tints the icon
 * and border; the text stays readable fg/muted so a protan reader never depends on
 * the hue. Long text truncates with an ellipsis (`title` gives the full form).
 */
export function Chip({ icon, tone = "neutral", size = "md", outline = false, className, children, ...rest }: ChipProps) {
  return (
    <span className={clsx("chip", `chip--${tone}`, `chip--${size}`, outline && "chip--outline", className)} {...rest}>
      {icon && <span className="chip__icon">{icon}</span>}
      <span className="chip__label">{children}</span>
    </span>
  );
}
