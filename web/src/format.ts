/**
 * Display formatting helpers. Values arrive as decimal.js `Decimal`; we render
 * with `Intl.NumberFormat` for locale-aware grouping and currency symbols.
 */
import type { Decimal } from "./decimal-config";
import { convertFromEur, displayAmount, getDisplayCurrency } from "./currency";
import { clockOptions } from "./time-format";

const NBSP = "\u00a0";

function formatMoneyValue(value: Decimal, code: string, fractionDigits = 2): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: code,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value.toNumber());
}

/**
 * Format a figure that carries both an EUR value and a pre-computed value in
 * the display currency (USD), preferring the latter so sums of historical
 * flows / point-in-time valuations are never rescaled by today's spot rate.
 * See {@link displayAmount}.
 */
export function formatDualCurrency(
  valueEur: Decimal | null,
  valueDisplay: Decimal | null,
): string {
  const picked = displayAmount(valueEur, valueDisplay);
  if (picked === null) return "—";
  return formatMoneyValue(picked.value, picked.code);
}

/** Signed (`+`/`−`) variant of {@link formatDualCurrency}. */
export function formatSignedDualCurrency(
  valueEur: Decimal | null,
  valueDisplay: Decimal | null,
): string {
  const picked = displayAmount(valueEur, valueDisplay);
  if (picked === null) return "—";
  const base = formatMoneyValue(picked.value.abs(), picked.code);
  if (picked.value.isZero()) return base;
  return picked.value.isNegative() ? `−${NBSP}${base}` : `+${NBSP}${base}`;
}

/** A figure shown in both currencies at once: the active display currency as the
 *  primary, the other as a smaller secondary. */
export interface DualCurrencyParts {
  /** Active display-currency figure (always present). */
  primary: string;
  /** The other currency's figure, or null when it can't be priced. */
  secondary: string | null;
}

/**
 * Format a figure that carries both its EUR pivot and a per-trade-date-FX USD
 * value as *both* legs at once — the active display currency as the primary and
 * the other currency as a smaller secondary. Used where currency drift itself is
 * the point (e.g. the contribution ledger): each leg uses its own stored value
 * (the USD leg already converted at the cash flow's own trade-date FX), so the
 * two figures genuinely diverge instead of being a single rescale of one another.
 * Returns null only when neither currency can be shown.
 */
export function formatDualCurrencyParts(
  valueEur: Decimal | null,
  valueUsd: Decimal | null,
): DualCurrencyParts | null {
  const eurStr = valueEur === null ? null : formatMoneyValue(valueEur, "EUR");
  const usdStr = valueUsd === null ? null : formatMoneyValue(valueUsd, "USD");
  const usdActive = getDisplayCurrency() === "USD";
  const primaryStr = usdActive ? usdStr : eurStr;
  const secondaryStr = usdActive ? eurStr : usdStr;
  if (primaryStr === null) {
    // The display currency can't be priced (e.g. USD selected without FX
    // history): fall back to showing the other currency alone.
    return secondaryStr === null ? null : { primary: secondaryStr, secondary: null };
  }
  return { primary: primaryStr, secondary: secondaryStr };
}

/**
 * Format a compute-layer amount in the active display currency (EUR or USD —
 * see currency.ts). Compute-layer figures are carried in EUR purely as the
 * internal FX-pivot (not because EUR is the base/primary currency — USD is the
 * native booked currency), so the conversion to the chosen display currency
 * happens here at render time.
 */
export function formatCurrency(value: Decimal | null): string {
  if (value === null) return "—";
  const { value: amount, code } = convertFromEur(value);
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: code,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount.toNumber());
}

/**
 * A whole-currency amount (no cents). Used where the precision of cents is
 * noise rather than signal — e.g. the forward-projection table, whose figures
 * are hypothetical estimates and read more clearly rounded to the nearest unit.
 */
