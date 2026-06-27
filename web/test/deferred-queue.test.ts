import { describe, expect, it } from "vitest";

import { DEFERRED_MAX_ATTEMPTS, DeferredQueue } from "../src/deferred-queue";

describe("DeferredQueue — enqueue (C9)", () => {
  it("parks symbols and reports its size", () => {
    const q = new DeferredQueue();
    q.enqueue(["AAA", "BBB"], "over budget");
    expect(q.size).toBe(2);
    expect(q.has("AAA")).toBe(true);
    expect(q.has("CCC")).toBe(false);
  });

  it("ignores empty symbols", () => {
    const q = new DeferredQueue();
    q.enqueue(["", "AAA"], "over budget");
    expect(q.size).toBe(1);
  });

  it("re-deferring an existing symbol updates the reason without resetting attempts", () => {
    const q = new DeferredQueue(64, 2);
    q.enqueue(["AAA"], "first reason");
    // One drain bumps AAA to 1 attempt.
    q.drain(() => false);
    // Re-deferring must not reset the attempt count, so the next drain reaches the
    // cap (2) and the one after drops it — proving attempts survived the re-enqueue.
    q.enqueue(["AAA"], "second reason");
    expect(q.drain(() => false).stillMissing).toEqual(["AAA"]); // attempts now 2 (== cap)
    expect(q.drain(() => false).exhausted).toEqual(["AAA"]); // attempts 3 (> cap) ⇒ dropped
  });

  it("is bounded — the oldest entries are evicted past the cap", () => {
    const q = new DeferredQueue(3);
    q.enqueue(["A", "B", "C", "D", "E"], "flood");
    expect(q.size).toBe(3);
    // A and B (oldest) were evicted; C, D, E remain.
    expect(q.has("A")).toBe(false);
    expect(q.has("B")).toBe(false);
    expect(q.has("E")).toBe(true);
  });
});

describe("DeferredQueue — drain (C9)", () => {
  it("clears symbols the cache/blob has since satisfied without re-fetching them", () => {
    const q = new DeferredQueue();
    q.enqueue(["AAA", "BBB"], "over budget");
    const satisfied = new Set(["AAA"]);
    const result = q.drain((s) => satisfied.has(s));
    expect(result.clearedBySatisfied).toEqual(["AAA"]);
    expect(result.stillMissing).toEqual(["BBB"]);
    expect(q.has("AAA")).toBe(false); // cleared
    expect(q.has("BBB")).toBe(true); // still parked
  });

  it("returns the still-missing symbols and keeps them parked", () => {
    const q = new DeferredQueue();
    q.enqueue(["AAA"], "over budget");
    expect(q.drain(() => false).stillMissing).toEqual(["AAA"]);
    expect(q.has("AAA")).toBe(true);
  });

  it("drops a never-filling symbol once it exceeds the retry cap", () => {
    const q = new DeferredQueue();
    q.enqueue(["AAA"], "over budget");
    // It survives exactly DEFERRED_MAX_ATTEMPTS drains, then is dropped.
    for (let i = 0; i < DEFERRED_MAX_ATTEMPTS; i += 1) {
      expect(q.drain(() => false).stillMissing).toEqual(["AAA"]);
    }
    const final = q.drain(() => false);
    expect(final.exhausted).toEqual(["AAA"]);
    expect(final.stillMissing).toEqual([]);
    expect(q.has("AAA")).toBe(false);
  });

  it("is a no-op on an empty queue", () => {
    const q = new DeferredQueue();
    const result = q.drain(() => false);
    expect(result).toEqual({ stillMissing: [], clearedBySatisfied: [], exhausted: [] });
  });

  it("keeps an explicit force deferral even when a fresh cached value would satisfy it", () => {
    const q = new DeferredQueue();
    // AAA is a normal deferral, BBB an explicit (Reset base / Force-fetch) one.
    q.enqueue(["AAA"], "auto round over budget");
    q.enqueue(["BBB"], "force round over budget", true);
    // Both look "fresh" — the freshness optimisation must clear AAA but not BBB.
    const result = q.drain(() => true);
    expect(result.clearedBySatisfied).toEqual(["AAA"]);
    expect(result.stillMissing).toEqual(["BBB"]);
    expect(q.has("AAA")).toBe(false);
    expect(q.has("BBB")).toBe(true);
  });

  it("ages out an explicit force deferral via the retry cap so it can't burst forever", () => {
    const q = new DeferredQueue();
    q.enqueue(["AAA"], "force round over budget", true);
    for (let i = 0; i < DEFERRED_MAX_ATTEMPTS; i += 1) {
      // Always "fresh", yet kept because it is a force deferral.
      expect(q.drain(() => true).stillMissing).toEqual(["AAA"]);
    }
    expect(q.drain(() => true).exhausted).toEqual(["AAA"]);
    expect(q.has("AAA")).toBe(false);
  });
});

describe("DeferredQueue — force flag & clear (freshness-plan)", () => {
  it("clear() forgets fetched symbols and reports which were parked", () => {
    const q = new DeferredQueue();
    q.enqueue(["AAA", "BBB"], "over budget");
    expect(q.clear(["AAA", "CCC"])).toEqual(["AAA"]); // CCC was never parked
    expect(q.has("AAA")).toBe(false);
    expect(q.has("BBB")).toBe(true);
  });

  it("the force flag is sticky — an ordinary re-defer cannot downgrade it", () => {
    const q = new DeferredQueue();
    q.enqueue(["AAA"], "force round over budget", true);
    // A later ordinary round re-defers AAA without the force flag.
    q.enqueue(["AAA"], "auto round over budget");
    // It must still survive the freshness clear.
    expect(q.drain(() => true).stillMissing).toEqual(["AAA"]);
  });

  it("upgrades an existing ordinary deferral to force when re-deferred explicitly", () => {
    const q = new DeferredQueue();
    q.enqueue(["AAA"], "auto round over budget");
    q.enqueue(["AAA"], "force round over budget", true);
    expect(q.drain(() => true).stillMissing).toEqual(["AAA"]);
  });
});
