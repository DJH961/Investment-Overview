/**
 * URL resolution for the data source. `resolveBlobUrl` builds the encrypted-blob
 * download URL; `resolveMetaUrl` derives the tiny version-sidecar endpoint used
 * to cheaply detect a newer export.
 */
import { describe, expect, it } from "vitest";

import { resolveBlobUrl, resolveMetaUrl, type AppConfig } from "../src/config";

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    apiKey: "k",
    repo: "octo/portfolio",
    releaseTag: "live-data",
    blobUrl: "",
    metaUrl: "",
    quoteCacheMinutes: 15,
    autoLockMinutes: 5,
    ...overrides,
  };
}

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
