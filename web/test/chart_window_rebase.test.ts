import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";

import type { ChartSeries } from "../src/chart";
import { rebaseWindowOverlays } from "../src/ui";

function n(v: Decimal | null): number | null {
  return v === null ? null : v.toNumber();
}

describe("rebaseWindowOverlays", () => {
  it("re-anchors benchmark and currency overlays to the selected window start", () => {
    const series: ChartSeries[] = [
      { className: "series-portfolio", values: [new Decimal("110"), new Decimal("120")] },
      { className: "series-benchmark", values: [new Decimal("130"), new Decimal("156")] },
      { className: "series-currency", values: [new Decimal("118"), new Decimal("130")] },
    ];
    const out = rebaseWindowOverlays(series);
    expect(n(out[1]!.values[0])).toBeCloseTo(110, 8);
    expect(n(out[2]!.values[0])).toBeCloseTo(110, 8);
    expect(n(out[1]!.values[1])).toBeCloseTo(110 * (156 / 130), 8);
    expect(n(out[2]!.values[1])).toBeCloseTo(110 * (130 / 118), 8);
  });

  it("leaves non-overlay series unchanged", () => {
    const contrib = [new Decimal("90"), new Decimal("100")];
    const series: ChartSeries[] = [
      { className: "series-portfolio", values: [new Decimal("110"), new Decimal("120")] },
      { className: "series-contrib", values: contrib },
    ];
    const out = rebaseWindowOverlays(series);
    expect(out[1]!.values).toEqual(contrib);
  });
});
