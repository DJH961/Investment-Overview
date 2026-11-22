import clsx from "clsx";
import { Check, ChevronDown } from "lucide-react";
import { DropdownMenu, ToggleGroup } from "radix-ui";
import { useIsPhone } from "../../lib/useMediaQuery";
import "./RangePicker.scss";

export interface RangePickerOption<T extends string> {
  value: T;
  label: string;
  /** Spoken name when the short label is not enough ("All" -> "All, since you started"). */
  hint?: string;
}

export interface RangePickerProps<T extends string> {
  options: RangePickerOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the control ("Range"). */
  label: string;
  /** The option that is the owner's main range: set in heavier type, in both layouts. */
  emphasis?: T;
  className?: string;
}

/**
 * The page range picker that lives in the sticky section bar, so it is in reach from any
 * section. Tablet and up: every range as a compact segmented row. Phone: one chip that
 * shows the current range and opens a menu of 44px rows (the row would not fit at 360 px).
 * Keyboard: arrow keys and Enter in both layouts, Escape closes the menu.
 */
export function RangePicker<T extends string>({ options, value, onChange, label, emphasis, className }: RangePickerProps<T>) {
  const phone = useIsPhone();
  const current = options.find((o) => o.value === value);
  if (phone) {
    return (
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" className={clsx("range-picker__chip", className)} aria-label={`${label}: ${current?.hint ?? current?.label ?? value}`}>
            <span className="range-picker__chip-label">{label}</span>
            <span className="range-picker__chip-value">{current?.label ?? value}</span>
            <ChevronDown aria-hidden className="range-picker__chip-icon" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="range-picker__menu" align="end" sideOffset={6}>
            <DropdownMenu.RadioGroup value={value} onValueChange={(next) => onChange(next as T)}>
              {options.map((o) => (
                <DropdownMenu.RadioItem
                  key={o.value}
                  value={o.value}
                  className={clsx("range-picker__option", o.value === emphasis && "range-picker__option--emphasis")}
                >
                  <span className="range-picker__option-label">{o.hint ?? o.label}</span>
                  <DropdownMenu.ItemIndicator className="range-picker__option-check">
                    <Check aria-hidden />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    );
  }
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      aria-label={label}
      onValueChange={(next) => {
        if (next) onChange(next as T);
      }}
      className={clsx("range-picker", className)}
    >
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          aria-label={o.hint}
          title={o.hint}
          className={clsx("range-picker__item", o.value === emphasis && "range-picker__item--emphasis")}
        >
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
