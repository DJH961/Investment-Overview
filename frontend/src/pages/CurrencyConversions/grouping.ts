import { getFormatPrefs } from "../../lib/format";

/** Pure helpers for folding a long list by year and month and for the period filter. */

export interface MonthGroup<T> {
  /** "2026-10" */
  key: string;
  items: T[];
}

export interface YearBlock<T> {
  /** "2025" */
  year: string;
  months: MonthGroup<T>[];
  count: number;
}

/** Month groups, newest first; the items inside keep the order they came in. */
export function groupByMonth<T>(items: readonly T[], dateOf: (item: T) => string): MonthGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = dateOf(item).slice(0, 7);
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([key, list]) => ({ key, items: list }));
}

export type Section<T> = { kind: "month"; group: MonthGroup<T> } | { kind: "year"; block: YearBlock<T> };

/**
 * Newest first: months of this year (and later) stand on their own; every older year folds
 * into one year header that holds its months.
 */
export function buildSections<T>(groups: readonly MonthGroup<T>[], thisYear: string): Section<T>[] {
  const out: Section<T>[] = [];
  for (const g of groups) {
    const year = g.key.slice(0, 4);
    if (year >= thisYear) {
      out.push({ kind: "month", group: g });
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.kind === "year" && last.block.year === year) {
      last.block.months.push(g);
      last.block.count += g.items.length;
    } else {
      out.push({ kind: "year", block: { year, months: [g], count: g.items.length } });
    }
  }
  return out;
}

/** The two newest months that have entries are open at first (the current and the previous one in daily use). */
export function newestMonths(keys: readonly string[], n = 2): Set<string> {
  return new Set([...keys].sort().reverse().slice(0, n));
}

/** "October 2026" in the user's locale. */
export function monthLabel(key: string): string {
  return new Intl.DateTimeFormat(getFormatPrefs().locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${key}-01T00:00:00Z`),
  );
}

export const PERIOD_ALL = "all";
export const PERIOD_YTD = "ytd";
export const PERIOD_12M = "12m";

function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Is a calendar date inside the period ("all", "ytd", "12m" or a year like "2025")? */
export function inPeriod(date: string, period: string, today: string): boolean {
  if (period === PERIOD_ALL) return true;
  if (period === PERIOD_YTD) return date.slice(0, 4) === today.slice(0, 4) && date <= today;
  if (period === PERIOD_12M) return date > shiftDays(today, -365) && date <= today;
  return /^\d{4}$/.test(period) ? date.slice(0, 4) === period : true;
}

/** Period choices: This year, Last 12 months, every year that has data, All. */
export function periodOptions(dates: readonly string[], today: string): { value: string; label: string }[] {
  const thisYear = today.slice(0, 4);
  const years = [...new Set(dates.map((d) => d.slice(0, 4)))].filter((y) => y !== thisYear).sort().reverse();
  return [
    { value: PERIOD_ALL, label: "All time" },
    { value: PERIOD_YTD, label: "This year" },
    { value: PERIOD_12M, label: "Last 12 months" },
    ...years.map((y) => ({ value: y, label: y })),
  ];
}

/** A period that is not one of the offered values falls back to "all" (a stale link). */
export function validPeriod(period: string | null, options: readonly { value: string }[]): string {
  return period !== null && options.some((o) => o.value === period) ? period : PERIOD_ALL;
}