export function formatCurrencyWhole(value: Decimal | null): string {
  if (value === null) return "—";
  const { value: amount, code } = convertFromEur(value);
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: code,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount.toNumber());
}

/**
 * Format an amount that is intrinsically **EUR** and must NOT be FX-rescaled to
 * the display currency — e.g. the FX gain/loss and repatriation value on the
 * Risk tab's currency-effect panel, which only make sense as euros. Always
 * renders with the euro symbol regardless of the active display currency.
 */
export function formatMoneyEur(value: Decimal | null, fractionDigits = 0): string {
  if (value === null) return "—";
  return formatMoneyValue(value, "EUR", fractionDigits);
}

/** Signed companion of {@link formatMoneyEur} (e.g. "+ €200", "− €200"). */
export function formatSignedMoneyEur(value: Decimal | null, fractionDigits = 0): string {
  if (value === null) return "—";
  const base = formatMoneyEur(value.abs(), fractionDigits);
  if (value.isZero()) return base;
  return value.isNegative() ? `−${NBSP}${base}` : `+${NBSP}${base}`;
}

export function formatSignedCurrency(value: Decimal | null): string {
  if (value === null) return "—";
  const base = formatCurrency(value.abs());
  if (value.isZero()) return base;
  return value.isNegative() ? `−${NBSP}${base}` : `+${NBSP}${base}`;
}

/**
 * A compact EUR-denominated amount for chart axis ticks (e.g. "€39k", "$1.2M"),
 * rendered in the active display currency. Uses the currency symbol only, with
 * k/M suffixes so axis labels stay short.
 *
 * `fractionDigits` (optional) pins the number of decimals shown after the k/M
 * scaling, so a narrow axis (e.g. an intraday curve hugging €47k) can render
 * "47.0k / 47.2k / 47.4k" instead of collapsing every tick to "47k". When
 * omitted the label auto-trims trailing zeros (the headline-style default).
 */
export function formatCurrencyShort(value: Decimal | null, fractionDigits?: number): string {
  if (value === null) return "—";
  const { value: amount, code } = convertFromEur(value);
  return formatCurrencyShortIn(amount, code, fractionDigits);
}

/**
 * Compact axis label for an amount that is **already** in the given display
 * currency (e.g. a USD-denominated curve point), so it is not re-converted by
 * today's spot rate the way {@link formatCurrencyShort} converts an EUR figure.
 */
export function formatCurrencyShortRaw(
  value: Decimal | null,
  code: string,
  fractionDigits?: number,
): string {
  if (value === null) return "—";
  return formatCurrencyShortIn(value, code, fractionDigits);
}

/**
 * Format an amount that is **already** in the given display currency at full
 * precision (locale grouping + the currency symbol), without re-converting it by
 * today's spot rate — the companion of {@link formatCurrencyShortRaw} for places
 * that want the exact figure rather than a k/M-scaled axis label (e.g. the 1D
 * chart's "Prev close" annotation, mirroring the desktop's `$54,123.45`).
 */
export function formatMoneyRaw(value: Decimal | null, code: string, fractionDigits = 2): string {
  if (value === null) return "—";
  return formatMoneyValue(value, code, fractionDigits);
}

function formatCurrencyShortIn(amount: Decimal, code: string, fractionDigits?: number): string {
  const num = amount.toNumber();
  const abs = Math.abs(num);
  const symbol = currencySymbol(code);
  const sign = num < 0 ? "−" : "";
  if (abs >= 1_000_000) return `${sign}${symbol}${scaled(abs / 1_000_000, fractionDigits)}M`;
  if (abs >= 1_000) return `${sign}${symbol}${scaled(abs / 1_000, fractionDigits)}k`;
  return `${sign}${symbol}${fractionDigits === undefined ? Math.round(abs) : abs.toFixed(fractionDigits)}`;
}

/** A k/M-scaled magnitude, either pinned to `fractionDigits` or auto-trimmed. */
function scaled(value: number, fractionDigits?: number): string {
  if (fractionDigits !== undefined) return value.toFixed(fractionDigits);
  return trim(value);
}

