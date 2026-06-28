/**
 * A one-shot **diagnostic quote probe** for the Settings screen.
 *
 * The dashboard is honest when a price service is unreachable ("Couldn't reach
 * any price service, showing last known"), but it cannot tell the user *why* —
 * a wrong/over-quota Twelve Data key, a rate-limit, an un-redeployed Tiingo
 * proxy Worker, or a dead network all look the same from the outside. This
 * module fires a single, deliberate request for one user-chosen symbol against
 * one provider and reports back the **full raw result**: the (key-redacted) URL,
 * the HTTP status, the verbatim response body, the price it parsed (if any), and
 * a plain-language verdict that names the likely cause.
 *
 * It is deliberately **pure and self-contained** (an injectable `fetch`, no
 * caches, no budgets, no breaker) so it never disturbs the live refresh engine,
 * spends nothing on the credit ledger, and is unit-testable in isolation
 * (`web/test/probe.test.ts`). The UI ({@link formatProbeReport}) renders the
 * outcome verbatim; {@link probeLogLine} feeds the polling log so the same
 * finding is visible there too.
 */

import type { FetchLike } from "./prices";

/** Which data provider a probe targets. */
export type ProbeProvider = "twelvedata" | "tiingo";

/** The classified outcome of a probe, named so the UI can colour/word it. */
export type ProbeVerdict =
  | "ok" // a usable quote came back for the symbol
  | "no-quote" // reached the provider, but it had no price for this symbol
  | "bad-key" // rejected/over-quota API key (HTTP/code 401/403) — fix in Settings
  | "rate-limited" // HTTP 429 — too many requests / credits used up, retry later
  | "server-error" // HTTP 5xx — the provider (or proxy) is having a bad moment
  | "unreachable" // never got a response (network down, CORS, DNS, dead proxy)
  | "bad-response" // a 200 whose body wasn't the expected shape (proxy misconfig)
  | "not-configured"; // no API key (Twelve Data) or no proxy URL (Tiingo) set

/** The full, structured result of a single probe. */
export interface ProbeOutcome {
  provider: ProbeProvider;
  /** Human label, e.g. "Twelve Data (primary)" / "Tiingo backup". */
  providerLabel: string;
  /** The symbol that was probed, exactly as requested. */
  symbol: string;
  /** The request URL with any API key redacted (safe to show/log). */
  requestUrl: string | null;
  /** True once an HTTP response came back (even an error one). */
  reached: boolean;
  /** HTTP status code, or null when the request never completed. */
  httpStatus: number | null;
  /** HTTP status text, when the transport supplied one. */
  httpStatusText: string | null;
  /** Wall-clock duration of the request, in ms. */
  durationMs: number;
  /** The verbatim response body (possibly truncated), or the throw message. */
  rawBody: string | null;
  /** The price parsed for the probed symbol, as a string, or null. */
  price: string | null;
  /** Currency of the parsed price, when the provider reported one. */
  currency: string | null;
  /** The prior close parsed for the probed symbol, as a string, or null. */
  previousClose: string | null;
  /** The classified verdict. */
  verdict: ProbeVerdict;
  /** A one-line, plain-language explanation of the verdict. */
  detail: string;
}

const TWELVE_DATA_QUOTE_URL = "https://api.twelvedata.com/quote";

/** Cap on how much of a response body we keep, so a huge payload can't bloat UI. */
const MAX_BODY_CHARS = 4000;

/** The placeholder swapped in for a redacted API key in any reported URL. */
const REDACTED = "***redacted***";

/** A short, friendly provider label for headlines and logs. */
export function probeProviderLabel(provider: ProbeProvider): string {
  return provider === "twelvedata" ? "Twelve Data (primary)" : "Tiingo (backup)";
}

/** Inputs for {@link probeQuote}. */
export interface ProbeQuoteInput {
  provider: ProbeProvider;
  /** The symbol to probe (trimmed; case is preserved for Twelve Data). */
  symbol: string;
  /** Twelve Data API key — required for the `twelvedata` provider. */
  apiKey?: string;
  /** The `/price` proxy URL — required for the `tiingo` provider. */
  proxyUrl?: string | null;
  /** Injectable transport (tests). Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Injectable clock for duration timing (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Override the body-truncation cap (tests). */
  maxBodyChars?: number;
}

/** Truncate `text` to `max` chars, appending an honest "… (truncated)" marker. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (${text.length - max} more characters truncated)`;
}

/** Coerce an unknown JSON scalar into a trimmed string, or null. */
function asPriceString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return null;
}

/**
 * Probe one symbol against one provider and return the full raw outcome. Never
 * throws: a transport failure (network down, CORS, dead proxy) is captured as an
 * `unreachable` verdict so the caller always has something to show.
 */
