import clsx from "clsx";
import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { Link, type LinkProps } from "react-router";
import "./Button.scss";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leftIcon?: ReactNode;
  fullWidth?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  leftIcon,
  fullWidth = false,
  className,
  children,
  disabled,
  type = "button",
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={clsx(
        "button",
        `button--${variant}`,
        `button--${size}`,
        fullWidth && "button--full",
        loading && "button--loading",
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Loader2 className="button__spinner" aria-hidden /> : leftIcon}
      {children}
    </button>
  );
}

export interface LinkButtonProps extends LinkProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leftIcon?: ReactNode;
  fullWidth?: boolean;
}

/** A router link that looks like a Button (navigation, not an action: "Open VWCE →"). */
export function LinkButton({ variant = "secondary", size = "md", leftIcon, fullWidth = false, className, children, ...rest }: LinkButtonProps) {
  return (
    <Link
      className={clsx("button", `button--${variant}`, `button--${size}`, "button--link", fullWidth && "button--full", className as string | undefined)}
      {...rest}
    >
      {leftIcon}
      {children}
    </Link>
  );
}
