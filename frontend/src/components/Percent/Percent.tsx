import clsx from "clsx";
import { formatPercent, signOf } from "../../lib/format";
import "./Percent.scss";

export interface PercentProps {
  /** Fraction: 0.0525 renders as 5.25%. */
  ratio: number | null | undefined;
  signed?: boolean;
  colored?: boolean;
  digits?: number;
  className?: string;
}

export function Percent({ ratio, signed = false, colored = false, digits, className }: PercentProps) {
  const tone = colored ? signOf(ratio) : null;
  return (
    <span className={clsx("percent", tone && `percent--${tone}`, className)}>
      {formatPercent(ratio, { signed, digits })}
    </span>
  );
}