export async function probeQuote(input: ProbeQuoteInput): Promise<ProbeOutcome> {
  const { provider } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const maxBody = input.maxBodyChars ?? MAX_BODY_CHARS;
  const symbol = input.symbol.trim();
  const providerLabel = probeProviderLabel(provider);

  const base: ProbeOutcome = {
    provider,
    providerLabel,
    symbol,
    requestUrl: null,
    reached: false,
    httpStatus: null,
    httpStatusText: null,
    durationMs: 0,
    rawBody: null,
    price: null,
    currency: null,
    previousClose: null,
    verdict: "not-configured",
    detail: "",
  };

  if (!symbol) {
    return { ...base, verdict: "not-configured", detail: "Enter a symbol to probe." };
  }

  // Build the request URL and the redacted version we are allowed to show.
  let url: URL;
  let shownUrl: string;
  if (provider === "twelvedata") {
    const apiKey = (input.apiKey ?? "").trim();
    if (!apiKey) {
      return {
        ...base,
        verdict: "not-configured",
        detail: "No Twelve Data API key is set. Add it above, then probe again.",
      };
    }
    url = new URL(TWELVE_DATA_QUOTE_URL);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("apikey", apiKey);
    const redacted = new URL(url.toString());
    redacted.searchParams.set("apikey", REDACTED);
    shownUrl = redacted.toString();
  } else {
    const proxyUrl = (input.proxyUrl ?? "").trim();
    if (!proxyUrl) {
      return {
        ...base,
        verdict: "not-configured",
        detail:
          "No backup price-proxy URL is configured. Set a data-source or price-proxy URL, then probe again.",
      };
    }
    try {
      url = new URL(proxyUrl);
    } catch {
      return {
        ...base,
        verdict: "not-configured",
        detail: `The price-proxy URL ("${proxyUrl}") is not a valid URL.`,
      };
    }
    url.searchParams.set("tickers", symbol);
    shownUrl = url.toString();
  }
  base.requestUrl = shownUrl;

  // Fire the request, timing it. A throw here is a genuine transport failure.
  const startedAt = now();
  let resp: Response;
  try {
    resp = await fetchImpl(url.toString());
  } catch (err) {
    return {
      ...base,
      durationMs: now() - startedAt,
      verdict: "unreachable",
      rawBody: (err as Error).message ?? String(err),
      detail:
        provider === "twelvedata"
          ? "Could not reach Twelve Data at all — no internet, a blocked request (CORS/DNS), or the API is down."
          : "Could not reach the price proxy at all — check the Worker URL, that it is deployed, and your connection.",
    };
  }

  const durationMs = now() - startedAt;
  const httpStatus = typeof resp.status === "number" ? resp.status : null;
  const httpStatusText = typeof resp.statusText === "string" && resp.statusText.length > 0 ? resp.statusText : null;
  let rawBody: string | null = null;
  try {
    rawBody = clip(await resp.text(), maxBody);
  } catch (err) {
    rawBody = `(could not read response body: ${(err as Error).message})`;
  }

  const reachedBase: ProbeOutcome = {
    ...base,
    reached: true,
    httpStatus,
    httpStatusText,
    durationMs,
    rawBody,
  };

  // A non-OK HTTP status is the clearest signal of all — classify by code.
  if (!resp.ok) {
    return { ...reachedBase, ...classifyHttpStatus(provider, httpStatus) };
  }

  // 200 OK: parse the body and look for the symbol's price.
  let parsed: unknown;
  try {
    parsed = rawBody === null ? null : JSON.parse(rawBody);
  } catch {
    return {
      ...reachedBase,
      verdict: "bad-response",
      detail:
        provider === "twelvedata"
          ? "Twelve Data returned a 200 but the body was not JSON — unexpected for this endpoint."
          : "The proxy returned a 200 but the body was not JSON — the Worker may be serving the wrong route.",
    };
  }

  return provider === "twelvedata"
    ? interpretTwelveData(reachedBase, parsed)
    : interpretTiingo(reachedBase, symbol, parsed);
}

/** Map a non-OK HTTP status to a verdict + detail, per provider. */
function classifyHttpStatus(
  provider: ProbeProvider,
  status: number | null,
): Pick<ProbeOutcome, "verdict" | "detail"> {
  if (status === 401 || status === 403) {
    return {
      verdict: "bad-key",
      detail:
        provider === "twelvedata"
          ? `Twelve Data rejected the request (HTTP ${status}) — the API key is wrong, disabled, or out of quota.`
          : `The proxy/Tiingo rejected the request (HTTP ${status}) — the Tiingo token is missing or invalid.`,
    };
  }
  if (status === 429) {
    return {
      verdict: "rate-limited",
      detail: `${probeProviderLabel(provider)} is rate-limited (HTTP 429) — too many requests, or the credits are used up. Try again later.`,
    };
  }
  if (status !== null && status >= 500) {
    return {
      verdict: "server-error",
      detail: `${probeProviderLabel(provider)} returned a server error (HTTP ${status}) — a temporary upstream problem, retry shortly.`,
    };
  }
  return {
    verdict: "bad-response",
    detail:
      provider === "twelvedata"
        ? `Twelve Data returned HTTP ${status ?? "?"} — unexpected; see the raw body below.`
        : `The price proxy returned HTTP ${status ?? "?"} — check the Worker /price route and config; see the raw body below.`,
  };
}

