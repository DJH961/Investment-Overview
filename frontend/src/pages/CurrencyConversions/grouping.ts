/** Pure helpers for folding a long list by year and for the period filter. */

export interface YearBlock<T> {
  /** "2025" */
  year: string;
  items: T[];
}

/**
 * Year blocks, newest year first. Inside a year the items keep the order they came in
 * (the caller sorts newest first by date, then entry order).
 */
export function groupByYear<T>(items: readonly T[], dateOf: (item: T) => string): YearBlock<T>[] {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const year = dateOf(item).slice(0, 4);
    const bucket = map.get(year);
    if (bucket) bucket.push(item);
    else map.set(year, [item]);
  }
  return [...map.entries()].sort((x, y) => (x[0] < y[0] ? 1 : -1)).map(([year, list]) => ({ year, items: list }));
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