function trim(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
}

function currencySymbol(code: string): string {
  return code === "USD" ? "$" : "€";
}

/** Render a ratio (0.1234 → "12.34%"). */
export function formatPercent(value: Decimal | null, digits = 2): string {
  if (value === null) return "—";
  return `${value.times(100).toNumber().toFixed(digits)}%`;
}

export function formatSignedPercent(value: Decimal | null, digits = 2): string {
  if (value === null) return "—";
  const pct = value.times(100).toNumber();
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  return `${sign}${Math.abs(pct).toFixed(digits)}%`;
}

/**
 * An FX pair rate to 4 decimals (e.g. `1.0856`), the convention for EUR/USD.
 * Returns an em dash when the rate is unknown.
 */
export function formatFxRate(value: Decimal | null): string {
  if (value === null) return "—";
  return value.toNumber().toFixed(4);
}

/**
 * The "data last pulled …" stamp for the overview footer and the Refresh
 * button tooltip. Unlike {@link formatUpdatedAt} (which describes *when the
 * prices themselves apply to*), this describes *when the app last pulled data
 * from the network* — so even over a closed-market weekend, where the prices
 * are Friday's, the user can see the pull happened "today". Adds the relative
 * keyword "today"/"yesterday" when applicable, else the date, always with the
 * clock time of the pull. Falls back to "not yet" when no live pull has
 * happened yet (first run, offline).
 */
export function formatLastPull(
  at: number | null | undefined,
  now: Date = new Date(),
): string {
  if (at === null || at === undefined) return "not yet";
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return "—";
  const time = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", ...clockOptions() });
  const dayDiff = calendarDayDiff(when, now);
  if (dayDiff === 0) return `today at ${time}`;
  if (dayDiff === 1) return `yesterday at ${time}`;
  const date = when.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return `${date} at ${time}`;
}

/** Whole calendar days between `then` and `now` (now − then), local time. */
function calendarDayDiff(then: Date, now: Date): number {
  const a = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((b - a) / 86_400_000);
}

/**
 * The "FX market closed — reopens …" caption shown while the spot-FX (forex)
 * market is shut over the weekend. `reopenAt` is the absolute epoch-ms of the
 * Sunday 17:00 ET reopen (see `forexMarketReopenMs`), rendered in the viewer's own
 * timezone so they read it on their own clock: "reopens today 23:00" when the
 * reopen is later today, "reopens tomorrow 23:00" the day before, else the weekday
 * + clock time ("reopens Sun 23:00"). Returns just "reopens soon" if the instant
 * can't be parsed, so the caption never shows a broken date.
 */
export function formatForexReopen(reopenAt: number, now: Date = new Date()): string {
  const when = new Date(reopenAt);
  if (Number.isNaN(when.getTime())) return "reopens soon";
  const time = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", ...clockOptions() });
  const dayDiff = calendarDayDiff(now, when);
  if (dayDiff === 0) return `reopens today ${time}`;
  if (dayDiff === 1) return `reopens tomorrow ${time}`;
  const day = when.toLocaleDateString(undefined, { weekday: "short" });
  return `reopens ${day} ${time}`;
}

/**
 * The market-situation-aware "as of" caption for the hero's total value and
 * today's move — the browser mirror of the desktop's Daily Growth caption
 * (`services/daily_growth_view.build_daily_growth_caption`).
 *
 * While the US market is open and we hold an intraday observation dated today,
 * it reads as a live clock time ("as of 3:42 PM"). Once the session is closed it
 * pins to the latest settled trading day instead — "as of today" when that day
 * is today, else the weekday + date ("as of Fri 20 Jun") — so the figure is
 * never mislabelled as live when it is really a settled close.
 *
 * `liveAsOf` is the freshest intraday market observation (epoch ms; null when
 * nothing priced intraday), `settledDate` the latest known trading day
 * (`YYYY-MM-DD`), and `today` the local `YYYY-MM-DD`.
 */
