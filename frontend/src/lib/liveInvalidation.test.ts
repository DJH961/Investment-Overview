import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleLiveEvent } from "./live";
import { jobAffectsReports, settingsAffectReports } from "./queries/invalidation";

const KEYS: unknown[][] = [
  ["overview", "both"],
  ["holdings", "both", "none"],
  ["graphs", "1d", "both"],
  ["graphs", "1m", "both"],
  ["periods", "monthly", "both"],
  ["allocations", "both"],
  ["analytics", "both", 365],
  ["diagnostics", "status"],
  ["transactions", {}],
];

function seeded(): QueryClient {
  const qc = new QueryClient();
  for (const k of KEYS) qc.setQueryData(k, 1);
  return qc;
}
const stale = (qc: QueryClient) => KEYS.filter((k) => qc.getQueryState(k)?.isInvalidated).map((k) => String(k[0]));

describe("live events invalidate dependent caches", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a finished repair job marks every report and diagnostics stale", () => {
    const qc = seeded();
    handleLiveEvent(qc, JSON.stringify({ type: "job", id: "r1", job: "prices.refresh", status: "succeeded" }));
    expect(new Set(stale(qc))).toEqual(
      new Set(["overview", "holdings", "graphs", "periods", "allocations", "analytics", "diagnostics"]),
    );
  });

  it("a running job or a backup job leaves reports alone", () => {
    const qc = seeded();
    handleLiveEvent(qc, JSON.stringify({ type: "job", id: "r1", job: "prices.refresh", status: "running" }));
    handleLiveEvent(qc, JSON.stringify({ type: "job", id: "r2", job: "backup.run", status: "succeeded" }));
    expect(stale(qc)).toEqual(["diagnostics"]);
  });

  it("a report-relevant settings event refreshes reports, a theme change does not", () => {
    const theme = seeded();
    handleLiveEvent(theme, JSON.stringify({ type: "settings", keys: ["theme"] }));
    expect(stale(theme)).toEqual([]);
    const twin = seeded();
    handleLiveEvent(twin, JSON.stringify({ type: "settings", keys: ["overview_default_range"] }));
    expect(stale(twin)).toContain("overview");
  });

  it("classifies settings and jobs", () => {
    expect(settingsAffectReports(["display_currency", "theme"])).toBe(false);
    expect(settingsAffectReports(["display_currency", "x"])).toBe(true);
    expect(settingsAffectReports([])).toBe(false);
    expect(jobAffectsReports("backup.run")).toBe(false);
    expect(jobAffectsReports("graphs.reload")).toBe(true);
  });
});
