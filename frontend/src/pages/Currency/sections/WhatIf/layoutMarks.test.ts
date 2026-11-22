import { describe, expect, it } from "vitest";
import { layoutMarks } from "./layoutMarks";

describe("layoutMarks", () => {
  it("keeps far-apart marks on the first row", () => {
    const out = layoutMarks(
      [
        { x: 20, w: 60 },
        { x: 200, w: 60 },
      ],
      320,
    );
    expect(out.map((p) => p.lane)).toEqual([0, 0]);
  });

  it("puts a label that holds a neighbour's tick on a deeper row", () => {
    const out = layoutMarks(
      [
        { x: 100, w: 120 },
        { x: 130, w: 80 },
      ],
      400,
    );
    expect(out[0]!.lane).toBeGreaterThan(out[1]!.lane);
  });

  it("pulls a label that would run past the right edge back onto the track", () => {
    const [p] = layoutMarks([{ x: 300, w: 100 }], 320);
    expect(300 + p!.dx + 100).toBeLessThanOrEqual(320);
  });
});
