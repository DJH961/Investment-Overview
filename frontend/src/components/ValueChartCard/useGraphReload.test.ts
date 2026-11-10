import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/api", () => ({
  ApiError: class ApiError extends Error {
    status = 0;
  },
  api: vi.fn(() => Promise.resolve({})),
}));
vi.mock("../../lib/live", () => ({ subscribeLiveEvents: () => () => undefined }));

import { RELOAD_TIMEOUT_MESSAGE, useGraphReload } from "./useGraphReload";

describe("useGraphReload", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("says so when the graphs event never arrives instead of silently stopping", async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useGraphReload(vi.fn(), onError));
    await act(async () => {
      result.current.reload("1M" as never);
    });
    expect(result.current.busy).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(121_000);
    });
    expect(result.current.busy).toBeNull();
    expect(onError).toHaveBeenCalledWith(RELOAD_TIMEOUT_MESSAGE);
  });
});
