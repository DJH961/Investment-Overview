import clsx from "clsx";
import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import "./IconButton.scss";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required accessible name (also the native tooltip). */
  label: string;
  icon: ReactNode;
  size?: "sm" | "md" | "lg";
  active?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton({
  label,
  icon,
  size = "md",
  active = false,
  className,
  type = "button",
  ref,
  ...rest
}: IconButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={clsx("icon-button", `icon-button--${size}`, active && "icon-button--active", className)}
      {...rest}
    >
      {icon}
    </button>
  );
}
