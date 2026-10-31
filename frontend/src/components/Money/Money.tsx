import clsx from "clsx";
import { formatMoney, signOf } from "../../lib/format";
import "./Money.scss";

export interface MoneyProps {
  amount: number | null | undefined;
  /** Native currency of the amount (ISO code). */
  currency: string;
  /** Always show +/- sign. */
  signed?: boolean;
  /** Colour by sign (gain/loss tokens). */
  colored?: boolean;
  compact?: boolean;
  digits?: number;
  className?: string;
}

export function Money({ amount, currency, signed = false, colored = false, compact, digits, className }: MoneyProps) {
  const tone = colored ? signOf(amount) : null;
  return (
    <span className={clsx("money", tone && `money--${tone}`, className)}>
      {formatMoney(amount, currency, { signed, compact, digits })}
    </span>
  );
}
