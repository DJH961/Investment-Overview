import { describe, expect, it } from "vitest";

import {
  CORE_VALUES,
  checkDataCoverage,
  coverageLogLevel,
  marketConditionFrom,
  summarizeCoverage,
  type BlobPresence,
  type CoreValue,
  type CoverageInputs,
  type DeviceFreshness,
  type LoadSource,
  type MarketCondition,
} from "../src/coverage-check";

const MARKETS: MarketCondition[] = [
  "pre-open",
  "open-lt-30m",
  "open-steady",
  "after-close-nav-pending",
  "overnight",
  "weekend",
  "holiday",
];

const FRESHNESS: DeviceFreshness[] = [
  "fresh",
  "relatively-fresh",
  "minorly-outdated",
  "heavily-outdated",
  "empty-device",
  "first-login-currency-unknown",
];

const BLOBS: BlobPresence[] = ["fresh", "stale", "absent"];

function sourcesFor(verdict: ReturnType<typeof checkDataCoverage>, value: CoreValue): LoadSource[] {
  return verdict.coverage.find((c) => c.value === value)!.sources;
}

function hasHoldings(inputs: CoverageInputs): boolean {
  const blobPresent = inputs.blob !== "absent";
  const cache =
    inputs.freshness !== "empty-device" && inputs.freshness !== "first-login-currency-unknown";
  return blobPresent || cache;
}

describe("checkDataCoverage — the completeness guarantee", () => {
  it("covers every core value across the entire market × freshness × blob matrix once holdings are known", () => {
    for (const market of MARKETS) {
      for (const freshness of FRESHNESS) {
        for (const blob of BLOBS) {
          const inputs: CoverageInputs = { market, freshness, blob };
          const verdict = checkDataCoverage(inputs);
          if (hasHoldings(inputs)) {
            // The core guarantee: every core value has at least one load path.
            expect(verdict.ok, JSON.stringify(inputs)).toBe(true);
            expect(verdict.missing, JSON.stringify(inputs)).toEqual([]);
            expect(verdict.awaitingBlob).toBe(false);
            for (const c of verdict.coverage) {
              expect(c.covered, `${c.value} @ ${JSON.stringify(inputs)}`).toBe(true);
              expect(c.sources.length).toBeGreaterThan(0);
            }
          } else {
            // No blob and an empty device → nothing to load yet (blob-first contract).
            expect(verdict.awaitingBlob, JSON.stringify(inputs)).toBe(true);
          }
        }
      }
    }
  });

  it("reports awaitingBlob only when there is no blob and no cache", () => {
    for (const market of MARKETS) {
      for (const freshness of FRESHNESS) {
        for (const blob of BLOBS) {
          const verdict = checkDataCoverage({ market, freshness, blob });
          expect(verdict.awaitingBlob).toBe(!hasHoldings({ market, freshness, blob }));
        }
      }
    }
  });

  it("reports all five core values in a stable order", () => {
    const verdict = checkDataCoverage({ market: "open-steady", freshness: "fresh", blob: "fresh" });
    expect(verdict.coverage.map((c) => c.value)).toEqual([...CORE_VALUES]);
    expect([...CORE_VALUES]).toEqual(["prices", "fx", "oneDay", "oneWeek", "longRange"]);
  });
});

describe("long-range reconstruction is the guaranteed empty/stale path (item 1)", () => {
  it("offers a reconstruction path for the long-range history whenever holdings are known", () => {
    for (const market of MARKETS) {
      for (const freshness of FRESHNESS) {
        for (const blob of BLOBS) {
          const inputs: CoverageInputs = { market, freshness, blob };
          if (!hasHoldings(inputs)) continue;
          expect(sourcesFor(checkDataCoverage(inputs), "longRange")).toContain("reconstruction");
        }
      }
    }
  });

  it("covers long-range history even when the blob is stale and the store is empty", () => {
    // The exact gap the from-scratch reconstruction was added to close: a stale
    // blob (present, decryptable) on an otherwise-empty device.
    const verdict = checkDataCoverage({
      market: "overnight",
      freshness: "empty-device",
      blob: "stale",
    });
    expect(verdict.ok).toBe(true);
    expect(sourcesFor(verdict, "longRange")).toContain("reconstruction");
    expect(sourcesFor(verdict, "longRange")).toContain("blob");
  });
});