export function formatDailyGrowthAsOf(
  liveAsOf: number | null | undefined,
  settledDate: string,
  today: string,
  marketOpen: boolean,
  now: Date = new Date(),
): string {
  if (marketOpen && liveAsOf !== null && liveAsOf !== undefined) {
    const when = new Date(liveAsOf);
    const sameDay =
      !Number.isNaN(when.getTime()) &&
      when.getFullYear() === now.getFullYear() &&
      when.getMonth() === now.getMonth() &&
      when.getDate() === now.getDate();
    if (sameDay) {
      const time = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", ...clockOptions() });
      return `as of ${time}`;
    }
  }
  if (settledDate === today) return "as of today";
  const parsed = new Date(settledDate);
  if (Number.isNaN(parsed.getTime())) return `as of ${settledDate}`;
  return `as of ${parsed.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}`;
}

export function formatShares(value: Decimal): string {
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  }).format(value.toNumber());
}

export function formatNativePrice(value: Decimal | null, currency: string): string {
  if (value === null) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value.toNumber());
}

/** Sign class for colour-coding: "pos", "neg", or "flat". */
export function signClass(value: Decimal | null): "pos" | "neg" | "flat" {
  if (value === null || value.isZero()) return "flat";
  return value.isNegative() ? "neg" : "pos";
}

export function formatTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString(undefined, clockOptions());
}

/**
 * The export ("Exported …") stamp. Like {@link formatLastPull}, it swaps the
 * date for the relative keyword "today"/"yesterday" when the export was made on
 * that day, and falls back to the date otherwise — always with the clock time.
 * Takes the export's ISO `generated_at` (the moment the decrypted blob was
 * produced); returns the raw input when it can't be parsed.
 */
export function formatExportedAt(iso: string, now: Date = new Date()): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  const time = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", ...clockOptions() });
  const dayDiff = calendarDayDiff(when, now);
  if (dayDiff === 0) return `today at ${time}`;
  if (dayDiff === 1) return `yesterday at ${time}`;
  const date = when.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return `${date} at ${time}`;
}

/**
 * A compact "how fresh is this price" label for a holding row.
 *
 * `at` is the epoch ms a live/cached price was observed; when null the price
 * came from the export and `fallbackDate` (the export's `as_of`, `YYYY-MM-DD`)
 * is shown instead. A same-day live price shows the clock time; an older one
 * shows the date, so it is always transparent how current each value is.
 */
export function formatAsOf(
  at: number | null | undefined,
  fallbackDate: string,
  now: Date = new Date(),
): string {
  if (at === null || at === undefined) {
    const parsed = new Date(fallbackDate);
    if (Number.isNaN(parsed.getTime())) return fallbackDate;
    return parsed.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return "—";
  const sameDay =
    when.getFullYear() === now.getFullYear() &&
    when.getMonth() === now.getMonth() &&
    when.getDate() === now.getDate();
  return sameDay
    ? when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", ...clockOptions() })
    : when.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/**
 * The "prices updated …" stamp for the overview footer. Unlike {@link formatAsOf}
 * (which trades the time for a date once a price is a day old), this always keeps
 * the clock time when a live observation exists — the time of the update is the
 * point of the stamp — and adds the date only when that update was not today.
 * Falls back to the export's `as_of` date when nothing was priced live.
 */
export function formatUpdatedAt(
  at: number | null | undefined,
  fallbackDate: string,
  now: Date = new Date(),
): string {
  if (at === null || at === undefined) {
    const parsed = new Date(fallbackDate);
    if (Number.isNaN(parsed.getTime())) return fallbackDate;
    return parsed.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return "—";
  const time = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", ...clockOptions() });
  const sameDay =
    when.getFullYear() === now.getFullYear() &&
    when.getMonth() === now.getMonth() &&
    when.getDate() === now.getDate();
  if (sameDay) return time;
  return `${when.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${time}`;
}
