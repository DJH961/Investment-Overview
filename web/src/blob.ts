/**
 * Fetch the published encrypted envelope (`portfolio.enc`).
 *
 * The blob is opaque ciphertext (AES-256-GCM), safe to serve publicly. It is
 * fetched, parsed as the JSON envelope, and handed to the WebCrypto decrypt
 * path. No plaintext is ever requested from the network.
 */
import { assertEnvelope, type Envelope } from "./crypto";

export class BlobError extends Error {}

export async function fetchEnvelope(url: string, fetchImpl: typeof fetch = fetch): Promise<Envelope> {
  let resp: Response;
  try {
    resp = await fetchImpl(url, { cache: "no-store" });
  } catch (err) {
    throw new BlobError(`could not download the encrypted data: ${(err as Error).message}`);
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
