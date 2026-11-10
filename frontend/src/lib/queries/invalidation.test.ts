import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { INVALIDATION, invalidateFor, type InvalidationKind } from "./invalidation";

/** Every root a real query uses, so a mutation's key set can be compared against all of them. */
const ALL_KEYS: unknown[][] = [
  ["auth", "me"],
  ["overview", "both"],
  ["holdings", "both", "none"],
  ["holdings", "history", 1, "1y"],
  ["graphs", "1d", "both"],
  ["periods", "monthly", "both"],
  ["allocations", "both"],
  ["analytics", "both", 365],
  ["calculator", "inputs", "both"],
  ["calculator", "projection", "EUR", {}],
  ["deposits", "both", null, null, null],
  ["deposits", "dividends", "both"],
  ["transactions", {}],
  ["transaction", 1],
  ["instruments"],
  ["accounts"],
  ["settings", "values"],
  ["fx-conversions"],
  ["import-batches", 50],
  ["diagnostics", "status"],
  ["maintenance", "jobs"],
];

function invalidatedBy(kind: InvalidationKind): string[] {
  const qc = new QueryClient();
  for (const key of ALL_KEYS) qc.setQueryData(key, 1);
  void invalidateFor(qc, kind);
  return ALL_KEYS.filter((k) => qc.getQueryState(k)?.isInvalidated).map((k) => k.slice(0, 2).join("/")).sort();
}

describe("write -> invalidated keys", () => {
  it.each(Object.keys(INVALIDATION) as InvalidationKind[])("%s", (kind) => {
    expect(invalidatedBy(kind)).toMatchSnapshot();
  });

  it("never touches auth, settings or maintenance, and spares projections", () => {
    for (const kind of Object.keys(INVALIDATION) as InvalidationKind[]) {
      const hit = invalidatedBy(kind);
      expect(hit.some((k) => k.startsWith("auth") || k.startsWith("settings") || k.startsWith("maintenance"))).toBe(false);
      expect(hit).not.toContain("calculator/projection");
    }
  });

  it("a transaction write leaves instruments, accounts and fx conversions alone", () => {
    const hit = invalidatedBy("transactionWrite");
    expect(hit).toContain("overview/both");
    expect(hit).not.toContain("instruments");
    expect(hit).not.toContain("accounts");
    expect(hit).not.toContain("fx-conversions");
  });

  it("an account rename or an import refreshes the lists that show account names", () => {
    for (const kind of ["accountWrite", "importWrite"] as const) {
      const hit = invalidatedBy(kind);
      expect(hit).toContain("accounts");
      expect(hit).toContain("holdings/both");
      expect(hit).toContain("transactions/[object Object]");
      expect(hit).toContain("deposits/both");
    }
  });
});
