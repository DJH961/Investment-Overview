/**
 * Tests for the value chart's preset selection (`chartTimeframeOptions`): live
 * 1D/1W are always offered when a builder exists, and the optional 3M/6M extra
 * ranges reshape the history slices. Pure logic, no DOM.
 */
import { describe, expect, it } from "vitest";

import { chartTimeframeOptions } from "../src/ui";

/** Just the labels, in order, for terse assertions. */
function labels(span: number, extended: boolean, hasLive: boolean): string[] {
  return chartTimeframeOptions(span, extended, hasLive).map((o) => o.label);
}

describe("chartTimeframeOptions", () => {
  it("default mode prepends live 1D/1W and hides the 3M/6M slices", () => {
    // ~2 years of history → every history slice fits, but 3M/6M are opt-in only.
    expect(labels(730, false, true)).toEqual(["1D", "1W", "1M", "1Y", "All"]);
  });

  it("extra ranges enabled adds the 3M/6M slices back", () => {
    expect(labels(730, true, true)).toEqual(["1D", "1W", "1M", "3M", "6M", "1Y", "All"]);
  });

  it("without a live builder the chart is history-only", () => {
    expect(labels(730, false, false)).toEqual(["1M", "1Y", "All"]);
    expect(labels(730, true, false)).toEqual(["1M", "3M", "6M", "1Y", "All"]);
  });

  it("default mode hides slices longer than the span", () => {
    // ~95 days → 1M fits (needs >36d) but 3M is opt-in (and would need >96d).
    expect(labels(95, false, true)).toEqual(["1D", "1W", "1M", "All"]);
  });

  it("live presets are offered even with no usable history", () => {
    // Too little history for any slice, but the live curves fetch their own data.
    expect(labels(3, false, true)).toEqual(["1D", "1W", "All"]);
  });

  it("returns no controls when nothing is worth toggling", () => {
    // History shorter than the smallest slice, no live builder.
    expect(chartTimeframeOptions(3, false, false)).toEqual([]);
    expect(chartTimeframeOptions(3, true, false)).toEqual([]);
  });

  it("tags live presets with their range and history presets with day windows", () => {
    const opts = chartTimeframeOptions(730, false, true);
    expect(opts[0]).toEqual({ label: "1D", kind: "live", range: "1D" });
    expect(opts[1]).toEqual({ label: "1W", kind: "live", range: "1W" });
    expect(opts.at(-1)).toEqual({ label: "All", kind: "history", days: null });
  });
});
