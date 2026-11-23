import clsx from "clsx";
import { segments } from "../Chart/Chart";
import "./Sparkline.scss";

export interface SparklineProps {
  values: (number | null)[];
  /** auto colors by trend (pos/neg); primary is neutral. */
  tone?: "auto" | "primary" | "pos" | "neg";
  /** A faint dashed horizontal line (e.g. your average entry); the scale always includes it. */
  reference?: number | null;
  /** Fill the CSS width (the line stretches; strokes keep their width). */
  stretch?: boolean;
  width?: number;
  height?: number;
  ariaLabel?: string;
  className?: string;
}

export function Sparkline({ values, tone = "auto", reference, stretch = false, width = 120, height = 32, ariaLabel, className }: SparklineProps) {
  const nums = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (nums.length < 2)
    return <svg className={clsx("sparkline", className)} width={width} height={height} aria-hidden />;
  const ref = reference !== null && reference !== undefined && Number.isFinite(reference) ? reference : null;
  const lo = Math.min(...nums, ...(ref === null ? [] : [ref]));
  const hi = Math.max(...nums, ...(ref === null ? [] : [ref]));
  const span = hi - lo || 1;
  const pad = 2;
  const yOf = (v: number) => pad + (1 - (v - lo) / span) * (height - pad * 2);
  const pts = values.map((v, i) => ({
    x: pad + (i / (values.length - 1)) * (width - pad * 2),
    y: v === null ? null : yOf(v),
  }));
  const resolved = tone === "auto" ? (nums[nums.length - 1] >= nums[0] ? "pos" : "neg") : tone;
  return (
    <svg
      className={clsx("sparkline", `sparkline--${resolved}`, stretch && "sparkline--stretch", className)}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio={stretch ? "none" : undefined}
      role={ariaLabel ? "img" : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    >
      {ref !== null ? <line className="sparkline__ref" x1={pad} x2={width - pad} y1={yOf(ref)} y2={yOf(ref)} /> : null}
      {segments(pts).map((r, k) => (
        <path key={k} className="sparkline__line" d={r.map((p, j) => `${j ? "L" : "M"}${p.x},${p.y}`).join(" ")} />
      ))}
    </svg>
  );
}
