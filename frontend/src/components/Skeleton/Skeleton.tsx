import clsx from "clsx";
import type { CSSProperties } from "react";
import "./Skeleton.scss";

export interface SkeletonProps {
  /** CSS width (default 100%). */
  width?: string;
  /** CSS height (default 1em). */
  height?: string;
  circle?: boolean;
  className?: string;
}

export function Skeleton({ width, height, circle = false, className }: SkeletonProps) {
  const style: CSSProperties = { width, height };
  return <span aria-hidden className={clsx("skeleton", circle && "skeleton--circle", className)} style={style} />;
}
