/**
 * Tests for the value chart's preset selection (`chartTimeframeOptions`): how the
 * experimental live-graph mode reshapes the range buttons. Pure logic, no DOM.
 */
import { describe, expect, it } from "vitest";

import { chartTimeframeOptions } from "../src/ui";

/** Just the labels, in order, for terse assertions. */
function labels(span: number, experimental: boolean, hasLive: boolean): string[] {
  return chartTimeframeOptions(span, experimental, hasLive).map((o) => o.label);
}

describe("chartTimeframeOptions", () => {
  it("default mode offers the history slices that fit the span, plus All", () => {
    // ~2 years of history → every slice fits.
    expect(labels(730, false, false)).toEqual(["1M", "3M", "6M", "1Y", "All"]);
  });

  it("default mode hides slices longer than the span", () => {
    // ~95 days → 1M fits (needs >36d) but 3M does not (needs >96d).
    expect(labels(95, false, false)).toEqual(["1M", "All"]);
  });

  it("experimental mode drops 3M/6M and prepends live 1D/1W when a builder exists", () => {
    expect(labels(730, true, true)).toEqual(["1D", "1W", "1M", "1Y", "All"]);
  });

  it("experimental mode without a live builder just drops 3M/6M", () => {
    expect(labels(730, true, false)).toEqual(["1M", "1Y", "All"]);
  });

  it("experimental live presets are offered even with no usable history", () => {
    // Too little history for any slice, but the live curves fetch their own data.
    expect(labels(3, true, true)).toEqual(["1D", "1W", "All"]);
  });

  it("returns no controls when nothing is worth toggling", () => {
    // Default mode, history shorter than the smallest slice, no live builder.
    expect(chartTimeframeOptions(3, false, false)).toEqual([]);
    // Experimental but no live builder and no history → still nothing.
    expect(chartTimeframeOptions(3, true, false)).toEqual([]);
  });

  it("tags live presets with their range and history presets with day windows", () => {
    const opts = chartTimeframeOptions(730, true, true);
    expect(opts[0]).toEqual({ label: "1D", kind: "live", range: "1D" });
    expect(opts[1]).toEqual({ label: "1W", kind: "live", range: "1W" });
    expect(opts.at(-1)).toEqual({ label: "All", kind: "history", days: null });
  });
});
