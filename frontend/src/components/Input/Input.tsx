import clsx from "clsx";
import type { InputHTMLAttributes, ReactNode, Ref } from "react";
import "./Input.scss";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  /** Decorative icon shown inside the left edge. */
  leftIcon?: ReactNode;
  ref?: Ref<HTMLInputElement>;
}

export function Input({ invalid = false, leftIcon, className, ref, ...rest }: InputProps) {
  return (
    <span className={clsx("input", invalid && "input--invalid", leftIcon && "input--icon", className)}>
      {leftIcon && <span className="input__icon">{leftIcon}</span>}
      <input ref={ref} className="input__control" aria-invalid={invalid || undefined} {...rest} />
    </span>
  );
}
