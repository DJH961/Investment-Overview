import { describe, expect, it, vi } from "vitest";
import { preloadPages } from "./routeChunks";

describe("preloadPages", () => {
  it("loads one chunk per idle slot, Holdings first, and can be cancelled", async () => {
    const queue: Array<() => void> = [];
    const loaded: string[] = [];
    const cancel = preloadPages(
      (cb) => queue.push(cb),
      async (n) => {
        loaded.push(n);
      },
    );
    expect(loaded).toEqual([]); // nothing until the browser is idle
    queue.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    expect(loaded).toEqual(["Holdings"]);
    expect(queue).toHaveLength(1); // next one waits for the next idle slot
    cancel();
    queue.shift()!();
    await Promise.resolve();
    expect(loaded).toEqual(["Holdings"]);
  });

  it("keeps going when a chunk fails to load", async () => {
    const queue: Array<() => void> = [];
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    preloadPages((cb) => queue.push(cb), load);
    queue.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    expect(queue).toHaveLength(1);
  });
});
