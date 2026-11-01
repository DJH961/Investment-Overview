import clsx from "clsx";
import { useId } from "react";
import "./BrandMark.scss";

export interface BrandMarkProps {
  /** Rendered width and height in px. */
  size?: number;
  /**
   * `false` draws only the bars in `currentColor`, for places that already
   * paint the gradient tile behind the mark.
   */
  tile?: boolean;
  /** Accessible name; without it the mark is decorative (aria-hidden). */
  label?: string;
  className?: string;
}

/**
 * The app logo: three rising bars on a rounded indigo-to-cyan tile. Same
 * geometry as public/favicon.svg (see scripts/gen-icons.mjs).
 */
export function BrandMark({ size = 32, tile = true, label, className }: BrandMarkProps) {
  const gradientId = useId();
  return (
    <svg
      className={clsx("brand-mark", !tile && "brand-mark--glyph", className)}
      viewBox="0 0 512 512"
      width={size}
      height={size}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {tile && (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" className="brand-mark__stop brand-mark__stop--start" />
              <stop offset="1" className="brand-mark__stop brand-mark__stop--end" />
            </linearGradient>
          </defs>
          <rect width="512" height="512" rx="96" fill={`url(#${gradientId})`} />
        </>
      )}
      <g className="brand-mark__bars">
        <rect x="96" y="288" width="64" height="128" rx="16" />
        <rect x="224" y="192" width="64" height="224" rx="16" />
        <rect x="352" y="96" width="64" height="320" rx="16" />
      </g>
    </svg>
  );
}
