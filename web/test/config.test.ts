/**
 * Config resolution and the portable config packet. `resolveBlobUrl` returns the
 * configured data-source URL; `resolveMetaUrl` derives the version-sidecar
 * endpoint; `serializeConfig`/`parseConfigPacket` round-trip an export file.
 */
import { describe, expect, it } from "vitest";

import {
  resolveBlobUrl,
  resolveMetaUrl,
  resolvePriceProxyUrl,
  parseUpdateMinutes,
  serializeConfig,
  parseConfigPacket,
  CONFIG_PACKET_TYPE,
  type AppConfig,
} from "../src/config";

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    apiKey: "k",
    blobUrl: "https://proxy.example/portfolio.enc",
    priceProxyUrl: "",
    updateMinutes: 15,
    autoLockMinutes: 5,
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
