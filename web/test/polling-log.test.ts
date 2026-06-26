import { beforeEach, describe, expect, it } from "vitest";

import {
  appendPollLog,
  clearPollLog,
  formatPollLog,
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
    appendPollLog("login", "Unlock detected.", 1_000, storage);
    appendPollLog("refresh", "Refresh started: manual.", 2_000, storage);
    const entries = readPollLog(storage);
    expect(entries.map((e) => e.message)).toEqual(["Unlock detected.", "Refresh started: manual."]);
    expect(entries.map((e) => e.category)).toEqual(["login", "refresh"]);
  });

  it("caps the log at MAX_POLL_LOG_ENTRIES, keeping the newest", () => {
    for (let i = 0; i < MAX_POLL_LOG_ENTRIES + 50; i++) {
      appendPollLog("note", `entry ${i}`, 1_000 + i, storage);
    }
    const entries = readPollLog(storage);
    expect(entries.length).toBe(MAX_POLL_LOG_ENTRIES);
    // The newest entry must be retained; the oldest 50 dropped.
    expect(entries[entries.length - 1].message).toBe(`entry ${MAX_POLL_LOG_ENTRIES + 49}`);
    expect(entries[0].message).toBe("entry 50");
  });

  it("clears the persisted log", () => {
    appendPollLog("note", "x", 1_000, storage);
    clearPollLog(storage);
    expect(readPollLog(storage)).toEqual([]);
  });

  it("formats a downloadable report with header and one line per entry", () => {
    const entries: PollLogEntry[] = [
      { at: Date.parse("2026-06-23T10:00:00"), category: "refresh", message: "Refresh started: auto." },
      { at: Date.parse("2026-06-23T10:00:01"), category: "primary", message: "fetched 3, deferred 0." },
    ];
    const text = formatPollLog(entries, { version: "9.9.9", generatedAt: Date.parse("2026-06-23T10:00:02") });
    expect(text).toContain("Investment Overview — data polling log");
    expect(text).toContain("App version: 9.9.9");
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
    appendPollLog("note", "after corruption", 5_000, storage);
    expect(readPollLog(storage).map((e) => e.message)).toContain("after corruption");
  });
});
