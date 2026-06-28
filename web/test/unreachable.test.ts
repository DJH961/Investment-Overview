import { describe, expect, it } from "vitest";

import { PriceError } from "../src/prices";
import {
  DEFAULT_UNREACHABLE_BASE_MS,
  DEFAULT_UNREACHABLE_MAX_MS,
  describeUnreachable,
  unreachableBackoffMs,
} from "../src/unreachable";

describe("unreachableBackoffMs", () => {
  it("returns the base delay for the first unreachable round", () => {
    expect(unreachableBackoffMs(1)).toBe(DEFAULT_UNREACHABLE_BASE_MS);
  });

  it("treats a zero/negative/NaN round count as the first round (never below base)", () => {
    expect(unreachableBackoffMs(0)).toBe(DEFAULT_UNREACHABLE_BASE_MS);
    expect(unreachableBackoffMs(-5)).toBe(DEFAULT_UNREACHABLE_BASE_MS);
    expect(unreachableBackoffMs(Number.NaN)).toBe(DEFAULT_UNREACHABLE_BASE_MS);
  });

  it("doubles each consecutive round", () => {
    const base = 1000;
    expect(unreachableBackoffMs(1, { baseMs: base, maxMs: 1e9 })).toBe(1000);
    expect(unreachableBackoffMs(2, { baseMs: base, maxMs: 1e9 })).toBe(2000);
    expect(unreachableBackoffMs(3, { baseMs: base, maxMs: 1e9 })).toBe(4000);
    expect(unreachableBackoffMs(4, { baseMs: base, maxMs: 1e9 })).toBe(8000);
  });

  it("caps the back-off at maxMs", () => {
    expect(unreachableBackoffMs(50)).toBe(DEFAULT_UNREACHABLE_MAX_MS);
    expect(unreachableBackoffMs(1000, { baseMs: 1000, maxMs: 5000 })).toBe(5000);
  });

  it("never returns more than maxMs even when base exceeds it", () => {
    expect(unreachableBackoffMs(1, { baseMs: 10_000, maxMs: 5_000 })).toBe(5_000);
  });
});

function err(message: string, status: number | null): PriceError {
  return new PriceError(message, { status });
}

describe("describeUnreachable", () => {
  it("returns null when neither provider errored", () => {
    expect(describeUnreachable(null, null)).toBeNull();
  });

  it("classifies a transport failure (no status) as no response", () => {
    const line = describeUnreachable(err("network down", null), null);
    expect(line).toContain("Primary (Twelve Data)");
    expect(line).toContain("no response (network/proxy unreachable)");
    expect(line).toContain('"network down"');
  });

  it("classifies a 429 as rate-limited", () => {
    const line = describeUnreachable(err("too many", 429), null);
    expect(line).toContain("rate-limited (HTTP 429)");
  });

  it("classifies 401/403 as a bad/over-quota key", () => {
    expect(describeUnreachable(err("forbidden", 401), null)).toContain(
      "bad/over-quota API key (HTTP 401)",
    );
    expect(describeUnreachable(err("nope", 403), null)).toContain(
      "bad/over-quota API key (HTTP 403)",
    );
  });

  it("classifies 5xx as a server error", () => {
    expect(describeUnreachable(err("boom", 503), null)).toContain("server error (HTTP 503)");
  });

  it("reports both providers when both failed", () => {
    const line = describeUnreachable(err("td down", null), err("tiingo 429", 429));
    expect(line).toContain("Primary (Twelve Data)");
    expect(line).toContain("Backup (Tiingo)");
    expect(line).toContain("td down");
    expect(line).toContain("tiingo 429");
  });

  it("reports only the backup when only it failed", () => {
    const line = describeUnreachable(null, err("proxy down", null));
    expect(line).not.toContain("Primary (Twelve Data)");
    expect(line).toContain("Backup (Tiingo)");
  });
});
