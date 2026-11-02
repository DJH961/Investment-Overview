import type { PeriodRowOut } from "../../lib/queries/reports";

export interface YearGroup {
  year: string;
  /** Yearly summary row from the server, when it has one for this year. */
  summary: PeriodRowOut | undefined;
  /** Monthly rows of that year, newest first. */
  months: PeriodRowOut[];
  isCurrent: boolean;
}

/** Period labels start with the year ("2026", "2026-10"). Pure grouping, no maths. */
export function yearOf(label: string): string {
  return label.slice(0, 4);
}

/** Groups monthly rows under their year (newest year first) and pairs each with its yearly row. */
export function groupByYear(monthly: PeriodRowOut[], yearly: PeriodRowOut[]): YearGroup[] {
  const byYear = new Map<string, PeriodRowOut[]>();
  for (const r of monthly) {
    const y = yearOf(r.label);
    const list = byYear.get(y);
    if (list) list.push(r);
    else byYear.set(y, [r]);
  }
  const summaries = new Map(yearly.map((r) => [yearOf(r.label), r]));
  for (const y of summaries.keys()) if (!byYear.has(y)) byYear.set(y, []);
  return [...byYear.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([year, months]) => {
      const summary = summaries.get(year);
      return {
        year,
        summary,
        months: [...months].reverse(),
        isCurrent: summary?.is_current ?? months.some((m) => m.is_current),
      };
    });
}
