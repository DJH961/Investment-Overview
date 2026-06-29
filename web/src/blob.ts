/**
 * Fetch the published encrypted envelope (`portfolio.enc`).
 *
 * The blob is opaque ciphertext (AES-256-GCM), safe to serve publicly. It is
 * fetched, parsed as the JSON envelope, and handed to the WebCrypto decrypt
 * path. No plaintext is ever requested from the network.
 */
import { assertEnvelope, type Envelope } from "./crypto";

export class BlobError extends Error {}

/**
 * A failed `fetch()` (network down, DNS, or — most commonly here — a
 * cross-origin request the server refused with no `Access-Control-Allow-Origin`)
 * rejects with a `TypeError` whose message is the browser-generic
 * "Failed to fetch". That tells the user nothing actionable, so we translate it
 * into a hint pointing at the real cause: GitHub **release assets are not
 * CORS-readable** from a browser, so the blob must be served through a
 * CORS-enabled source (see `web/proxy/`). Anything else (an actual `Error`
 * subclass with a useful message) is surfaced as-is.
 */
function describeFetchFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Browsers signal a network/CORS failure with a `TypeError` whose message
  // differs by engine: Chromium → "Failed to fetch", Firefox → "NetworkError
  // when attempting to fetch resource", WebKit/Safari → "Load failed". Match all
  // three so the actionable hint is shown regardless of browser.
  if (err instanceof TypeError || /failed to fetch|load failed|networkerror/i.test(message)) {
    return (
      "could not reach the encrypted data. The browser was blocked from " +
      "downloading it — GitHub release assets cannot be read directly across " +
      "origins (CORS). Point Settings → “Blob URL” at a CORS-enabled source " +
      "(e.g. the Cloudflare Worker proxy in web/proxy/), or check your connection."
    );
  }
  return `could not download the encrypted data: ${message}`;
}

export async function fetchEnvelope(url: string, fetchImpl: typeof fetch = fetch): Promise<Envelope> {
  let resp: Response;
  try {
    resp = await fetchImpl(url, { cache: "no-store" });
  } catch (err) {
    throw new BlobError(describeFetchFailure(err));
  }
  return parseEnvelopeResponse(resp);
}

/** Read the HTTP cache validators a response exposes (may be null). */
function readValidators(resp: Response): { etag: string | null; lastModified: string | null } {
  return {
    etag: resp.headers.get("ETag"),
    lastModified: resp.headers.get("Last-Modified"),
  };
}

/** Turn a 200 response into a validated envelope, mapping failures to BlobError. */
async function parseEnvelopeResponse(resp: Response): Promise<Envelope> {
  if (!resp.ok) {
    throw new BlobError(
      resp.status === 404
        ? "encrypted data not found — has the desktop app published yet?"
        : `downloading the encrypted data failed (HTTP ${resp.status})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = await resp.json();
  } catch {
    throw new BlobError("the downloaded data was not a valid envelope");
  }
  assertEnvelope(parsed);
  return parsed;
}

/** Validators carried with a cached blob, sent back as conditional headers. */
export interface ConditionalValidators {
  etag?: string | null;
  lastModified?: string | null;
}

/** Outcome of a conditional blob fetch. */
export type ConditionalEnvelope =
  | { status: "not-modified" }
  | {
      status: "modified";
      envelope: Envelope;
      etag: string | null;
      lastModified: string | null;
    };

/**
 * Conditionally fetch the encrypted blob. Sends `If-None-Match` /
 * `If-Modified-Since` from the cached validators so an unchanged blob comes back
 * as a bodyless **304 Not Modified** — no transfer, no decrypt. A real change
 * returns the new envelope plus its fresh validators to cache for next time.
 *
 * Network/CORS and HTTP errors are reported exactly as {@link fetchEnvelope}.
 */
export async function fetchEnvelopeConditional(
  url: string,
  validators: ConditionalValidators | null,
  fetchImpl: typeof fetch = fetch,
): Promise<ConditionalEnvelope> {
  const headers: Record<string, string> = {};
  if (validators?.etag) headers["If-None-Match"] = validators.etag;
  if (validators?.lastModified) headers["If-Modified-Since"] = validators.lastModified;

  let resp: Response;
  try {
    resp = await fetchImpl(url, { cache: "no-store", headers });
  } catch (err) {
    throw new BlobError(describeFetchFailure(err));
  }
  if (resp.status === 304) return { status: "not-modified" };
  const envelope = await parseEnvelopeResponse(resp);
  const { etag, lastModified } = readValidators(resp);
  return { status: "modified", envelope, etag, lastModified };
}

/** The version stamp the desktop publishes in the `portfolio.meta.json` sidecar. */
export interface BlobMeta {
  /** Opaque change token (a hash of the encrypted blob). */
  version: string;
  /** Encrypted-blob size in bytes, if published. */
  size?: number;
  /** ISO-8601 publish time, if published. */
  publishedAt?: string;
  /**
   * Meta-sidecar schema (`publish_service.py` `_META_SCHEMA`) — the legacy↔ET
   * cutover gate (`time_alignment_plan.md`). `<= 1`: the desktop stamps
   * `analytics.curve` dates the legacy (publisher-local) way; `>= 2`: those dates
   * are ET. The desktop now publishes `2` (ET-stamped); `<= 1` blobs are the
   * not-yet-updated desktops during the staggered ~3-week rollout. Absent on an
   * older sidecar ⇒ the reader treats it as legacy (`1`). The reader is
   * forward-tolerant (it already handles `>= 2`), so the web ships before the
   * desktop and renders both schemas correctly throughout the rollout.
   */
  schema?: number;
}

/**
 * Fetch the tiny `portfolio.meta.json` version sidecar. A successful read lets
 * the companion decide "is there a newer export?" from a few bytes instead of
 * the whole blob. Returns `null` (rather than throwing) for any failure — a
 * missing/unsupported sidecar must transparently fall back to a conditional
 * blob download, never block the refresh.
 */
export async function fetchBlobMeta(url: string, fetchImpl: typeof fetch = fetch): Promise<BlobMeta | null> {
  let resp: Response;
  try {
    resp = await fetchImpl(url, { cache: "no-store" });
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  let parsed: unknown;
  try {
    parsed = await resp.json();
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.version !== "string" || obj.version.length === 0) return null;
  return {
    version: obj.version,
    size: typeof obj.size === "number" ? obj.size : undefined,
    publishedAt: typeof obj.published_at === "string" ? obj.published_at : undefined,
    schema: typeof obj.schema === "number" ? obj.schema : undefined,
  };
}
