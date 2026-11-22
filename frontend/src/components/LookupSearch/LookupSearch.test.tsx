import { describe, expect, it } from "vitest";
import type { LookupResultDto } from "../../lib/queries/lookup";
import { lookupTarget } from "./LookupSearch";

const hit = (over: Partial<LookupResultDto>): LookupResultDto => ({ symbol: "VTI", name: "Vanguard", ...over });

describe("lookupTarget", () => {
  it("opens the holding page only for an open position", () => {
    expect(lookupTarget(hit({ held_instrument_id: 4 }))).toBe("/holdings/4");
  });
  it("opens the lookup page for a sold or never-held instrument", () => {
    expect(lookupTarget(hit({ held_instrument_id: null, sold_instrument_id: 4, last_held_on: "2026-03-04" }))).toBe(
      "/lookup/VTI",
    );
    expect(lookupTarget(hit({}))).toBe("/lookup/VTI");
  });
});
