import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

const { getTimezone, setTimezone, isValidTimezone, timeZoneOption, PRESET_TIMEZONES } =
  await import("../src/timezone");

describe("timezone preference", () => {
  beforeEach(() => {
    store.clear();
    setTimezone("auto");
  });

  it("defaults to auto with no forced timeZone", () => {
    expect(getTimezone()).toBe("auto");
    expect(timeZoneOption()).toEqual({});
  });

  it("accepts and applies a valid IANA zone", () => {
    setTimezone("America/New_York");
    expect(getTimezone()).toBe("America/New_York");
    expect(timeZoneOption()).toEqual({ timeZone: "America/New_York" });
  });

  it("persists a non-default choice and clears storage for auto", () => {
    setTimezone("Europe/Berlin");
    expect(localStorage.getItem("iv.web.timezone")).toBe("Europe/Berlin");
    setTimezone("auto");
    expect(localStorage.getItem("iv.web.timezone")).toBeNull();
  });

  it("ignores an invalid zone, keeping the previous choice", () => {
    setTimezone("Europe/Amsterdam");
    setTimezone("Not/AZone");
    expect(getTimezone()).toBe("Europe/Amsterdam");
  });

  it("validates zones via Intl", () => {
    expect(isValidTimezone("auto")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Totally/Bogus")).toBe(false);
  });

  it("every preset zone is a valid IANA zone", () => {
    for (const zone of PRESET_TIMEZONES) {
      expect(isValidTimezone(zone)).toBe(true);
    }
  });

  it("renders a fixed instant in the chosen zone", () => {
    const when = new Date("2024-01-10T12:00:00Z");
    setTimezone("America/New_York");
    const ny = when.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      ...timeZoneOption(),
    });
    // Noon UTC is 07:00 in New York (EST, UTC-5) in January.
    expect(ny).toMatch(/07:00/);
  });
});
