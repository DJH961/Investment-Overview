import { describe, expect, it } from "vitest";

import {
  autoFetchScope,
  classifyRefreshPhase,
  manualFetchScope,
  scopeFetchesAnything,
  type RefreshPhase,
} from "../src/refresh-window";

describe("classifyRefreshPhase", () => {
  it("is 'market' whenever the session is open — even if a NAV looks behind", () => {
    expect(classifyRefreshPhase({ marketOpen: true, navOutstanding: false })).toBe("market");
    // A NAV can't strike until the close, so the open session always wins.
    expect(classifyRefreshPhase({ marketOpen: true, navOutstanding: true })).toBe("market");
  });

  it("is 'pre-nav' once closed while a NAV is still genuinely due", () => {
    expect(classifyRefreshPhase({ marketOpen: false, navOutstanding: true })).toBe("pre-nav");
  });

  it("is 'settled' once closed with every close and NAV in hand", () => {
    expect(classifyRefreshPhase({ marketOpen: false, navOutstanding: false })).toBe("settled");
  });
});

describe("manualFetchScope", () => {
  it("market: pulls only live stock prices, never a NAV", () => {
    expect(manualFetchScope("market")).toEqual({ market: true, nav: false });
  });

  it("pre-nav: pulls only the awaited NAVs, leaving settled closes alone", () => {
    expect(manualFetchScope("pre-nav")).toEqual({ market: false, nav: true });
  });

  it("settled: re-pulls everything (the off-hours verification tap)", () => {
    expect(manualFetchScope("settled")).toEqual({ market: true, nav: true });
  });
});

describe("autoFetchScope", () => {
  it("mirrors the manual scope while trading and while a NAV is awaited", () => {
    expect(autoFetchScope("market")).toEqual({ market: true, nav: false });
    expect(autoFetchScope("pre-nav")).toEqual({ market: false, nav: true });
  });

  it("fetches nothing once settled — no automatic pulls after the close", () => {
    expect(autoFetchScope("settled")).toEqual({ market: false, nav: false });
    expect(scopeFetchesAnything(autoFetchScope("settled"))).toBe(false);
  });
});

describe("scopeFetchesAnything", () => {
  it("is true whenever either market or NAV is requested", () => {
    const phases: RefreshPhase[] = ["market", "pre-nav", "settled"];
    expect(phases.map((p) => scopeFetchesAnything(manualFetchScope(p)))).toEqual([true, true, true]);
    expect(phases.map((p) => scopeFetchesAnything(autoFetchScope(p)))).toEqual([true, true, false]);
  });
});
