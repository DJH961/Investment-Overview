import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveStatus } from "../../lib/live";
import { useLiveGrace } from "./useLiveGrace";

describe("useLiveGrace", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps the old status through a short blip, then admits reconnecting", () => {
    const { result, rerender } = renderHook(({ s }: { s: LiveStatus }) => useLiveGrace(s, 10_000), {
      initialProps: { s: "connected" as LiveStatus },
    });
    expect(result.current).toBe("connected");
    rerender({ s: "reconnecting" });
    expect(result.current).toBe("connected");
    act(() => {
      vi.advanceTimersByTime(9_000);
    });
    expect(result.current).toBe("connected");
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(result.current).toBe("reconnecting");
  });

  it("never shows reconnecting when the stream comes back inside the grace period", () => {
    const { result, rerender } = renderHook(({ s }: { s: LiveStatus }) => useLiveGrace(s, 10_000), {
      initialProps: { s: "connected" as LiveStatus },
    });
    rerender({ s: "reconnecting" });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    rerender({ s: "connected" });
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(result.current).toBe("connected");
  });
});
