import { afterEach, describe, expect, it } from "vitest";
import { formatAxisDate, formatDate, formatDateTime, formatMoney, formatNumber, formatPercent, formatTime, setFormatPrefs } from "./format";

afterEach(() => setFormatPrefs({ locale: "en-GB", dateFormat: "auto", numberFormat: "auto", timeZone: undefined, hour12: undefined }));

describe("number format", () => {
  it.each([
    ["1,234.56", "1,234,567.89"],
    ["1.234,56", "1.234.567,89"],
    ["1 234,56", "1 234 567,89"],
    ["1'234.56", "1'234'567.89"],
  ] as const)("writes %s separators", (numberFormat, expected) => {
    setFormatPrefs({ numberFormat });
    expect(formatNumber(1234567.89)).toBe(expected);
  });

  it("applies to currency and percent but keeps the symbol", () => {
    setFormatPrefs({ numberFormat: "1.234,56" });
    expect(formatMoney(1234.5, "USD")).toBe("US$1.234,50");
    expect(formatPercent(0.0525)).toBe("5,25%");
  });

  it("is independent of the regional preset", () => {
    setFormatPrefs({ locale: "de-DE", numberFormat: "1,234.56" });
    expect(formatNumber(1234.5)).toBe("1,234.50");
  });

  it("falls back to the regional preset on auto", () => {
    setFormatPrefs({ locale: "de-DE" });
    expect(formatNumber(1234.5)).toBe("1.234,50");
    setFormatPrefs({ locale: "en-US" });
    expect(formatNumber(1234.5)).toBe("1,234.50");
  });
});

describe("date format", () => {
  it.each([
    ["DD/MM/YYYY", "05/03/2026"],
    ["MM/DD/YYYY", "03/05/2026"],
    ["YYYY-MM-DD", "2026-03-05"],
    ["DD.MM.YYYY", "05.03.2026"],
  ] as const)("lays out %s", (dateFormat, expected) => {
    setFormatPrefs({ dateFormat });
    expect(formatDate("2026-03-05")).toBe(expected);
  });

  it("follows the regional preset on auto", () => {
    setFormatPrefs({ locale: "en-US" });
    expect(formatDate("2026-03-05")).toBe("03/05/2026");
    setFormatPrefs({ locale: "de-DE" });
    expect(formatDate("2026-03-05")).toBe("05.03.2026");
  });

  it("applies to axis labels", () => {
    const t = Date.UTC(2026, 2, 5);
    setFormatPrefs({ dateFormat: "MM/DD/YYYY" });
    expect(formatAxisDate(t, 0)).toBe("03/05");
    expect(formatAxisDate(t, Infinity)).toBe("03/2026");
    setFormatPrefs({ dateFormat: "YYYY-MM-DD" });
    expect(formatAxisDate(t, Infinity)).toBe("2026-03");
  });
});

describe("time format", () => {
  it("renders 24h and 12h independently of the date and number formats", () => {
    setFormatPrefs({ timeZone: "UTC", hour12: false, dateFormat: "MM/DD/YYYY", numberFormat: "1.234,56" });
    expect(formatTime("2026-03-05T14:05:00Z")).toBe("14:05");
    setFormatPrefs({ hour12: true });
    expect(formatTime("2026-03-05T14:05:00Z")).toBe("2:05 PM");
    expect(formatDateTime("2026-03-05T14:05:00Z")).toBe("03/05/2026 2:05 PM");
  });

  it("follows the regional preset on auto", () => {
    setFormatPrefs({ timeZone: "UTC", hour12: undefined, locale: "en-US" });
    expect(formatTime("2026-03-05T14:05:00Z")).toBe("2:05 PM");
    setFormatPrefs({ locale: "de-DE" });
    expect(formatTime("2026-03-05T14:05:00Z")).toBe("14:05");
  });
});
