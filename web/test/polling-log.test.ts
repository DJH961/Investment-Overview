import { beforeEach, describe, expect, it } from "vitest";

import {
  appendPollLog,
  clearPollLog,
  formatPollLog,
  inferLevel,
  readPollLog,
  MAX_POLL_LOG_ENTRIES,
  type PollLogEntry,
} from "../src/polling-log";
import type { StorageLike } from "../src/cache";

/** An in-memory StorageLike for deterministic, isolated tests. */
function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe("polling-log", () => {
  let storage: StorageLike;
  beforeEach(() => {
    storage = memoryStorage();
    clearPollLog(storage);
  });

  it("records entries oldest-first and reads them back", () => {
    appendPollLog("login", "Unlock detected.", { at: 1_000, storage });
    appendPollLog("refresh", "Refresh started: manual.", { at: 2_000, storage });
    const entries = readPollLog(storage);
    expect(entries.map((e) => e.message)).toEqual(["Unlock detected.", "Refresh started: manual."]);
    expect(entries.map((e) => e.category)).toEqual(["login", "refresh"]);
  });

  it("persists an explicit severity level and drops a corrupt one", () => {
    appendPollLog("primary", "fetched 3.", { at: 1_000, storage, level: "good" });
    expect(readPollLog(storage)[0].level).toBe("good");
    // A stored entry with a bogus level is sanitised away on read.
    storage.setItem(
      "iv.web.polling_log",
      JSON.stringify([{ at: 2_000, category: "primary", message: "x", level: "explode" }]),
    );
    expect(readPollLog(storage)[0].level).toBeUndefined();
  });

  it("caps the log at MAX_POLL_LOG_ENTRIES, keeping the newest", () => {
    for (let i = 0; i < MAX_POLL_LOG_ENTRIES + 50; i++) {
      appendPollLog("note", `entry ${i}`, { at: 1_000 + i, storage });
    }
    const entries = readPollLog(storage);
    expect(entries.length).toBe(MAX_POLL_LOG_ENTRIES);
    // The newest entry must be retained; the oldest 50 dropped.
    expect(entries[entries.length - 1].message).toBe(`entry ${MAX_POLL_LOG_ENTRIES + 49}`);
    expect(entries[0].message).toBe("entry 50");
  });

  it("clears the persisted log", () => {
    appendPollLog("note", "x", { at: 1_000, storage });
    clearPollLog(storage);
    expect(readPollLog(storage)).toEqual([]);
  });

  it("formats a downloadable report with header, legend and event lines", () => {
    const entries: PollLogEntry[] = [
      { at: Date.parse("2026-06-23T10:00:00"), category: "refresh", message: "Refresh started: auto." },
      { at: Date.parse("2026-06-23T10:00:01"), category: "primary", message: "fetched 3, deferred 0." },
    ];
    const text = formatPollLog(entries, { version: "9.9.9", generatedAt: Date.parse("2026-06-23T10:00:02") });
    expect(text).toContain("Investment Overview — data polling log");
    expect(text).toContain("App version: 9.9.9");
    expect(text).toContain("Legend:");
    expect(text).toContain("[REFRESH     ]");
    expect(text).toContain("[PRIMARY     ]");
    expect(text).toContain("Refresh started: auto.");
    expect(text).toContain("fetched 3, deferred 0.");
  });

  it("formats an empty log gracefully", () => {
    expect(formatPollLog([], { generatedAt: 0 })).toContain("(no polling activity recorded yet)");
  });

  it("survives malformed stored data without throwing", () => {
    storage.setItem("iv.web.polling_log", "{not json");
    expect(readPollLog(storage)).toEqual([]);
    appendPollLog("note", "after corruption", { at: 5_000, storage });
    expect(readPollLog(storage).map((e) => e.message)).toContain("after corruption");
  });

  describe("inferLevel", () => {
    it("honours an explicit level", () => {
      expect(inferLevel({ at: 0, category: "note", message: "anything", level: "error" })).toBe("error");
    });
    it("flags a genuine, unrecovered failure as error", () => {
      expect(inferLevel({ at: 0, category: "fallback", message: "Backup (Tiingo) needed but unreachable: 429." })).toBe(
        "error",
      );
    });
    it("treats a recovered failure as warn, not error", () => {
      expect(
        inferLevel({ at: 0, category: "graph", message: "Login warm-up: bar backfill failed; graph left for on-demand build." }),
      ).toBe("warn");
    });
    it("reads a deferral / skip as a back-off (warn)", () => {
      expect(inferLevel({ at: 0, category: "primary", message: "deferred 3 to stay within budget." })).toBe("warn");
    });
    it("reads a clean fetch as good", () => {
      expect(inferLevel({ at: 0, category: "primary", message: "fetched 12, served 4 from cache." })).toBe("good");
    });
  });

  describe("round grouping", () => {
    const round = (base: number): PollLogEntry[] => [
      { at: base, category: "refresh", message: "Refresh started: manual (force-all)." },
      { at: base + 1_000, category: "primary", message: "Primary (Twelve Data): fetched 12.", level: "good" },
      { at: base + 2_000, category: "primary", message: "deferred 3 to stay within budget.", level: "warn" },
      {
        at: base + 3_000,
        category: "schedule",
        message:
          "Round complete (manual): 12 live, 4 cached, 3 deferred, 0 failed. Budget left 2/min · 540/day. Next auto-refresh in ~60s (burst to catch up).",
        level: "warn",
      },
    ];

    it("demarcates each round with a start banner and a verdict footer", () => {
      const text = formatPollLog(round(Date.parse("2026-06-23T10:00:00")), { generatedAt: 0 });
      expect(text).toContain("┏━━ ROUND 1 · manual (force-all)");
      // The closing summary becomes the footer verdict, not an inline step.
      expect(text).toContain("┗━━");
      expect(text).toContain("Round complete (manual): 12 live, 4 cached, 3 deferred, 0 failed");
      expect(text).toContain("Budget left 2/min · 540/day");
      // Back-off gutter mark for the deferral line.
      expect(text).toContain("↩");
    });

    it("counts pulling rounds and surfaces the latest budget in the overview", () => {
      const two = [...round(Date.parse("2026-06-23T10:00:00")), ...round(Date.parse("2026-06-23T10:05:00"))];
      const text = formatPollLog(two, { generatedAt: 0 });
      expect(text).toContain("Pulling rounds: 2");
      expect(text).toContain("Latest budget left: 2/min · 540/day");
      expect(text).toContain("┏━━ ROUND 2 ·");
    });

    it("flags rounds that contained a failure", () => {
      const entries: PollLogEntry[] = [
        { at: 1_000, category: "refresh", message: "Refresh started: auto." },
        { at: 2_000, category: "fallback", message: "Backup (Tiingo) needed but unreachable: 429.", level: "error" },
      ];
      const text = formatPollLog(entries, { generatedAt: 0 });
      expect(text).toContain("Rounds with failures: 1");
      expect(text).toContain("✗");
      expect(text).toContain("this round had 1 failure(s)");
    });

    it("labels a skipped auto tick as its own no-pull round", () => {
      const entries: PollLogEntry[] = [
        { at: 1_000, category: "refresh", message: "Auto tick skipped — book fully up to date. Heartbeat only.", level: "warn" },
      ];
      const text = formatPollLog(entries, { generatedAt: 0 });
      expect(text).toContain("auto tick — skipped");
      expect(text).toContain("Pulling rounds: 1");
    });

    it("opens a regenerate's own round so it is not absorbed into the prior refresh", () => {
      const base = Date.parse("2026-06-23T10:00:00");
      const entries: PollLogEntry[] = [
        // A completed manual refresh round...
        { at: base, category: "refresh", message: "Refresh started: manual." },
        {
          at: base + 1_000,
          category: "schedule",
          message: "Round complete (manual): 5 live, 0 cached, 0 deferred, 0 failed. Budget left 3/min · 600/day. Next auto-refresh in ~300s.",
          level: "good",
        },
        // ...then a Settings regenerate fired afterwards must start a NEW block.
        { at: base + 5_000, category: "note", message: "Regenerate 1D graph (Settings) — wiping the stored 1D bars and re-pulling them from scratch." },
        { at: base + 6_000, category: "graph", message: "1D regenerate graph: fetched bars MSFT via Tiingo (Pipe B) — 1 Tiingo credit.", level: "good" },
        {
          at: base + 7_000,
          category: "schedule",
          message: "Round complete (regenerate 1D): 1 credit spent, 1 series stored. Budget left 8/min · 599/day; backup 1/40 this hour · 1/800 today.",
          level: "good",
        },
      ];
      const text = formatPollLog(entries, { generatedAt: 0 });
      expect(text).toContain("┏━━ ROUND 2 · regenerate 1D graph (manual)");
      // Its own footer verdict carries the post-regenerate budget.
      expect(text).toContain("Round complete (regenerate 1D): 1 credit spent, 1 series stored");
      // The macro overview reads the latest budget off the regenerate footer.
      expect(text).toContain("Latest budget left: 8/min · 599/day");
      // …and surfaces the scarce Tiingo backup total too, so a Tiingo-funded 1D
      // regeneration is counted into the macro budget read-out (not just the
      // primary `N/min · M/day`, which a Tiingo-only spend never moves).
      expect(text).toContain("Latest backup (Tiingo) budget: 1/40 this hour · 1/800 today");
    });
  });
});
