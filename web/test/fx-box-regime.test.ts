import { describe, expect, it } from "vitest";

import { fxBoxRegime } from "../src/ui";

// EDT (UTC-4) reference week around Fri 2026-06-26 → Mon 2026-06-29. Forex closes
// Fri 17:00 ET (21:00 UTC) and reopens Sun 17:00 ET (21:00 UTC); the NYSE session
// runs 09:30–16:00 ET (13:30–20:00 UTC).
describe("fxBoxRegime", () => {
  it("treats a live weekday session as a session view (not single-overnight)", () => {
    const r = fxBoxRegime(new Date("2026-06-24T15:00:00Z")); // Wed 11:00 ET
    expect(r.marketOpen).toBe(true);
    expect(r.sessionView).toBe(true);
    expect(r.singleOvernight).toBe(false);
    expect(r.forexFrozen).toBe(false);
  });

  it("freezes Friday after the forex close (Fri >=17:00 ET)", () => {
    const r = fxBoxRegime(new Date("2026-06-26T21:30:00Z")); // Fri 17:30 ET
    expect(r.forexFrozen).toBe(true);
    expect(r.sessionView).toBe(true); // the frozen Friday view keeps the split
    expect(r.singleOvernight).toBe(false);
  });

  it("stays frozen all of Saturday", () => {
    const r = fxBoxRegime(new Date("2026-06-27T15:00:00Z"));
    expect(r.forexFrozen).toBe(true);
    expect(r.sessionView).toBe(true);
    expect(r.weekendOvernight).toBe(false);
  });

  it("stays frozen on Sunday morning before the reopen", () => {
    const r = fxBoxRegime(new Date("2026-06-28T14:00:00Z")); // Sun 10:00 ET
    expect(r.forexFrozen).toBe(true);
    expect(r.singleOvernight).toBe(false);
  });

  it("is a single weekend-overnight on Sunday evening after the reopen", () => {
    const r = fxBoxRegime(new Date("2026-06-28T22:00:00Z")); // Sun 18:00 ET
    expect(r.forexFrozen).toBe(false);
    expect(r.marketOpen).toBe(false);
    expect(r.weekendOvernight).toBe(true);
    expect(r.singleOvernight).toBe(true);
    expect(r.sessionView).toBe(false);
    expect(r.holiday).toBe(false);
  });

  it("is a single weekend-overnight on Monday before the open", () => {
    const r = fxBoxRegime(new Date("2026-06-29T12:00:00Z")); // Mon 08:00 ET
    expect(r.weekendOvernight).toBe(true);
    expect(r.singleOvernight).toBe(true);
  });

  it("returns to a regular session view once Monday opens", () => {
    const r = fxBoxRegime(new Date("2026-06-29T15:00:00Z")); // Mon 11:00 ET
    expect(r.marketOpen).toBe(true);
    expect(r.sessionView).toBe(true);
    expect(r.weekendOvernight).toBe(false);
  });

  it("does NOT treat a Tuesday pre-open as weekend-overnight", () => {
    const r = fxBoxRegime(new Date("2026-06-30T12:00:00Z")); // Tue 08:00 ET
    expect(r.marketOpen).toBe(false);
    expect(r.weekendOvernight).toBe(false);
    expect(r.singleOvernight).toBe(false);
    expect(r.sessionView).toBe(true); // regular settled/pre-open split
  });

  it("keeps the holiday regime on a US market holiday that is not an FX holiday", () => {
    // 2026-07-03 (Friday) is the observed Independence Day holiday; forex trades.
    const r = fxBoxRegime(new Date("2026-07-03T15:00:00Z")); // 11:00 ET
    expect(r.holiday).toBe(true);
    expect(r.marketOpen).toBe(false);
    expect(r.forexFrozen).toBe(false);
    expect(r.singleOvernight).toBe(true);
    expect(r.weekendOvernight).toBe(false);
  });
});