/** Interpret a parsed Twelve Data `quote` body for a single symbol. */
function interpretTwelveData(outcome: ProbeOutcome, parsed: unknown): ProbeOutcome {
  if (!parsed || typeof parsed !== "object") {
    return { ...outcome, verdict: "bad-response", detail: "Twelve Data returned an unexpected (non-object) body." };
  }
  const node = parsed as Record<string, unknown>;
  // A top-level error object (no `symbol`) means the whole call failed — almost
  // always a bad/over-quota key. Twelve Data reports `{code, message, status}`.
  if (node.status === "error" && !("symbol" in node)) {
    const code = typeof node.code === "number" ? node.code : null;
    const message = typeof node.message === "string" ? node.message : "request rejected";
    if (code === 401 || code === 403) {
      return { ...outcome, verdict: "bad-key", detail: `Twelve Data error ${code}: ${message}` };
    }
    if (code === 429) {
      return { ...outcome, verdict: "rate-limited", detail: `Twelve Data error 429: ${message}` };
    }
    return { ...outcome, verdict: "bad-response", detail: `Twelve Data error${code !== null ? ` ${code}` : ""}: ${message}` };
  }
  const price = asPriceString(node.close ?? node.price);
  const currency = typeof node.currency === "string" ? node.currency : null;
  const previousClose = asPriceString(node.previous_close);
  if (price !== null) {
    return {
      ...outcome,
      verdict: "ok",
      price,
      currency,
      previousClose,
      detail: `Twelve Data answered with a price for ${outcome.symbol}${currency ? ` (${currency})` : ""}.`,
    };
  }
  return {
    ...outcome,
    verdict: "no-quote",
    detail: `Twelve Data answered, but returned no usable price for "${outcome.symbol}" — check the symbol is spelled exactly as the provider expects.`,
  };
}

/** Interpret a parsed Tiingo IEX body (an array of rows) for one symbol. */
function interpretTiingo(outcome: ProbeOutcome, symbol: string, parsed: unknown): ProbeOutcome {
  // A genuine Tiingo IEX response is ALWAYS a JSON array (even `[]`). Anything
  // else means the proxy is not actually relaying Tiingo (un-redeployed Worker,
  // a relayed error object, the encrypted blob on the wrong route).
  if (!Array.isArray(parsed)) {
    return {
      ...outcome,
      verdict: "bad-response",
      detail:
        "The proxy did not return a Tiingo quote array — the Worker /price route is likely misconfigured, not redeployed, or the Tiingo token is missing.",
    };
  }
  const wanted = symbol.toUpperCase();
  const row = parsed.find(
    (r) => r && typeof r === "object" && typeof (r as Record<string, unknown>).ticker === "string" &&
      ((r as Record<string, unknown>).ticker as string).toUpperCase() === wanted,
  ) as Record<string, unknown> | undefined;
  if (!row) {
    return {
      ...outcome,
      verdict: "no-quote",
      detail:
        parsed.length === 0
          ? `Tiingo answered with an empty list — it has no quote for "${symbol}" (Tiingo covers US tickers only).`
          : `Tiingo answered, but not for "${symbol}" — check the symbol (Tiingo covers US tickers only).`,
    };
  }
  const price = asPriceString(row.tngoLast) ?? asPriceString(row.last);
  const previousClose = asPriceString(row.prevClose);
  if (price !== null) {
    return {
      ...outcome,
      verdict: "ok",
      price,
      currency: "USD",
      previousClose,
      detail: `Tiingo answered with a price for ${symbol} (USD).`,
    };
  }
  return {
    ...outcome,
    verdict: "no-quote",
    detail: `Tiingo returned a row for "${symbol}" but no usable price field (tngoLast/last).`,
  };
}

/** Whether a verdict represents a healthy round-trip with a usable price. */
export function probeSucceeded(outcome: ProbeOutcome): boolean {
  return outcome.verdict === "ok";
}

