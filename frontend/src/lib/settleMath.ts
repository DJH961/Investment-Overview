/**
 * Quick-settle maths (7.3, P14): stepping a figure by its last stored decimal and keeping
 * the linked fields of a buy or a conversion consistent.
 *
 * Exact decimals on BigInt (value = n / 10^s): never a float, so 0.1 + 0.2 is 0.3 and a
 * 6-decimal broker price survives. The client only does linear presentation maths on what
 * the server sent (products and quotients of typed figures); the server re-checks every
 * settled row with the same rules as manual entry.
 */

export interface Dec {
  n: bigint;
  s: number;
}

const TEN = 10n;

function pow10(k: number): bigint {
  return TEN ** BigInt(k);
}

/** Round-half-away-from-zero integer division. */
function roundDiv(num: bigint, den: bigint): bigint {
  const neg = num < 0n !== den < 0n;
  const a = num < 0n ? -num : num;
  const b = den < 0n ? -den : den;
  const q = (a * 2n + b) / (b * 2n);
  return neg ? -q : q;
}

function rescale(n: bigint, from: number, to: number): bigint {
  return to >= from ? n * pow10(to - from) : roundDiv(n, pow10(from - to));
}

/** Parse "12.340" (a typed or server decimal string); `null` for anything else. */
export function parseDec(text: string): Dec | null {
  const t = text.trim().replace(",", ".");
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m || (!m[2] && !m[3])) return null;
  const frac = m[3] ?? "";
  const n = BigInt(`${m[2] || "0"}${frac}`);
  return { n: m[1] ? -n : n, s: frac.length };
}

/** Exactly `dp` decimals (rounded half away from zero). */
export function formatDec(d: Dec, dp: number): string {
  const n = rescale(d.n, d.s, dp);
  const neg = n < 0n;
  const digits = (neg ? -n : n).toString().padStart(dp + 1, "0");
  const head = digits.slice(0, digits.length - dp);
  return `${neg ? "-" : ""}${dp > 0 ? `${head}.${digits.slice(digits.length - dp)}` : head}`;
}

/** `value` rounded to `dp` places as text; `""` when it is not a number. */
export function toDp(value: string, dp: number): string {
  const d = parseDec(value);
  return d ? formatDec(d, dp) : "";
}

/**
 * One step on the last stored decimal: `dir` is +1 or -1, `mult` 1 or 10 (the "×10"
 * toggle). Never goes below zero. A value that is not a number starts from zero.
 */
export function stepDecimal(value: string, dp: number, dir: 1 | -1, mult: 1 | 10 = 1): string {
  const d = parseDec(value) ?? { n: 0n, s: 0 };
  const next = rescale(d.n, d.s, dp) + BigInt(dir) * BigInt(mult);
  return formatDec({ n: next < 0n ? 0n : next, s: dp }, dp);
}

/**
 * Split a formatted figure around the digit a step moves, so it can be highlighted:
 * `head` + `digit` + `tail`. With `mult` 10 the digit one place to the left moves.
 */
export function splitAtStep(
  formatted: string,
  mult: 1 | 10 = 1,
): { head: string; digit: string; tail: string } {
  const idx = formatted.length - (mult === 10 ? 2 : 1);
  let i = idx;
  if (formatted[i] === ".") i -= 1;
  if (i < 0) return { head: "", digit: formatted, tail: "" };
  return { head: formatted.slice(0, i), digit: formatted[i] ?? "", tail: formatted.slice(i + 1) };
}

function div(a: Dec, b: Dec, dp: number): Dec | null {
  if (b.n === 0n) return null;
  const num = a.n * pow10(b.s + dp);
  const den = b.n * pow10(a.s);
  return { n: roundDiv(num, den), s: dp };
}

function mul(a: Dec, b: Dec, dp: number): Dec {
  return { n: rescale(a.n * b.n, a.s + b.s, dp), s: dp };
}

// ---- a buy: price <-> quantity <-> total ----------------------------------

export type BuyField = "price" | "quantity" | "total";

export interface BuyValues {
  price: string;
  quantity: string;
  total: string;
}

export interface BuyPrecision {
  priceDp: number;
  quantityDp: number;
  /** Money places (cents): 2. */
  moneyDp: number;
}

/**
 * Recompute the other buy figures after `edited` changed. `anchor` is the figure that stays
 * fixed while another one moves (the plan's fixed amount: `"total"` for an amount plan,
 * `"quantity"` for a shares plan). When the anchor itself is edited, the price stays and
 * the remaining figure follows it.
 */
export function relinkBuy(
  edited: BuyField,
  values: BuyValues,
  anchor: "total" | "quantity",
  p: BuyPrecision,
): BuyValues {
  const price = parseDec(values.price);
  const quantity = parseDec(values.quantity);
  const total = parseDec(values.total);
  const out = { ...values };
  const setQty = (d: Dec | null) => d && (out.quantity = formatDec(d, p.quantityDp));
  const setPrice = (d: Dec | null) => d && (out.price = formatDec(d, p.priceDp));
  const setTotal = (d: Dec | null) => d && (out.total = formatDec(d, p.moneyDp));
  if (edited === "price") {
    if (anchor === "total") total && price && setQty(div(total, price, p.quantityDp));
    else quantity && price && setTotal(mul(quantity, price, p.moneyDp));
  } else if (edited === "quantity") {
    if (anchor === "total") total && quantity && setPrice(div(total, quantity, p.priceDp));
    else quantity && price && setTotal(mul(quantity, price, p.moneyDp));
  } else if (anchor === "total") {
    total && price && setQty(div(total, price, p.quantityDp));
  } else {
    total && quantity && setPrice(div(total, quantity, p.priceDp));
  }
  return out;
}

// ---- a conversion: USD received <-> rate (EUR sent fixed from the plan) ----

export type ConversionField = "received" | "rate";

export interface ConversionValues {
  received: string;
  rate: string;
}

/** Rate places shown and stepped (0.0001); the received amount keeps cents. */
export const RATE_DP = 4;
export const MONEY_DP = 2;

/** `rate = received / sent` or `received = sent * rate`; `sent` never changes here. */
export function relinkConversion(edited: ConversionField, values: ConversionValues, sent: string): ConversionValues {
  const s = parseDec(sent);
  const out = { ...values };
  if (!s) return out;
  if (edited === "received") {
    const received = parseDec(values.received);
    const rate = received && div(received, s, RATE_DP);
    if (rate) out.rate = formatDec(rate, RATE_DP);
  } else {
    const rate = parseDec(values.rate);
    if (rate) out.received = formatDec(mul(s, rate, MONEY_DP), MONEY_DP);
  }
  return out;
}

/** All-in rate: USD received per EUR spent including the fee (`received / (sent + fee)`). */
export function allInRate(sent: string, fee: string, received: string): string {
  const s = parseDec(sent);
  const f = parseDec(fee || "0");
  const r = parseDec(received);
  if (!s || !f || !r) return "";
  const total = { n: rescale(s.n, s.s, Math.max(s.s, f.s)) + rescale(f.n, f.s, Math.max(s.s, f.s)), s: Math.max(s.s, f.s) };
  const q = div(r, total, RATE_DP);
  return q ? formatDec(q, RATE_DP) : "";
}

/** Step delay for press-and-hold: starts gentle, then speeds up (milliseconds). */
export function holdDelay(repeats: number): number {
  if (repeats < 3) return 380;
  if (repeats < 8) return 160;
  if (repeats < 20) return 80;
  return 45;
}
