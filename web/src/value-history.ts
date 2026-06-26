/**
 * Persistent **whole-book daily-close history** for the long-range value graph
 * (1M / 3M / 6M / 1Y), kept on the device so daily use of the companion fills the
 * gap a *stale* export blob leaves behind.
 *
 * The blob's `analytics.curve` carries one settled point per day up to the
 * desktop's last export. When that export is weeks old but the web app is opened
 * daily, the long-range chart would otherwise draw a single straight diagonal
 * across the whole gap (see {@link ../ui.renderValueChart}). To avoid that, every
 * refresh records today's whole-book headline total here, and the 1W curve's
 * settled daily closes are harvested in too — so the gap is rebuilt from genuine
 * per-day points rather than interpolated.
 *
 * Storage piggy-backs on the existing {@link TimeSeriesStore}: the closes live in
 * one **namespaced** record (key {@link VALUE_HISTORY_KEY}, not a `YYYY-MM-DD`
 * session key), so a session prune never sweeps them, a cache reset (`clear`)
 * does, and the IndexedDB plumbing / Decimal (de)serialisation are reused as-is.
 * The two currency legs ride as two pseudo-symbol bar tracks (`EUR`/`USD`) keyed
 * by each day's UTC-midnight instant, which gives free instant-dedup (re-recording
 * today overwrites today) via {@link TimeSeriesStore.mergeSession}.
 *
 * Storage stays small: when a fresh blob arrives its history supersedes ours, so
 * {@link pruneValueHistory} drops every close the blob now covers — keeping only
 * the days *after* the blob's last export (still gap-filling) and, at minimum, the
 * trailing week the 1W graph needs.
 */

import { Decimal } from "./decimal-config";
import type { Bar, CurvePoint } from "./timeseries";
import type { TimeSeriesStore } from "./timeseries-store";

/**
 * The store key the whole-book daily-close history lives under. Deliberately
 * **not** a `YYYY-MM-DD` string so it shares the namespace convention of the 1W
 * daily-close cache and is never mistaken for — or swept away by — a session
 * prune (see {@link TimeSeriesStore.prune}).
 */
export const VALUE_HISTORY_KEY = "value-history";

/** Pseudo-symbol bar track holding the EUR whole-book close per day. */
const EUR_SERIES = "EUR";
/** Pseudo-symbol bar track holding the USD whole-book close per day. */
const USD_SERIES = "USD";

/** One persisted whole-book daily close, in both currencies. */
export interface DailyClose {
  /** Trading day this close covers, `YYYY-MM-DD` (UTC). */
  date: string;
  /** EUR whole-book headline total at the close. */
  valueEur: Decimal;
  /** USD whole-book headline total (FX-free; USD is booked). Null when unknown. */
  valueUsd: Decimal | null;
}

/** Epoch-ms of `YYYY-MM-DD` at UTC midnight — the instant a daily close is stamped at. */
function dayStartMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/** The `YYYY-MM-DD` (UTC) a stamped instant falls on. */
function utcDayOf(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Record (or update) one day's whole-book close. Re-recording the same day
 * overwrites it (instant-deduped by {@link TimeSeriesStore.mergeSession}), so a
 * day's not-yet-settled total keeps refining until it settles. Best-effort: the
 * caller should treat a rejection as non-fatal (a missed crumb, never a crash).
 */
export async function recordDailyClose(
  store: TimeSeriesStore,
  close: DailyClose,
  now: number = Date.now(),
): Promise<void> {
  const t = dayStartMs(close.date);
  if (!Number.isFinite(t)) return;
  const bars: Record<string, Bar[]> = { [EUR_SERIES]: [{ t, value: close.valueEur }] };
  if (close.valueUsd !== null) bars[USD_SERIES] = [{ t, value: close.valueUsd }];
  await store.mergeSession(VALUE_HISTORY_KEY, { bars }, now);
}

/**
 * Load every persisted whole-book daily close, ascending by day. The two currency
 * tracks are zipped by instant; a day with only an EUR leg yields `valueUsd:
 * null` (the chart then spot-converts it for the USD view).
 */
export async function loadValueHistory(store: TimeSeriesStore): Promise<DailyClose[]> {
  const stored = await store.loadSession(VALUE_HISTORY_KEY);
  if (!stored) return [];
  const usdByT = new Map<number, Decimal>();
  for (const b of stored.bars[USD_SERIES] ?? []) usdByT.set(b.t, b.value);
  const closes: DailyClose[] = (stored.bars[EUR_SERIES] ?? []).map((b) => ({
    date: utcDayOf(b.t),
    valueEur: b.value,
    valueUsd: usdByT.get(b.t) ?? null,
  }));
  closes.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return closes;
}

/**
 * Harvest a built whole-book curve's **settled daily closes** into the history —
 * the seed/backfill from the 1W graph. The curve carries one or more points per
 * UTC day; the last point of each day is that day's close. Today's still-moving
 * tip is harmless to record (the going-forward path overwrites it as it settles),
 * so no day is skipped. Best-effort, like {@link recordDailyClose}.
 */
export async function harvestDailyCloses(
  store: TimeSeriesStore,
  points: CurvePoint[],
  now: number = Date.now(),
): Promise<void> {
  if (points.length === 0) return;
  // Last point per UTC day wins (points are ascending), giving each day's close.
  const closeByDay = new Map<string, CurvePoint>();
  for (const p of points) closeByDay.set(utcDayOf(p.t), p);
  const eur: Bar[] = [];
  const usd: Bar[] = [];
  for (const [day, p] of closeByDay) {
    const t = dayStartMs(day);
    eur.push({ t, value: p.valueEur });
    usd.push({ t, value: p.valueUsd });
  }
  await store.mergeSession(VALUE_HISTORY_KEY, { bars: { [EUR_SERIES]: eur, [USD_SERIES]: usd } }, now);
}

/**
 * Drop every persisted close on a day **strictly before** `oldestDay`
 * (`YYYY-MM-DD`), keeping storage small once a fresh blob supersedes the older
 * history. A no-op when nothing is stored or nothing rolls out.
 */
export async function pruneValueHistory(store: TimeSeriesStore, oldestDay: string): Promise<void> {
  const stored = await store.loadSession(VALUE_HISTORY_KEY);
  if (!stored) return;
  const cutoff = dayStartMs(oldestDay);
  if (!Number.isFinite(cutoff)) return;
  const keep = (bars: Bar[] | undefined): Bar[] => (bars ?? []).filter((b) => b.t >= cutoff);
  const eur = keep(stored.bars[EUR_SERIES]);
  const usd = keep(stored.bars[USD_SERIES]);
  const droppedEur = eur.length !== (stored.bars[EUR_SERIES]?.length ?? 0);
  const droppedUsd = usd.length !== (stored.bars[USD_SERIES]?.length ?? 0);
  if (!droppedEur && !droppedUsd) return;
  await store.saveSession({
    day: VALUE_HISTORY_KEY,
    bars: { [EUR_SERIES]: eur, [USD_SERIES]: usd },
    fx: stored.fx,
    tips: stored.tips ?? [],
    updatedAt: stored.updatedAt,
  });
}
