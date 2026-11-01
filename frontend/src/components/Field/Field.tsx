import clsx from "clsx";
import { useId, type ReactNode } from "react";
import "./Field.scss";

export interface FieldControlProps {
  id: string;
  "aria-describedby"?: string;
  invalid: boolean;
}

export interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
  /** Either plain nodes, or a function receiving id / aria wiring for the control. */
  children: ReactNode | ((control: FieldControlProps) => ReactNode);
  className?: string;
}

export function Field({ label, hint, error, children, className }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;
  const control: FieldControlProps = { id, "aria-describedby": describedBy, invalid: Boolean(error) };
  return (
    <div className={clsx("field", error && "field--invalid", className)}>
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {typeof children === "function" ? children(control) : children}
      {hint && !error && (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field__error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
