import { Switch as RadixSwitch } from "radix-ui";
import { useId, type ReactNode } from "react";
import "./Switch.scss";

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  /** Optional second line under the label. */
  hint?: ReactNode;
  disabled?: boolean;
}

/** An on/off setting as a full-width row: label (and hint) left, switch right. */
export function Switch({ checked, onCheckedChange, label, hint, disabled }: SwitchProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  // The label alone names the switch; the hint is its description.
  return (
    <div className="switch">
      <div className="switch__text">
        <label className="switch__label" htmlFor={id}>
          {label}
        </label>
        {hint && (
          <span className="switch__hint" id={hintId}>
            {hint}
          </span>
        )}
      </div>
      <RadixSwitch.Root
        id={id}
        aria-describedby={hint ? hintId : undefined}
        className="switch__root"
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
      >
        <RadixSwitch.Thumb className="switch__thumb" />
      </RadixSwitch.Root>
    </div>
  );
}
