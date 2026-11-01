import clsx from "clsx";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { formatMoney, formatPercent, signOf } from "../../lib/format";
import "./DeltaBadge.scss";

export interface DeltaBadgeProps {
  /** Percent mode: a fraction. Money mode: an amount in `currency`. */
  value: number | null | undefined;
  format?: "percent" | "money";
  currency?: string;
  className?: string;
}

export function DeltaBadge({ value, format = "percent", currency = "EUR", className }: DeltaBadgeProps) {
  const tone = signOf(value);
  const Icon = tone === "pos" ? ArrowUpRight : tone === "neg" ? ArrowDownRight : Minus;
  const text =
    format === "percent" ? formatPercent(value, { signed: true }) : formatMoney(value, currency, { signed: true });
  return (
    <span className={clsx("delta-badge", `delta-badge--${tone}`, className)}>
      <Icon className="delta-badge__icon" aria-hidden />
      {text}
    </span>
  );
}
