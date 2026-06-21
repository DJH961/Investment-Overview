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

import { BlobError, fetchEnvelope } from "../src/blob";
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
