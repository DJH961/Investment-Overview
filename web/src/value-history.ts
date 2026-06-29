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
 * one **namespaced** record (key {@link VALUE_HISTORY_STORE_KEY}, not a `YYYY-MM-DD`
 * session key), so a session prune never sweeps them, a cache reset (`clear`)
 * does, and the IndexedDB plumbing / Decimal (de)serialisation are reused as-is.
 * The two currency legs ride as two pseudo-symbol bar tracks (`EUR`/`USD`) keyed
 * by each day's **local-midnight** instant, which gives free instant-dedup
 * (re-recording today overwrites today) via {@link TimeSeriesStore.mergeSession}.
 *
 * **Why local-midnight, not UTC?** The blob carries no time-of-day at all: the
 * Python desktop stamps each `analytics.curve` point with a bare calendar date
 * (`date.isoformat()`) and derives "today" (`as_of`) from `date.today()` — i.e.
 * the desktop's *local* calendar, never UTC. To file each close under the same day
 * the blob would, the bucket boundary here must be local midnight too. Bucketing by
 * UTC instead would, for any viewer west of UTC, roll an evening live close onto the
 * *next* UTC day — so a live tip recorded under {@link OverviewView.asOf} (a local
 * date) and the same day harvested from the 1W curve would split across two buckets
 * and the chart's date-string splice would misalign. Local-day bucketing keeps the
 * web and the Python blob on one shared calendar.
 *
 * ### Pruning (keeping the store small)
 * Persisted closes only exist to bridge the gap between the blob's last exported day
 * and today. Once a *fresh* blob arrives it authoritatively covers everything up to
 * its own last export, so every persisted close on or before that day is redundant
 * and {@link pruneValueHistory} drops it. The caller ({@link App.syncValueHistory})
 * sets the cutoff to the **earlier** of (a) the day after the blob's last export and
 * (b) the start of the trailing week the 1W graph reconstructs — so an up-to-date
 * blob shrinks the store to just that week, while a stale blob still keeps every
 * gap-filling day after its export. The prune is bounded below by the week so it can
 * never starve the 1W curve, and is a no-op when nothing actually rolls out of range.
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
export const VALUE_HISTORY_STORE_KEY = "value-history";

/** Pseudo-symbol bar track holding the EUR whole-book close per day. */
const EUR_SERIES = "EUR";
/** Pseudo-symbol bar track holding the USD whole-book close per day. */
const USD_SERIES = "USD";

/** One persisted whole-book daily close, in both currencies. */
export interface DailyClose {
  /** Trading day this close covers, `YYYY-MM-DD` (local calendar). */
  date: string;
  /** EUR whole-book headline total at the close. */
  valueEur: Decimal;
  /** USD whole-book headline total (FX-free; USD is booked). Null when unknown. */
  valueUsd: Decimal | null;
}

/**
 * Epoch-ms of `YYYY-MM-DD` at **local** midnight — the instant a daily close is
 * stamped at. Local (not UTC) so the bucket boundary matches the Python blob's
 * `date.today()` / bare-date calendar (see the module docstring). `NaN` for a
 * malformed date, which callers guard with {@link Number.isFinite}.
 */
