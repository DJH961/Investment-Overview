import { describe, expect, it } from "vitest";
import { sessionsFromTimes } from "./impactFormat";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function day(open: number, steps: number): number[] {
  return Array.from({ length: steps + 1 }, (_, i) => open + i * 30 * MIN);
}

describe("sessionsFromTimes", () => {
  it("splits a week of 30-minute samples at the closed hours", () => {
    const open = Date.UTC(2026, 10, 16, 14, 30);
    const times = [0, 1, 4, 5].flatMap((d) => day(open + d * DAY, 13));
    const s = sessionsFromTimes(times);
    expect(s).toHaveLength(4);
    expect(s[0].open).toBe(open);
    expect(s[0].close).toBe(open + 13 * 30 * MIN);
  });

  it("keeps an unbroken series as one session and ignores too little data", () => {
    expect(sessionsFromTimes(day(0, 20))).toHaveLength(1);
    expect(sessionsFromTimes([0])).toEqual([]);
  });
});
