/**
 * URL resolution for the data source. `resolveBlobUrl` builds the encrypted-blob
 * download URL; `resolveMetaUrl` derives the tiny version-sidecar endpoint used
 * to cheaply detect a newer export.
 */
import { describe, expect, it } from "vitest";

import { resolveBlobUrl, resolveMetaUrl, resolvePriceProxyUrl, parseAutoRefreshMinutes, type AppConfig } from "../src/config";

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    apiKey: "k",
    repo: "octo/portfolio",
    releaseTag: "live-data",
    blobUrl: "",
    metaUrl: "",
    priceProxyUrl: "",
    quoteCacheMinutes: 15,
    autoLockMinutes: 5,
    autoRefreshMinutes: 5,
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

  it("returns null without a Worker origin (release-asset default has no /price route)", () => {
    expect(resolvePriceProxyUrl(config())).toBeNull();
  });
});

describe("resolveBlobUrl", () => {
  it("builds the release-asset URL from repo + tag", () => {
    expect(resolveBlobUrl(config())).toBe(
      "https://github.com/octo/portfolio/releases/download/live-data/portfolio.enc",
    );
  });

  it("prefers an explicit blobUrl override", () => {
    expect(resolveBlobUrl(config({ blobUrl: "https://proxy.example/blob" }))).toBe(
      "https://proxy.example/blob",
    );
  });

  it("returns null when no source is configured", () => {
    expect(resolveBlobUrl(config({ repo: "not-a-repo" }))).toBeNull();
  });
});

describe("resolveMetaUrl", () => {
  it("derives the release-asset meta sidecar from repo + tag", () => {
    expect(resolveMetaUrl(config())).toBe(
      "https://github.com/octo/portfolio/releases/download/live-data/portfolio.meta.json",
    );
  });

  it("appends ?meta to a proxy blobUrl override", () => {
    expect(resolveMetaUrl(config({ blobUrl: "https://proxy.example/blob" }))).toBe(
      "https://proxy.example/blob?meta",
    );
  });

  it("uses & when the proxy blobUrl already has a query string", () => {
    expect(resolveMetaUrl(config({ blobUrl: "https://proxy.example/?x=1" }))).toBe(
      "https://proxy.example/?x=1&meta",
    );
  });

  it("prefers an explicit metaUrl override above all", () => {
    expect(
      resolveMetaUrl(config({ blobUrl: "https://proxy.example/blob", metaUrl: "https://meta.example/v" })),
    ).toBe("https://meta.example/v");
  });

  it("returns null when no source is configured", () => {
    expect(resolveMetaUrl(config({ repo: "not-a-repo" }))).toBeNull();
  });
});

describe("parseAutoRefreshMinutes", () => {
  it("falls back to the default for blank or invalid input", () => {
    expect(parseAutoRefreshMinutes("")).toBe(5);
    expect(parseAutoRefreshMinutes("abc")).toBe(5);
    expect(parseAutoRefreshMinutes("0")).toBe(5);
    expect(parseAutoRefreshMinutes("-3")).toBe(5);
  });

  it("rounds and clamps to the allowed range", () => {
    expect(parseAutoRefreshMinutes("7")).toBe(7);
    expect(parseAutoRefreshMinutes("7.4")).toBe(7);
    expect(parseAutoRefreshMinutes("9999")).toBe(120);
  });
});
