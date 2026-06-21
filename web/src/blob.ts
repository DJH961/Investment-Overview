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