describe("market-condition gaps (item 4)", () => {
  it("always has an FX fallback over the weekend, when live forex is shut", () => {
    for (const freshness of FRESHNESS) {
      for (const blob of BLOBS) {
        const inputs: CoverageInputs = { market: "weekend", freshness, blob };
        if (!hasHoldings(inputs)) continue;
        const fx = sourcesFor(checkDataCoverage(inputs), "fx");
        // No live forex on the weekend, but the blob's settled rate or cache hold.
        expect(fx).not.toContain("orchestrator");
        expect(fx.length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps a live FX leg available on a holiday (forex trades through US equity holidays)", () => {
    const fx = sourcesFor(
      checkDataCoverage({ market: "holiday", freshness: "fresh", blob: "fresh" }),
      "fx",
    );
    expect(fx).toContain("orchestrator");
  });

  it("offers no live intraday leg before the warm-up window has passed", () => {
    const justOpened = sourcesFor(
      checkDataCoverage({ market: "open-lt-30m", freshness: "fresh", blob: "fresh" }),
      "oneDay",
    );
    // Inside warm-up there is no settled intraday bar; blob/reconstruction cover it.
    expect(justOpened).not.toContain("orchestrator");
    expect(justOpened.length).toBeGreaterThan(0);
    const steady = sourcesFor(
      checkDataCoverage({ market: "open-steady", freshness: "fresh", blob: "fresh" }),
      "oneDay",
    );
    expect(steady).toContain("orchestrator");
  });
});

describe("empty-device blob-first contract", () => {
  it("an empty device with a blob can load every core value (blob establishes holdings)", () => {
    for (const market of MARKETS) {
      for (const blob of ["fresh", "stale"] as BlobPresence[]) {
        const verdict = checkDataCoverage({ market, freshness: "empty-device", blob });
        expect(verdict.ok, `${market}/${blob}`).toBe(true);
        // Each covered value names the blob as a path (it is the floor).
        for (const c of verdict.coverage) expect(c.sources).toContain("blob");
      }
    }
  });

  it("an empty device with no blob is awaitingBlob (cannot invent holdings)", () => {
    const verdict = checkDataCoverage({
      market: "open-steady",
      freshness: "empty-device",
      blob: "absent",
    });
    expect(verdict.awaitingBlob).toBe(true);
    expect(summarizeCoverage({ market: "open-steady", freshness: "empty-device", blob: "absent" }, verdict)).toContain(
      "awaiting blob",
    );
  });

  it("first-login-currency-unknown behaves like an empty device for coverage", () => {
    const withBlob = checkDataCoverage({
      market: "pre-open",
      freshness: "first-login-currency-unknown",
      blob: "fresh",
    });
    expect(withBlob.ok).toBe(true);
    const withoutBlob = checkDataCoverage({
      market: "pre-open",
      freshness: "first-login-currency-unknown",
      blob: "absent",
    });
    expect(withoutBlob.awaitingBlob).toBe(true);
  });
});

describe("summarizeCoverage / coverageLogLevel", () => {
  it("renders a complete verdict at good level", () => {
    const inputs: CoverageInputs = { market: "open-steady", freshness: "fresh", blob: "fresh" };
    const verdict = checkDataCoverage(inputs);
    expect(summarizeCoverage(inputs, verdict)).toContain("complete");
    expect(coverageLogLevel(verdict)).toBe("good");
  });

  it("renders an awaiting-blob verdict at info level", () => {
    const inputs: CoverageInputs = { market: "weekend", freshness: "empty-device", blob: "absent" };
    const verdict = checkDataCoverage(inputs);
    expect(coverageLogLevel(verdict)).toBe("info");
  });

  it("names the missing value and warns when a gap is somehow present", () => {
    // Synthesize a gap verdict to lock the wording (the real check never gaps).
    const verdict = {
      ok: false,
      awaitingBlob: false,
      missing: ["longRange"] as CoreValue[],
      coverage: [],
    };
    const inputs: CoverageInputs = { market: "overnight", freshness: "fresh", blob: "fresh" };
    expect(summarizeCoverage(inputs, verdict)).toContain("longRange");
    expect(summarizeCoverage(inputs, verdict)).toContain("GAP");
    expect(coverageLogLevel(verdict)).toBe("warn");
  });
});

describe("marketConditionFrom — flags → condition mapping", () => {
  const base = {
    isEquityTradingDay: true,
    isWeekend: false,
    isHoliday: false,
    isMarketOpen: false,
    isWarmingUp: false,
    isAfterCloseNavPending: false,
    isBeforeOpen: false,
  };

  it("maps weekend and holiday first", () => {
    expect(marketConditionFrom({ ...base, isWeekend: true, isEquityTradingDay: false })).toBe(
      "weekend",
    );
    expect(
      marketConditionFrom({ ...base, isHoliday: true, isEquityTradingDay: false }),
    ).toBe("holiday");
  });

  it("splits open into warm-up vs steady", () => {
    expect(marketConditionFrom({ ...base, isMarketOpen: true, isWarmingUp: true })).toBe(
      "open-lt-30m",
    );
    expect(marketConditionFrom({ ...base, isMarketOpen: true })).toBe("open-steady");
  });

  it("maps after-close NAV-pending, overnight, and pre-open", () => {
    expect(marketConditionFrom({ ...base, isAfterCloseNavPending: true })).toBe(
      "after-close-nav-pending",
    );
    expect(marketConditionFrom({ ...base, isBeforeOpen: true })).toBe("pre-open");
    expect(marketConditionFrom(base)).toBe("overnight");
  });
});