function dayStartMs(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

/** The `YYYY-MM-DD` (local calendar) a stamped instant falls on. */
function localDayOf(t: number): string {
  const d = new Date(t);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * One day whose persisted local close disagrees with the value the freshly
 * arrived blob now reports for the same day — i.e. desktop history was revised
 * (typically a late import / correction) since this device last saw it.
 */
export interface RevisedDay {
  /** `YYYY-MM-DD` (local calendar) the revision lands on. */
  date: string;
  /** EUR close this device had stored before the blob arrived. */
  localEur: Decimal;
  /** EUR close the incoming blob now reports for that day. */
  blobEur: Decimal;
}

/**
 * Cheap per-day fingerprint: which already-persisted local closes the incoming
 * blob history *changes* rather than merely extends. We only compare the days
 * present in **both** sets (an overlap), so a stale blob that simply ends early,
 * or a fresh blob that adds new days, is silent — only a genuine *revision* of a
 * day's value (a late import backfilling old history, a corrected trade) shows.
 *
 * The fingerprint is the EUR close rounded to whole units: brokers re-mark spot
 * to the cent so sub-unit drift is noise, while a real history rewrite moves the
 * whole-book total by far more. Pure and allocation-light — safe to run every
 * sync purely for the observability the polling log gives. The caller flags
 * "history revised" instead of overwriting silently, so a debugging session can
 * see exactly which days a late desktop import rewrote.
 */
export function diffBlobHistory(local: DailyClose[], incoming: DailyClose[]): RevisedDay[] {
  const blobByDay = new Map<string, Decimal>();
  for (const c of incoming) blobByDay.set(c.date, c.valueEur);
  const revised: RevisedDay[] = [];
  for (const c of local) {
    const blobEur = blobByDay.get(c.date);
    if (blobEur === undefined) continue;
    if (c.valueEur.toDecimalPlaces(0).equals(blobEur.toDecimalPlaces(0))) continue;
    revised.push({ date: c.date, localEur: c.valueEur, blobEur });
  }
  revised.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return revised;
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
  await store.mergeSession(VALUE_HISTORY_STORE_KEY, { bars }, now);
}

/**
 * Load every persisted whole-book daily close, ascending by day. The two currency
 * tracks are zipped by instant; a day with only an EUR leg yields `valueUsd:
 * null` (the chart then spot-converts it for the USD view).
 */
export async function loadValueHistory(store: TimeSeriesStore): Promise<DailyClose[]> {
  const stored = await store.loadSession(VALUE_HISTORY_STORE_KEY);
  if (!stored) return [];
  const usdByT = new Map<number, Decimal>();
  for (const b of stored.bars[USD_SERIES] ?? []) usdByT.set(b.t, b.value);
  const closes: DailyClose[] = (stored.bars[EUR_SERIES] ?? []).map((b) => ({
    date: localDayOf(b.t),
    valueEur: b.value,
    valueUsd: usdByT.get(b.t) ?? null,
  }));
  closes.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return closes;
}

/**
 * Harvest a built whole-book curve's **settled daily closes** into the history —
 * the seed/backfill from the 1W graph. The curve carries one or more points per
 * local-calendar day; the last point of each day is that day's close. Today's
 * still-moving tip is harmless to record (the going-forward path overwrites it as
 * it settles), so no day is skipped. Best-effort, like {@link recordDailyClose}.
 */
export async function harvestDailyCloses(
  store: TimeSeriesStore,
  points: CurvePoint[],
  now: number = Date.now(),
): Promise<void> {
  if (points.length === 0) return;
  // The latest-timestamp point of each local day is that day's close. We compare
  // timestamps explicitly rather than trusting insertion order, so an out-of-order
  // or duplicated curve still resolves to the genuine close. Points with a
  // non-finite instant are skipped (they would bucket to an "Invalid Date" day).
  const closeByDay = new Map<string, CurvePoint>();
  for (const p of points) {
    if (!Number.isFinite(p.t)) continue;
    const day = localDayOf(p.t);
    const seen = closeByDay.get(day);
    if (seen === undefined || p.t >= seen.t) closeByDay.set(day, p);
  }
  const eur: Bar[] = [];
  const usd: Bar[] = [];
  for (const [day, p] of closeByDay) {
    const t = dayStartMs(day);
    eur.push({ t, value: p.valueEur });
    usd.push({ t, value: p.valueUsd });
  }
  await store.mergeSession(VALUE_HISTORY_STORE_KEY, { bars: { [EUR_SERIES]: eur, [USD_SERIES]: usd } }, now);
}

/**
 * Drop every persisted close on a day **strictly before** `oldestDay`
 * (`YYYY-MM-DD`), keeping storage small once a fresh blob supersedes the older
 * history.
 *
 * `oldestDay` is the first day worth keeping; callers pass the earlier of the day
 * after the blob's last export and the trailing-week start (see the module
 * docstring's *Pruning* section and {@link App.syncValueHistory}), so the kept set
 * is exactly the days the blob does not already cover, never fewer than the week
 * the 1W graph needs. Both currency legs are filtered against the same local-midnight
 * cutoff; the record is only rewritten when something actually rolls out, so a prune
 * with nothing older than `oldestDay` — or with no history at all — is a cheap no-op.
 */
export async function pruneValueHistory(store: TimeSeriesStore, oldestDay: string): Promise<void> {
  const stored = await store.loadSession(VALUE_HISTORY_STORE_KEY);
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
    day: VALUE_HISTORY_STORE_KEY,
    bars: { [EUR_SERIES]: eur, [USD_SERIES]: usd },
    fx: stored.fx,
    tips: stored.tips ?? [],
    updatedAt: stored.updatedAt,
  });
}
