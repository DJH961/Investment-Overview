import clsx from "clsx";
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { EmptyState } from "../EmptyState";
import { ErrorState } from "../ErrorState";
import { Skeleton } from "../Skeleton";
import { StatStrip, type StatItem } from "../StatStrip";
import "./CurrencySection.scss";

/** What a section shows: its skeleton, an error, a calm empty note, or its content. */
export type CurrencySectionState = "loading" | "error" | "empty" | "ready";

export interface CurrencySectionProps {
  /** Anchor id: the section bar scrolls here (`/currency#<id>`). The registry id. */
  id: string;
  title: string;
  /** One line under the title: what question the section answers. */
  explainer?: ReactNode;
  /** A quiet note at the right of the title line (the range it describes: "1Y"). */
  meta?: ReactNode;
  /** Server `stats` made into strip items (see `serverStatItem`); left out when empty. */
  stats?: StatItem[];
  /** Accessible name of the strip (default: "<title> at a glance"). */
  statsLabel?: string;
  state: CurrencySectionState;
  onRetry?: () => void;
  errorTitle?: string;
  emptyTitle?: string;
  emptyDescription?: ReactNode;
  emptyIcon?: ReactNode;
  /** Skeleton block heights while loading (rem). Default: a strip and one panel. */
  skeleton?: string[];
  /** New data is on its way: the content stays, dimmed. */
  busy?: boolean;
  className?: string;
  children?: ReactNode;
}

/**
 * One section of the Currency page (v7.2 contract with 7.3): title, one-line
 * explainer, an optional strip of server figures, then the content, or its
 * skeleton, error or empty state. Every section uses it, so they all look and
 * behave the same. Load-on-scroll is the page's job (`useLoadOnScroll`): a section
 * mounts, and so fetches, only once it is near the viewport.
 */
export function CurrencySection({
  id,
  title,
  explainer,
  meta,
  stats,
  statsLabel,
  state,
  onRetry,
  errorTitle,
  emptyTitle,
  emptyDescription,
  emptyIcon,
  skeleton = ["4.5rem", "16rem"],
  busy = false,
  className,
  children,
}: CurrencySectionProps) {
  const headingId = useId();
  return (
    <section
      id={id}
      className={clsx("currency-section", busy && "currency-section--busy", className)}
      aria-labelledby={headingId}
      aria-busy={state === "loading" || busy || undefined}
      data-section={id}
    >
      <header className="currency-section__header">
        <div className="currency-section__heading">
          <h2 className="currency-section__title" id={headingId}>
            {title}
          </h2>
          {meta ? <span className="currency-section__meta">{meta}</span> : null}
        </div>
        {explainer ? <p className="currency-section__explainer">{explainer}</p> : null}
      </header>
      {state === "loading" ? (
        <div className="currency-section__skeleton">
          {skeleton.map((h, i) => (
            <Skeleton key={i} height={h} />
          ))}
        </div>
      ) : state === "error" ? (
        <ErrorState title={errorTitle ?? `${title} could not be loaded`} onRetry={onRetry} />
      ) : state === "empty" ? (
        <EmptyState icon={emptyIcon} title={emptyTitle ?? "Nothing to show yet"} description={emptyDescription} />
      ) : (
        <div className="currency-section__body">
          {stats && stats.length > 0 ? (
            <StatStrip className="stat-strip--rows" label={statsLabel ?? `${title} at a glance`} items={stats} />
          ) : null}
          {children}
        </div>
      )}
    </section>
  );
}

/**
 * True once the element has come within `margin` of the viewport (and stays true).
 * Without IntersectionObserver (tests, old browsers) it is true at once. `force`
 * mounts it straight away (the section bar jumping past it).
 */
export function useLoadOnScroll<T extends Element>(
  ref: RefObject<T | null>,
  { margin = "600px", force = false }: { margin?: string; force?: boolean } = {},
): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (seen) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setSeen(true);
      },
      { rootMargin: `${margin} 0px ${margin} 0px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, margin, seen]);
  return seen || force;
}

/**
 * A registry section that mounts when it scrolls near: until then the shell's own
 * skeleton under the section's title holds its place (and its anchor).
 */
export function CurrencySectionSlot({
  id,
  label,
  force,
  children,
}: {
  id: string;
  label: string;
  force?: boolean;
  children: () => ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const seen = useLoadOnScroll(ref, { force });
  return (
    <div ref={ref} className="currency-section-slot" data-slot={id}>
      {seen ? children() : <CurrencySection id={id} title={label} state="loading" />}
    </div>
  );
}
