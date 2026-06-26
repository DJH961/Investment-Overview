/**
 * `fetchEnvelope` error handling.
 *
 * The most common real-world failure is a cross-origin block: GitHub release
 * assets send no `Access-Control-Allow-Origin` header, so the browser rejects
 * the `fetch()` with a generic `TypeError: Failed to fetch`. We assert that the
 * raw message is translated into an actionable, CORS-aware hint, and that the
 * other failure paths (HTTP errors, bad JSON, valid envelopes) still behave.
 */
import { describe, expect, it } from "vitest";

import { BlobError, fetchBlobMeta, fetchEnvelope, fetchEnvelopeConditional } from "../src/blob";
import { ENVELOPE_VERSION, KDF_NAME, type Envelope } from "../src/crypto";

const VALID_ENVELOPE: Envelope = {
  v: ENVELOPE_VERSION,
  kdf: KDF_NAME,
  kdf_params: { salt: "AAAA", iterations: 600000 },
  nonce: "AAAA",
  ciphertext: "AAAA",
  tag: "AAAA",
};

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("fetchEnvelope", () => {
  it("translates a cross-origin 'Failed to fetch' into a CORS hint", async () => {
    const fetchImpl = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
    const err = await fetchEnvelope("https://example/blob.enc", fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(BlobError);
    expect((err as BlobError).message).toMatch(/CORS/);
    expect((err as BlobError).message).toMatch(/Blob URL/);
    // The browser-generic string must not be surfaced on its own.
    expect((err as BlobError).message).not.toBe("Failed to fetch");
  });

  it("surfaces a non-network Error message as-is", async () => {
    const fetchImpl = (() => Promise.reject(new Error("boom"))) as typeof fetch;
    const err = await fetchEnvelope("https://example/blob.enc", fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(BlobError);
    expect((err as BlobError).message).toContain("boom");
  });

  it("reports a friendly message for a 404 (blob not published yet)", async () => {
    const fetchImpl = (() => Promise.resolve(new Response("", { status: 404 }))) as typeof fetch;
    const err = await fetchEnvelope("https://example/blob.enc", fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(BlobError);
    expect((err as BlobError).message).toMatch(/not found/);
  });

  it("reports the HTTP status for other server errors", async () => {
    const fetchImpl = (() => Promise.resolve(new Response("", { status: 503 }))) as typeof fetch;
    const err = await fetchEnvelope("https://example/blob.enc", fetchImpl).catch((e) => e);
    expect((err as BlobError).message).toMatch(/HTTP 503/);
  });

  it("rejects a body that is not valid JSON", async () => {
    const fetchImpl = (() => Promise.resolve(new Response("not json", { status: 200 }))) as typeof fetch;
    const err = await fetchEnvelope("https://example/blob.enc", fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(BlobError);
    expect((err as BlobError).message).toMatch(/not a valid envelope/);
  });

  it("returns the parsed envelope on success", async () => {
    const fetchImpl = (() => Promise.resolve(jsonResponse(VALID_ENVELOPE))) as typeof fetch;
    const envelope = await fetchEnvelope("https://example/blob.enc", fetchImpl);
    expect(envelope.v).toBe(ENVELOPE_VERSION);
    expect(envelope.kdf).toBe(KDF_NAME);
  });
});

describe("fetchEnvelopeConditional", () => {
  it("sends cached validators as conditional headers", async () => {
    let seen: Headers | undefined;
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return Promise.resolve(new Response(null, { status: 304 }));
    }) as typeof fetch;
    const result = await fetchEnvelopeConditional(
      "https://example/blob.enc",
      { etag: 'W/"v1"', lastModified: "Wed, 21 Oct 2026 07:28:00 GMT" },
      fetchImpl,
    );
    expect(result.status).toBe("not-modified");
    expect(seen?.get("If-None-Match")).toBe('W/"v1"');
    expect(seen?.get("If-Modified-Since")).toBe("Wed, 21 Oct 2026 07:28:00 GMT");
  });

  it("returns the new envelope and validators on a 200", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        jsonResponse(VALID_ENVELOPE, { headers: { ETag: 'W/"v2"', "Last-Modified": "Thu, 22 Oct 2026 00:00:00 GMT" } }),
      )) as typeof fetch;
    const result = await fetchEnvelopeConditional("https://example/blob.enc", null, fetchImpl);
    expect(result.status).toBe("modified");
    if (result.status === "modified") {
      expect(result.envelope.v).toBe(ENVELOPE_VERSION);
      expect(result.etag).toBe('W/"v2"');
      expect(result.lastModified).toBe("Thu, 22 Oct 2026 00:00:00 GMT");
    }
  });

  it("sends no conditional headers when validators are null (unconditional, cannot 304)", async () => {
    let seen: Headers | undefined;
    const fetchImpl = ((_url: string, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return Promise.resolve(
        jsonResponse(VALID_ENVELOPE, { headers: { ETag: 'W/"v9"' } }),
      );
    }) as typeof fetch;
    const result = await fetchEnvelopeConditional("https://example/blob.enc", null, fetchImpl);
    // A hard reset withholds the validators so the server can never answer 304
    // and serve back the cached copy — the full blob is always pulled afresh.
    expect(seen?.has("If-None-Match")).toBe(false);
    expect(seen?.has("If-Modified-Since")).toBe(false);
    expect(result.status).toBe("modified");
  });

  it("surfaces a CORS failure as a BlobError", async () => {
    const fetchImpl = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
    const err = await fetchEnvelopeConditional("https://example/blob.enc", null, fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(BlobError);
    expect((err as BlobError).message).toMatch(/CORS/);
  });
});

describe("fetchBlobMeta", () => {
  it("parses a valid version sidecar", async () => {
    const fetchImpl = (() =>
      Promise.resolve(jsonResponse({ version: "abc123", size: 42, published_at: "2026-01-01T00:00:00+00:00" }))) as typeof fetch;
    const meta = await fetchBlobMeta("https://example/portfolio.meta.json", fetchImpl);
    expect(meta?.version).toBe("abc123");
    expect(meta?.size).toBe(42);
    expect(meta?.publishedAt).toBe("2026-01-01T00:00:00+00:00");
  });

  it("returns null (never throws) for any failure", async () => {
    const reject = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch;
    expect(await fetchBlobMeta("https://example/meta", reject)).toBeNull();

    const notFound = (() => Promise.resolve(new Response("", { status: 404 }))) as typeof fetch;
    expect(await fetchBlobMeta("https://example/meta", notFound)).toBeNull();

    const badJson = (() => Promise.resolve(new Response("nope", { status: 200 }))) as typeof fetch;
    expect(await fetchBlobMeta("https://example/meta", badJson)).toBeNull();

    const noVersion = (() => Promise.resolve(jsonResponse({ size: 1 }))) as typeof fetch;
    expect(await fetchBlobMeta("https://example/meta", noVersion)).toBeNull();
  });
});
