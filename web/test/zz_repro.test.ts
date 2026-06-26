import { describe, it } from "vitest";
import { buildCoverageFacts } from "../src/app";
import { latestExpectedNavDate } from "../src/quotes";
import { latestSettledSessionDate, lastSessionDate, previousTradingSession } from "../src/market-hours";

describe("repro 3am NAV awaiting", () => {
  it("3am local, hold previous market day NAV", () => {
    // 3am Wed 2024-05-15 local time
    const now = new Date(2024, 4, 15, 3, 0, 0);
    console.log("now:", now.toString());
    console.log("settled:", latestSettledSessionDate(now));
    console.log("lastSession:", lastSessionDate(now));
    const due = latestExpectedNavDate(now, 22);
    console.log("due (publishHour 22):", due);
    console.log("prevTradingSession(due):", previousTradingSession(due));

    // User holds NAV value-dated for the day BEFORE settled (NAVs land a day late)
    for (const held of ["2024-05-14", "2024-05-13"]) {
      const f = buildCoverageFacts(
        { fetched: [], servedFresh: ["VTSAX"], deferred: [], failed: [], error: null, dayRemaining: 100 } as any,
        new Map([["VTSAX", { valueDate: held }]]),
        new Set(["VTSAX"]),
        { now, marketOpen: false, publishHourFor: () => 22 },
      );
      console.log(`held=${held} -> navAwaiting=${f.navAwaiting}, navExpectedTonight=${f.navExpectedTonight}`);
    }
  });
});
