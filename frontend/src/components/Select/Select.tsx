import clsx from "clsx";
import { Check, ChevronDown } from "lucide-react";
import { Select as RadixSelect } from "radix-ui";
import "./Select.scss";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  options: SelectOption[];
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  id?: string;
  ariaLabel?: string;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
}

export function Select({
  options,
  value,
  onValueChange,
  placeholder = "Select…",
  id,
  ariaLabel,
  disabled,
  invalid = false,
  className,
}: SelectProps) {
  return (
    <RadixSelect.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <RadixSelect.Trigger
        id={id}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        className={clsx("select__trigger", invalid && "select__trigger--invalid", className)}
      >
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon className="select__chevron">
          <ChevronDown aria-hidden />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content className="select__content" position="popper" sideOffset={4}>
          <RadixSelect.Viewport className="select__viewport">
            {options.map((opt) => (
              <RadixSelect.Item key={opt.value} value={opt.value} className="select__item">
                <RadixSelect.ItemText>{opt.label}</RadixSelect.ItemText>
                <RadixSelect.ItemIndicator className="select__check">
                  <Check aria-hidden />
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
