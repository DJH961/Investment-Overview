import clsx from "clsx";
import { ToggleGroup } from "radix-ui";
import "./SegmentedControl.scss";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  size?: "sm" | "md";
  className?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = "md",
  className,
}: SegmentedControlProps<T>) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      aria-label={ariaLabel}
      onValueChange={(next) => {
        if (next) onChange(next as T);
      }}
      className={clsx("segmented", `segmented--${size}`, className)}
    >
      {options.map((opt) => (
        <ToggleGroup.Item key={opt.value} value={opt.value} className="segmented__item">
          {opt.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
