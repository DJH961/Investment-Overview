/**
 * Split date-sorted rows into pages that hold whole months. A page fills with complete
 * month groups up to `size` rows; a month that would overflow starts the next page, and a
 * single month larger than `size` gets a page of its own. Other sorts page by plain slices.
 */
export function pageByMonth<T extends { date: string }>(rows: readonly T[], size: number): T[][] {
  const pages: T[][] = [];
  let current: T[] = [];
  let i = 0;
  while (i < rows.length) {
    const month = rows[i].date.slice(0, 7);
    let j = i;
    while (j < rows.length && rows[j].date.slice(0, 7) === month) j++;
    const group = rows.slice(i, j);
    if (current.length > 0 && current.length + group.length > size) {
      pages.push(current);
      current = [];
    }
    current.push(...group);
    if (current.length >= size) {
      pages.push(current);
      current = [];
    }
    i = j;
  }
  if (current.length > 0) pages.push(current);
  return pages;
}

/** Plain fixed-size slices (non-date sorts, where rows are not grouped by month). */
export function pageBySize<T>(rows: readonly T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < rows.length; i += size) pages.push(rows.slice(i, i + size));
  return pages;
}
