import { describe, expect, it } from "vitest";
import { clockOffset, framesAt, marketAt, MOMENTS, namedInstant, nyDay, parseMoment, sessionEvents } from "./moment";

const TUESDAY = Math.round(Date.UTC(2026, 10, 24) / 86_400_000); // 24 Nov 2026 (winter: UTC-5)
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "Z";

describe("parseMoment", () => {
  it("knows the named moments, relative to the Tuesday", () => {
    expect(iso(parseMoment("preopen", TUESDAY)!)).toBe("2026-11-24T14:20:00Z");
    expect(iso(parseMoment("closing", TUESDAY)!)).toBe("2026-11-24T21:00:40Z");
    expect(iso(parseMoment("closed", TUESDAY)!)).toBe("2026-11-24T21:04:00Z");
    expect(iso(parseMoment("fxfri", TUESDAY)!)).toBe("2026-11-27T22:05:00Z");
    expect(iso(parseMoment("fxsun", TUESDAY)!)).toBe("2026-11-29T22:20:00Z");
    for (const name of MOMENTS) expect(parseMoment(name, TUESDAY)).not.toBeNull();
  });

  it("takes summer time into account", () => {
    const summer = Math.round(Date.UTC(2026, 5, 30) / 86_400_000);
    expect(iso(namedInstant("preopen", summer))).toBe("2026-06-30T13:20:00Z");
  });

  it("accepts ISO instants and rejects the rest", () => {
    expect(iso(parseMoment("2026-11-24T20:58:00Z", TUESDAY)!)).toBe("2026-11-24T20:58:00Z");
    expect(parseMoment("2026-11-24", TUESDAY)).toBeNull();
    expect(parseMoment("lunch", TUESDAY)).toBeNull();
    expect(parseMoment("live", TUESDAY)).toBeNull();
    expect(parseMoment(null, TUESDAY)).toBeNull();
  });
});

describe("clockOffset", () => {
  it("is the target minus the real clock", () => {
    expect(clockOffset(5_000, 2_000)).toBe(3_000);
    expect(clockOffset(1_000, 4_000)).toBe(-3_000);
  });
});

describe("marketAt", () => {
  const at = (name: (typeof MOMENTS)[number]) => marketAt(namedInstant(name, TUESDAY));

  it("walks the session from the first bell to the close", () => {
    expect(at("preopen")).toMatchObject({ payloadOpen: false, live: false, preopen: true });
    expect(at("opening")).toMatchObject({ payloadOpen: true, live: false, opening: true });
    expect(at("firsttick")).toMatchObject({ payloadOpen: true, live: true });
    expect(at("preclose")).toMatchObject({ payloadOpen: true, live: true });
    expect(at("closing")).toMatchObject({ payloadOpen: true, live: false, closingWindow: true });
    expect(at("closed")).toMatchObject({ payloadOpen: false, live: false });
  });

  it("shows the last session before the open and the day itself after it", () => {
    expect(at("preopen").dataDay).toBe(TUESDAY - 1);
    expect(at("opening").dataDay).toBe(TUESDAY - 1);
    expect(at("opening").graphDay).toBe(TUESDAY);
    expect(at("firsttick").dataDay).toBe(TUESDAY);
    expect(at("closed").dataDay).toBe(TUESDAY);
  });

  it("freezes the FX from Friday 17:00 to Sunday 17:00 New York time", () => {
    expect(at("closed").fxFrozen).toBe(false);
    expect(at("fxfri")).toMatchObject({ fxFrozen: true, dataDay: TUESDAY + 3 });
    expect(at("fxfri").fxReopenAt).toBe("2026-11-29T22:00:00+00:00");
    expect(at("fxsun")).toMatchObject({ fxFrozen: false, dataDay: TUESDAY + 3 });
    expect(at("fxsun").fresh.next_open_at).toBe("2026-11-30T14:30:00+00:00");
  });

  it("sends the bells a fresh tab would have seen", () => {
    expect(sessionEvents(at("opening"))[0]).toMatchObject({ state: "opening" });
    expect(sessionEvents(at("closing"))[0]).toMatchObject({ state: "closing" });
    expect(sessionEvents(at("closed"))[0]).toMatchObject({ state: "closed" });
    expect(sessionEvents(at("preclose"))).toEqual([]);
  });

  it("finds the New York day of an instant", () => {
    expect(nyDay(Date.parse("2026-11-25T03:00:00Z"))).toBe(TUESDAY);
  });
});

describe("framesAt", () => {
  const recorded = Array.from({ length: 58 }, (_, i) => 1000 + i);
  it("ends the graph at the day's figure, at every moment", () => {
    for (const name of MOMENTS) {
      const { graph, day } = framesAt(marketAt(namedInstant(name, TUESDAY)), recorded, 1000);
      expect(graph.points.length).toBeGreaterThanOrEqual(2);
      expect(graph.tip).toBe(graph.points[graph.points.length - 1].v);
      expect(day.tip).toBeGreaterThan(0);
    }
  });

  it("starts the day from the prev close: a flat stub at the open, last session's close before it", () => {
    const opening = framesAt(marketAt(namedInstant("opening", TUESDAY)), recorded, 1000);
    expect(opening.graph.points.every((p) => p.v === 1000)).toBe(true);
    expect(opening.day.tip).toBeCloseTo(1000, 6);
    expect(framesAt(marketAt(namedInstant("preopen", TUESDAY)), recorded, 1000).graph.tip).toBeCloseTo(1000, 6);
  });
});