/**
 * The budget gate for a probe — the decision of whether it may fire *now*, must
 * *wait* for a clear window first, or would only fire by going *over the limit*.
 * A probe spends a real provider credit, so it is metered exactly like a refresh:
 *
 *  - `ready`      — there is budget and (for Twelve Data) the rolling 1-minute
 *                   window is clear; fire immediately.
 *  - `wait`       — Twelve Data only: the minute window is not yet fully clear,
 *                   so the probe should auto-fire after `delayMs` (a live
 *                   countdown), exactly like a Settings refresh waits for a fresh
 *                   window instead of spilling onto the scarce backup.
 *  - `over-limit` — there is no spendable budget right now (the day pool is gone,
 *                   the provider is frozen by a 429, or the backup's hour/day cap
 *                   is spent). Firing is still *possible*, but only behind an
 *                   explicit warning, since it knowingly exceeds the cap.
 */
export type ProbeGateDecision =
  | { kind: "ready" }
  | { kind: "wait"; delayMs: number }
  | { kind: "over-limit"; reason: string };

/** Inputs for {@link decideProbeGate} — live budget read-outs for the provider. */
export interface ProbeGateInput {
  provider: ProbeProvider;
  /** Remaining credits for the provider right now (min∧day for TD, hour∧day for Tiingo). */
  available: number;
  /** TD: ms until the rolling 1-minute pool is fully clear. Pass 0 for Tiingo. */
  minuteReadyDelayMs: number;
  /** Whether the provider is currently frozen by a 429 breaker. */
  frozen?: boolean;
}

/**
 * Decide whether a probe may fire now, must wait for a clear Twelve Data minute
 * window, or would only fire over the limit. Pure (no clock/storage) so the
 * metering policy is unit-testable in isolation.
 */
export function decideProbeGate(input: ProbeGateInput): ProbeGateDecision {
  const frozen = input.frozen ?? false;
  if (input.provider === "twelvedata") {
    // A 429 freeze runs to the next clock :00 — far longer than the ≤60s minute
    // wait — so a frozen primary is "over limit", not a short countdown.
    if (!frozen && input.minuteReadyDelayMs > 0) {
      return { kind: "wait", delayMs: input.minuteReadyDelayMs };
    }
    if (!frozen && input.available >= 1) return { kind: "ready" };
    return {
      kind: "over-limit",
      reason: frozen
        ? "Twelve Data is frozen after a rate-limit (HTTP 429) until the next clock hour."
        : "Twelve Data has no per-minute or daily credits left.",
    };
  }
  // Tiingo has no rolling-minute window — gate purely on its hour/day budget.
  if (!frozen && input.available >= 1) return { kind: "ready" };
  return {
    kind: "over-limit",
    reason: frozen
      ? "Tiingo is frozen after a rate-limit (HTTP 429) until the next clock hour."
      : "Tiingo has no hourly or daily backup credits left.",
  };
}

/** A short headline summarising a probe outcome (for a log line / toast). */
export function probeHeadline(outcome: ProbeOutcome): string {
  const status = outcome.httpStatus !== null ? `HTTP ${outcome.httpStatus}` : "no response";
  return `${outcome.providerLabel} · ${outcome.symbol} · ${status} · ${outcome.verdict}`;
}

/** A single polling-log line for a probe, so the finding is visible there too. */
export function probeLogLine(outcome: ProbeOutcome): string {
  return `Probe — ${probeHeadline(outcome)} — ${outcome.detail}`;
}

/**
 * Render the full outcome as a plain-text report for display in Settings. Shows
 * everything a user (or a helper reading a screenshot) needs to diagnose the
 * failure: the redacted URL, status, timing, parsed price, and the verbatim body.
 */
export function formatProbeReport(outcome: ProbeOutcome): string {
  const lines: string[] = [];
  lines.push(`Provider:  ${outcome.providerLabel}`);
  lines.push(`Symbol:    ${outcome.symbol || "(none)"}`);
  if (outcome.requestUrl) lines.push(`Request:   ${outcome.requestUrl}`);
  if (outcome.reached) {
    const statusText = outcome.httpStatusText ? ` ${outcome.httpStatusText}` : "";
    lines.push(`Status:    HTTP ${outcome.httpStatus ?? "?"}${statusText}  ·  ${outcome.durationMs} ms`);
  } else {
    lines.push(`Status:    no response  ·  ${outcome.durationMs} ms`);
  }
  lines.push(`Verdict:   ${outcome.verdict}`);
  lines.push(`Detail:    ${outcome.detail}`);
  if (outcome.price !== null) {
    const ccy = outcome.currency ? ` ${outcome.currency}` : "";
    const prev = outcome.previousClose !== null ? `  (prev close ${outcome.previousClose}${ccy})` : "";
    lines.push(`Price:     ${outcome.price}${ccy}${prev}`);
  }
  lines.push("");
  lines.push("Raw response:");
  lines.push(outcome.rawBody ?? "(no body)");
  return lines.join("\n");
}
