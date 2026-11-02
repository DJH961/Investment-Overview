import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPersisted, usePersistentState } from "./usePersistentState";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("usePersistentState", () => {
  it("starts from the default and persists updates under iv.<key>", () => {
    const { result } = renderHook(() => usePersistentState("t.range", "1m"));
    expect(result.current[0]).toBe("1m");
    act(() => result.current[1]("1y"));
    expect(result.current[0]).toBe("1y");
    expect(localStorage.getItem("iv.t.range")).toBe('"1y"');
  });

  it("restores a stored value and supports functional updates", () => {
    localStorage.setItem("iv.t.count", "4");
    const { result } = renderHook(() => usePersistentState("t.count", 0));
    expect(result.current[0]).toBe(4);
    act(() => result.current[1]((n) => n + 1));
    expect(localStorage.getItem("iv.t.count")).toBe("5");
  });

  it("rejects values with the wrong shape or bad JSON", () => {
    localStorage.setItem("iv.t.flag", '"true"');
    expect(readPersisted("t.flag", false)).toBe(false);
    localStorage.setItem("iv.t.list", "{not json");
    expect(readPersisted("t.list", [1])).toEqual([1]);
    localStorage.setItem("iv.t.obj", "[1,2]");
    expect(readPersisted("t.obj", { a: 1 })).toEqual({ a: 1 });
    const isRange = (v: unknown): v is "1m" | "1y" => v === "1m" || v === "1y";
    localStorage.setItem("iv.t.r", '"5y"');
    expect(readPersisted("t.r", "1m", isRange)).toBe("1m");
  });

  it("keeps working in memory when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const { result } = renderHook(() => usePersistentState("t.x", "a"));
    expect(result.current[0]).toBe("a");
    act(() => result.current[1]("b"));
    expect(result.current[0]).toBe("b");
  });

  it("does not touch storage with a null key", () => {
    const { result } = renderHook(() => usePersistentState<boolean>(null, true));
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
    expect(localStorage.length).toBe(0);
  });
});
