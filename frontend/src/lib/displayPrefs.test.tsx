import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_DISPLAY_PREFS, DisplayPrefsProvider, prefsFromValues, resolveTimeZone, useDisplayPrefs } from "./displayPrefs";
import { formatDate, formatMoney, formatTime, getFormatPrefs, setFormatPrefs } from "./format";
import type { SettingsValues } from "./queries/settings";

const v = (value: unknown) =>
  ({ value, source: "db", default: null, env_value_present: false, modified_at: null, is_set: true, stored_invalid: false }) as never;

const VALUES: SettingsValues = {
  "display.locale": v("de-DE"),
  display_timezone: v("America/New_York"),
  clock_format: v("24h"),
  "display.overview_default_range": v("1y"),
  "display.holdings_default_range": v("3m"),
  "chart_pref.analytics_lookback": v(180),
  display_currency: v("USD"),
  theme: v("dark"),
};

afterEach(() => {
  localStorage.clear();
  setFormatPrefs({ locale: "en-GB", timeZone: undefined, hour12: undefined });
});

describe("displayPrefs", () => {
  it("maps server values", () => {
    const p = prefsFromValues(VALUES);
    expect(p).toMatchObject({
      locale: "de-DE",
      timeZone: "America/New_York",
      hour12: false,
      overviewRange: "1y",
      holdingsRange: "3m",
      riskLookback: 180,
      currency: "USD",
      theme: "dark",
    });
  });

  it("treats Browser / Local as the device zone and ignores junk", () => {
    expect(resolveTimeZone("Browser")).toBeUndefined();
    expect(resolveTimeZone("Local")).toBeUndefined();
    expect(resolveTimeZone("Not/AZone")).toBeUndefined();
    expect(resolveTimeZone("UTC")).toBe("UTC");
    expect(prefsFromValues({ "display.locale": v("xx-XX") }).locale).toBe(DEFAULT_DISPLAY_PREFS.locale);
  });

  it("drives lib/format and caches per device", () => {
    function Probe() {
      const p = useDisplayPrefs();
      return <span>{`${p.holdingsRange} ${formatMoney(1234.5, "EUR")}`}</span>;
    }
    render(
      <DisplayPrefsProvider values={VALUES}>
        <Probe />
      </DisplayPrefsProvider>,
    );
    expect(screen.getByText(/^3m /).textContent).toContain("1.234,50");
    expect(getFormatPrefs()).toEqual({ locale: "de-DE", timeZone: "America/New_York", hour12: false });
    expect(JSON.parse(localStorage.getItem("iv.displayPrefs") ?? "{}").locale).toBe("de-DE");
  });
});

describe("format with prefs", () => {
  it("uses the locale for numbers", () => {
    setFormatPrefs({ locale: "de-DE" });
    expect(formatMoney(1234.5, "EUR")).toContain("1.234,50");
    setFormatPrefs({ locale: "en-US" });
    expect(formatMoney(1234.5, "USD")).toBe("$1,234.50");
  });

  it("shows timestamps in the chosen zone, calendar dates unshifted", () => {
    setFormatPrefs({ timeZone: "America/New_York", hour12: false });
    expect(formatTime("2026-03-05T15:30:00Z")).toBe("10:30");
    // An explicit zone argument still wins.
    expect(formatTime("2026-03-05T15:30:00Z", "UTC")).toBe("15:30");
    expect(formatDate("2026-03-05")).toContain("5");
    expect(formatDate("2026-03-06T02:00:00Z")).toContain("5 Mar");
    setFormatPrefs({ hour12: true });
    expect(formatTime("2026-03-05T15:30:00Z")).toMatch(/10:30\s?am/i);
  });
});
