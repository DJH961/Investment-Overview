import clsx from "clsx";
import { segments } from "../Chart/Chart";
import "./Sparkline.scss";

export interface SparklineProps {
  values: (number | null)[];
  /** auto colours by trend (pos/neg); primary is neutral. */
  tone?: "auto" | "primary" | "pos" | "neg";
  width?: number;
  height?: number;
  ariaLabel?: string;
  className?: string;
}

export function Sparkline({ values, tone = "auto", width = 120, height = 32, ariaLabel, className }: SparklineProps) {
  const nums = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (nums.length < 2)
    return <svg className={clsx("sparkline", className)} width={width} height={height} aria-hidden />;
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const span = hi - lo || 1;
  const pad = 2;
  const pts = values.map((v, i) => ({
    x: pad + (i / (values.length - 1)) * (width - pad * 2),
    y: v === null ? null : pad + (1 - (v - lo) / span) * (height - pad * 2),
  }));
  const resolved = tone === "auto" ? (nums[nums.length - 1] >= nums[0] ? "pos" : "neg") : tone;
  return (
    <svg
      className={clsx("sparkline", `sparkline--${resolved}`, className)}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={ariaLabel ? "img" : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    >
      {segments(pts).map((r, k) => (
        <path key={k} className="sparkline__line" d={r.map((p, j) => `${j ? "L" : "M"}${p.x},${p.y}`).join(" ")} />
      ))}
    </svg>
  );
}
