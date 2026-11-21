import clsx from "clsx";
import { sentenceCase } from "../../components/Freshness";
import { Percent } from "../../components/Percent";
import type { HoldingRowDto } from "../../lib/queries/holdings";
import { toNum } from "../../lib/queries/portfolio";

/** A row's own price time, shown only when it differs from the header's (see `foldStamps`). */
export function RowStamp({ text, labelled = false }: { text: string | null; labelled?: boolean }) {
  if (!text) return null;
  return (
    <span className="holdings-page__row-stamp" title={`Price as of ${text}`}>
      <span className={clsx("holdings-page__row-stamp-key", labelled && "holdings-page__row-stamp-key--shown")}>
        Price as of
      </span>{" "}
      {labelled ? text : sentenceCase(text)}
    </span>
  );
}

/**
 * Weight as a number with a thin bar on a shared scale (the largest weight fills it).
 * `start` left-aligns it (the group header); the table right-aligns.
 */
export function WeightCell({ ratio, max, start = false }: { ratio: number | null; max: number; start?: boolean }) {
  const width = ratio !== null && max > 0 ? Math.min((ratio / max) * 100, 100) : 0;
  return (
    <span className={clsx("holdings-page__weight", start && "holdings-page__weight--start")}>
      <Percent ratio={ratio} digits={1} />
      <span className="holdings-page__weight-bar" aria-hidden>
        <span className="holdings-page__weight-fill" style={{ width: `${width}%` }} />
      </span>
    </span>
  );
}

/**
 * Row class for holdings in profit / loss: an accent edge (blue / orange), never a full-row wash.
 * Judged on total return, so a cash fund that earns only dividends — its NAV pinned
 * at par, its capital gain 0 — is tinted for the profit it is actually making.
 */
export function tintClass(row: HoldingRowDto): string | undefined {
  const gain = toNum(row.total_return);
  if (gain === null || gain === 0) return undefined;
  return gain > 0 ? "holdings-page__row--gain" : "holdings-page__row--loss";
}

/** Small outlined "≈ est." pill: the figure next to it is an ETF-twin estimate, not an official one. */
export function EstChip({ children = "≈ est." }: { children?: string }) {
  return <span className="holdings-page__est">{children}</span>;
}
