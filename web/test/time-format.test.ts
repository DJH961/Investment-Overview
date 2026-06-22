import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

const { clockOptions, getTimeFormat, setTimeFormat } = await import("../src/time-format");

describe("time-format preference", () => {
  beforeEach(() => {
    store.clear();
    setTimeFormat("auto");
  });

  it("defaults to auto (locale) with no forced hour12", () => {
    expect(getTimeFormat()).toBe("auto");
    expect(clockOptions()).toEqual({});
  });

  it("forces 12-hour AM/PM", () => {
    setTimeFormat("12h");
    expect(getTimeFormat()).toBe("12h");
    expect(clockOptions()).toEqual({ hour12: true });
  });

  it("forces 24-hour", () => {
    setTimeFormat("24h");
    expect(getTimeFormat()).toBe("24h");
    expect(clockOptions()).toEqual({ hour12: false });
  });

  it("persists a non-default choice and clears storage for auto", () => {
    setTimeFormat("24h");
    expect(localStorage.getItem("iv.web.time_format")).toBe("24h");
    setTimeFormat("auto");
    expect(localStorage.getItem("iv.web.time_format")).toBeNull();
  });

  it("renders a 24h time without AM/PM and a 12h time with it", () => {
    const when = new Date("2024-01-10T15:30:00");
    setTimeFormat("24h");
    const h24 = when.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", ...clockOptions() });
    expect(h24).not.toMatch(/[AP]M/i);
    setTimeFormat("12h");
    const h12 = when.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", ...clockOptions() });
    expect(h12).toMatch(/[AP]M/i);
  });
});
