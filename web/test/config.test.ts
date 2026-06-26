/**
 * Config resolution and the portable config packet. `resolveBlobUrl` returns the
 * configured data-source URL; `resolveMetaUrl` derives the version-sidecar
 * endpoint; `serializeConfig`/`parseConfigPacket` round-trip an export file.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  resolveBlobUrl,
  resolveMetaUrl,
  resolvePriceProxyUrl,
  parseUpdateMinutes,
  parseProviderLimit,
  applyProviderLimits,
  serializeConfig,
  parseConfigPacket,
  CONFIG_PACKET_TYPE,
  type AppConfig,
} from "../src/config";
import {
  DEFAULT_PROVIDER_LIMITS,
  providerLimits,
  resetProviderLimits,
} from "../src/provider-limits";
import { FREE_TIER } from "../src/quotes";
import { WEB_HOURLY_CAP, WEB_DAILY_CAP } from "../src/tiingo-gate";

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    apiKey: "k",
    blobUrl: "https://proxy.example/portfolio.enc",
    priceProxyUrl: "",
    updateMinutes: 15,
    autoLockMinutes: 5,
    twelveDataPerMinute: 8,
    twelveDataPerDay: 800,
    tiingoPerHour: 40,
    tiingoPerDay: 800,
    resumeOnRefresh: false,
    ...overrides,
  };
}

describe("resolvePriceProxyUrl", () => {
  it("derives the /price route from an explicit blob Worker origin", () => {
    expect(resolvePriceProxyUrl(config({ blobUrl: "https://worker.example.dev/" }))).toBe(
      "https://worker.example.dev/price",
    );
    expect(resolvePriceProxyUrl(config({ blobUrl: "https://worker.example.dev/blob?x=1" }))).toBe(
      "https://worker.example.dev/price",
    );
  });

  it("prefers an explicit priceProxyUrl override", () => {
    expect(
      resolvePriceProxyUrl(config({ blobUrl: "https://worker.example.dev/", priceProxyUrl: "https://other/price" })),
    ).toBe("https://other/price");
  });

  it("returns null without a Worker origin (no data source configured)", () => {
    expect(resolvePriceProxyUrl(config({ blobUrl: "" }))).toBeNull();
  });
});

describe("resolveBlobUrl", () => {
  it("returns the configured data-source URL", () => {
    expect(resolveBlobUrl(config({ blobUrl: "https://proxy.example/blob" }))).toBe(
      "https://proxy.example/blob",
    );
  });

  it("returns null when no source is configured", () => {
    expect(resolveBlobUrl(config({ blobUrl: "" }))).toBeNull();
  });
});

describe("resolveMetaUrl", () => {
  it("swaps the filename for a release-asset-style portfolio.enc URL", () => {
    expect(
      resolveMetaUrl(
        config({ blobUrl: "https://github.com/octo/portfolio/releases/download/live-data/portfolio.enc" }),
      ),
    ).toBe("https://github.com/octo/portfolio/releases/download/live-data/portfolio.meta.json");
  });

  it("appends ?meta to a proxy blobUrl", () => {
    expect(resolveMetaUrl(config({ blobUrl: "https://proxy.example/blob" }))).toBe(
      "https://proxy.example/blob?meta",
    );
  });

  it("uses & when the proxy blobUrl already has a query string", () => {
    expect(resolveMetaUrl(config({ blobUrl: "https://proxy.example/?x=1" }))).toBe(
      "https://proxy.example/?x=1&meta",
    );
  });

  it("returns null when no source is configured", () => {
    expect(resolveMetaUrl(config({ blobUrl: "" }))).toBeNull();
  });
});

describe("parseUpdateMinutes", () => {
  it("falls back to the default for blank or invalid input", () => {
    expect(parseUpdateMinutes("")).toBe(15);
    expect(parseUpdateMinutes("abc")).toBe(15);
    expect(parseUpdateMinutes("0")).toBe(15);
    expect(parseUpdateMinutes("-3")).toBe(15);
  });

  it("rounds and clamps to the allowed range", () => {
    expect(parseUpdateMinutes("7")).toBe(7);
    expect(parseUpdateMinutes("7.4")).toBe(7);
    expect(parseUpdateMinutes("9999")).toBe(240);
  });
});

describe("parseProviderLimit", () => {
  it("falls back to the recommended value for blank or invalid input", () => {
    expect(parseProviderLimit("", 8)).toBe(8);
    expect(parseProviderLimit("abc", 800)).toBe(800);
    expect(parseProviderLimit("0", 40)).toBe(40);
    expect(parseProviderLimit("-5", 800)).toBe(800);
  });

  it("rounds and clamps to 1..MAX, allowing values above the recommended free-tier", () => {
    expect(parseProviderLimit("4", 8)).toBe(4);
    expect(parseProviderLimit("4.6", 8)).toBe(5);
    // A paid-plan value above the recommended free-tier ceiling is allowed.
    expect(parseProviderLimit("999", 8)).toBe(999);
    expect(parseProviderLimit("1", 8)).toBe(1);
    // Only an absurd value is clamped, by the sanity ceiling.
    expect(parseProviderLimit("100000000", 8)).toBe(100_000);
  });
});

describe("applyProviderLimits", () => {
  afterEach(() => resetProviderLimits());

  it("pushes the configured limits into the shared store, then resets", () => {
    applyProviderLimits(config({ twelveDataPerMinute: 4, twelveDataPerDay: 200, tiingoPerHour: 10, tiingoPerDay: 100 }));
    expect(providerLimits()).toEqual({
      twelveDataPerMinute: 4,
      twelveDataPerDay: 200,
      tiingoPerHour: 10,
      tiingoPerDay: 100,
    });
    resetProviderLimits();
    expect(providerLimits()).toEqual(DEFAULT_PROVIDER_LIMITS);
  });

  it("updates the live FREE_TIER / WEB_*_CAP mirrors in step", () => {
    applyProviderLimits(config({ twelveDataPerMinute: 3, twelveDataPerDay: 150, tiingoPerHour: 7, tiingoPerDay: 90 }));
    expect(FREE_TIER.creditsPerMinute).toBe(3);
    expect(FREE_TIER.creditsPerDay).toBe(150);
    expect(WEB_HOURLY_CAP).toBe(7);
    expect(WEB_DAILY_CAP).toBe(90);
  });
});

describe("config packet", () => {
  it("round-trips a config through serialize → parse", () => {
    const original = config({
      apiKey: "secret-key",
      blobUrl: "https://proxy.example/portfolio.enc",
      updateMinutes: 30,
      autoLockMinutes: 10,
    });
    const restored = parseConfigPacket(serializeConfig(original));
    expect(restored).toEqual(original);
  });

  it("stamps the packet with the recognised type and version", () => {
    const packet = JSON.parse(serializeConfig(config())) as Record<string, unknown>;
    expect(packet.type).toBe(CONFIG_PACKET_TYPE);
    expect(packet.version).toBe(1);
  });

  it("clamps out-of-range numeric fields on import", () => {
    const restored = parseConfigPacket(
      JSON.stringify({
        type: CONFIG_PACKET_TYPE,
        version: 1,
        apiKey: "k",
        blobUrl: "u",
        updateMinutes: 99999,
        autoLockMinutes: -4,
      }),
    );
    expect(restored.updateMinutes).toBe(240);
    expect(restored.autoLockMinutes).toBe(0);
  });

  it("trims whitespace around the key and URL", () => {
    const restored = parseConfigPacket(
      JSON.stringify({ type: CONFIG_PACKET_TYPE, version: 1, apiKey: "  k  ", blobUrl: "  u  " }),
    );
    expect(restored.apiKey).toBe("k");
    expect(restored.blobUrl).toBe("u");
  });

  it("rejects non-JSON input", () => {
    expect(() => parseConfigPacket("not json")).toThrow();
  });

  it("rejects a JSON file that isn't a config packet", () => {
    expect(() => parseConfigPacket(JSON.stringify({ hello: "world" }))).toThrow();
  });

  it("rejects a packet whose version isn't supported", () => {
    expect(() =>
      parseConfigPacket(
        JSON.stringify({ type: CONFIG_PACKET_TYPE, version: 999, apiKey: "k", blobUrl: "u" }),
      ),
    ).toThrow(/version/i);
  });
});
