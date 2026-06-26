/**
 * Application controller: a small state machine wiring the screens together.
 *
 *   setup ─▶ unlock ─▶ (decrypt cached blob ▶ render from cache ─▶ dashboard)
 *                         └─▶ in background: re-download blob + refresh prices
 *
 * Speed comes from doing the slow, networked work *after* the first paint: the
 * unlock screen decrypts the encrypted blob we already cached and renders the
 * dashboard from cached prices immediately, then a background pass re-downloads
 * the blob and refreshes live prices. Optional biometric unlock (see
 * `webauthn.ts`) lets a fingerprint stand in for typing the passphrase.
 *
 * Secrets handling: the Twelve Data API key is device-local config
 * (`localStorage`); the mobile passphrase is kept in memory only for the active
 * session and dropped on "Lock". Decrypted figures never leave the browser.
 */
import { fetchBlobMeta, fetchEnvelopeConditional } from "./blob";
import { buildDashboard, buildFetchPlan, suspectQuoteSymbols, type DashboardModel } from "./compute";
import { decryptEnvelopeToJson, type Envelope } from "./crypto";
import { buildDemoModel, parseDemoParams, getPersona, DEMO_PERSONAS, type DemoParams } from "./demo";
import { startTour, DEMO_TOUR_STEPS } from "./tour";
import {
  defaultConfig,
  loadConfig,
  applyProviderLimits,
  parseAutoLockMinutes,
  parseProviderLimit,
  parseUpdateMinutes,
  parseInvestmentAmount,
  resolveBlobUrl,
  resolveMetaUrl,
  resolvePriceProxyUrl,
  saveConfig,
  serializeConfig,
  parseConfigPacket,
  DEFAULT_UPDATE_MINUTES,
  MAX_UPDATE_MINUTES,
  DEFAULT_AUTO_LOCK_MINUTES,
  MAX_AUTO_LOCK_MINUTES,
  DEFAULT_TWELVE_DATA_PER_MINUTE,
  DEFAULT_TWELVE_DATA_PER_DAY,
  DEFAULT_TIINGO_PER_HOUR,
  DEFAULT_TIINGO_PER_DAY,
  DEFAULT_INVESTMENT_AMOUNT_EUR,
  MAX_INVESTMENT_AMOUNT_EUR,
  type AppConfig,
} from "./config";
import { PriceError, type FxRates, type Quote } from "./prices";
import { Decimal } from "./decimal-config";
import {
  readCachedEnvelope,
  readCachedEurUsd,
  readCachedFx,
  readCachedQuotes,
  readCreditLog,
  clearPriceCaches,
  clearAllSeriesBackoff,
  creditsSpentToday,
  readLastPull,
  readSymbolPlan,
  type PlannedSymbol,
  primeQuotesFromBars,
  readSessionStatus,
  writeSessionStatus,
  type SessionStatus,
  writeCachedEnvelope,
  writeLastPull,
  writeSymbolPlan,
} from "./cache";
import {
  DEFAULT_NAV_CACHE_TTL_MS,
  FREE_TIER,
  holdsSettledClose,
  loadEurUsd,
  loadFxRates,
  loadQuotes,
  marketCacheTtlMs,
  navCacheTtlMs,
  type EurUsdSource,
  type LoadQuotesOptions,
  type QuoteLoadReport,
} from "./quotes";
import { nextRefreshDelayMs } from "./refresh-policy";
import { classifyRefreshPhase, type RefreshPhase } from "./refresh-window";
import { isUsMarketOpen, isForexMarketOpen, latestSettledSessionDate, lastSessionDate, previousTradingSession, recentTradingSessions, LIVE_PRICE_MAX_STALENESS_MS, sessionIsWarmingUp, sessionOpenMs, sessionCloseMs, elapsedSessionMs, settledSessionsSince, INTRADAY_BAR_INTERVAL_MS } from "./market-hours";
import {
  runTiingoFallback,
  shouldQuickRefresh,
  noteQuickRefresh,
  planStartupRefresh,
  planPrefetch,
  tiingoRemainingCredits,
  tiingoBudgetView,
  STARTUP_TIINGO_RESERVE,
  type TiingoBudgetView,
} from "./tiingo-fallback";
import { readTiingoState } from "./cache";
import {
  clearBiometricEnrolment,
  enrolBiometric,
  hasBiometricEnrolment,
  isBiometricSupported,
  unlockWithBiometric,
} from "./webauthn";
import { setEurUsdRate } from "./currency";
import { setInvestmentAmountEur } from "./investment-amount";
import { formatLastPull } from "./format";
import { appendPollLog, clearPollLog, formatPollLog, readPollLog, type PollLogCategory, type PollLogLevel } from "./polling-log";
import { APP_VERSION } from "./version";
import type { CloseResolveLog } from "./close-completeness";
import {
  buildLiveSessionCurve,
  buildLiveWeekCurve,
  cacheSeriesBackoff,
  instrumentedGraphRecorders,
  makePriceBarFetcher,
  makeWindowFxFetcher,
  sessionFxWindow,
  sessionFxHistoryWindow,
  weekFxWindow,
  type LiveGraphProviders,
} from "./live-graph";
import {
  recordTwelveData429,
  recordTwelveDataSuccess,
  recordTiingo429,
} from "./provider-breaker";
import { ledgerReservation, tiingoAvailable, twelveDataAvailable } from "./reservation";
import { DEFERRED_MAX_ATTEMPTS, DeferredQueue } from "./deferred-queue";
import { planFanout, planTwelveDataSafetyNet, TIINGO_RESERVE_CREDITS } from "./provider-fanout";
import { reconcileHandshake } from "./login-handshake";
import { springboardSessionCurve, springboardWeekCurve, parseExportedPoints } from "./springboard";
import { buildModelAnchor } from "./value-graph";
import {
  graphAnchorFx,
  readSessionCloseFx,
  readSessionOpenFx,
  recordSessionCloseFx,
  recordSessionOpenFx,
  sessionBarsComplete,
  sessionCloseFxFromBars,
  sessionFxBarsComplete,
  sessionOpenFxFromBars,
} from "./session-fx";
import { TimeSeriesStore, type Breadcrumb } from "./timeseries-store";
import {
  WEEK_STORE_KEY,
  navBackfillStaleSymbols,
  navBarsFromQuotes,
  weekStaleSymbols,
  wrapDailyNavFetcher,
  DEFAULT_WEEK_SESSIONS,
} from "./week";
import {
  recordDailyClose,
  harvestDailyCloses,
  pruneValueHistory,
  loadValueHistory,
  type DailyClose,
} from "./value-history";
import { planPull, describePlan, deviceDaysMissing, type PullKind, type PullFreshness, type PullPlan } from "./data-orchestrator";
import {
  describeFlag,
  describeMerge,
  hasMarketSleeve,
  mergeSleeveSeries,
  parseMarketSeries,
  rebaseSleeveToWholeBook,
  type SleevePoint,
} from "./market-sleeve";
import type { Bar, CurvePoint } from "./timeseries";
import type { MobileExport } from "./types";
import {
  clearResumeToken,
  isReloadNavigation,
  isResumeTokenValid,
  readResumeEnvelope,
  saveResumeToken,
  touchResumeActivity,
  unwrapResumePassphrase,
} from "./resume-session";
import {
  h,
  markHoldingsUpdating,
  renderDashboard,
  renderExtendedGraphsToggle,
  renderThemeToggle,
  renderTimeFormatToggle,
  type LiveGraphHooks,
} from "./ui";
import {
  HOLDING_UPDATED_FLASH_MS,
  emptyHoldingStatusModel,
  type HoldingLivePhase,
  type HoldingStatusModel,
} from "./holding-status";

/** How long an auto-dismissing status toast stays on screen. */
const TOAST_DURATION_MS = 6000;

/**
 * How long the top-of-page "welcome back" login banner stays up. Kept short — its
 * only job is to confirm the unlock was detected before it fades, so it doesn't
 * linger over the dashboard while the bottom refreshing pill and coverage toasts
 * keep working underneath.
 */
const WELCOME_BANNER_DURATION_MS = 3200;

/**
 * How long before the idle auto-lock fires to surface the dismissable "locking
 * soon" warning, giving the user a chance to stay unlocked. Clamped to at most
 * half the auto-lock window so a very short window still shows a sensible lead.
 */
const AUTO_LOCK_WARN_LEAD_MS = 15_000;

/**
 * Throttle for re-arming the idle auto-lock on high-frequency activity (pointer
 * moves, wheel, …). Re-arming at most this often keeps the timers from thrashing
 * while still measuring idle from the most recent second of activity. A visible
 * warning always re-arms immediately, regardless of this throttle.
 */
const AUTO_LOCK_RESET_THROTTLE_MS = 1000;

/**
 * Throttle for re-stamping the resume token's last-activity time. Independent of
 * the timer re-arm so storage writes stay infrequent under heavy interaction.
 */
const RESUME_TOUCH_THROTTLE_MS = 5000;

/**
 * Minimum time the manual "Refreshing prices…" feedback stays on screen after
 * a tap. A live refresh that is fully served from cache (every quote/FX rate
 * still inside its window) resolves in a few milliseconds, so without a floor
 * the spinner + pill would flash for less than a frame and a phone tap would
 * look completely inert — exactly the "nothing happens" the user reported.
 */
const MANUAL_REFRESH_MIN_FEEDBACK_MS = 650;

/**
 * Smallest gap between two *accepted* manual refreshes. A tap that lands inside
 * this window of the previous one is treated as an accidental double-tap and
 * ignored (it still flashes the feedback, but spends no credits) — so a fumbled
 * double-click can't burn two forced pulls back-to-back. It is deliberately
 * tiny: long enough to swallow a double-tap, short enough that a user who
 * genuinely wants to re-check the market a couple of seconds later still can.
 */
const MANUAL_REFRESH_COOLDOWN_MS = 3000;

/**
 * How long the one-off login spin of the Refresh glyph lasts — the honest "the
 * prefetch got you something newer" signal fired once after unlock when (and
 * only when) the login prefetch actually fetched fresh data.
 */
const PREFETCH_SPIN_MS = 1000;

/**
 * Hard floor on the wall-clock gap between *automatic* background blob checks,
 * regardless of how low the user sets the auto-update interval. The cadence is
 * primarily the user's configured auto-update interval (see
 * {@link App.blobCheckDue}) — that interval *is* how often we look for a newer
 * desktop export — but a 1-minute interval shouldn't hammer the blob host with a
 * conditional probe every single tick, so the actual cadence is the larger of the
 * configured interval and this floor. A *manual* refresh always checks, bypassing
 * this floor entirely.
 */
const BLOB_CHECK_MIN_INTERVAL_MS = 60 * 1000;

/**
 * C4 — how long the awaitable blob-meta probe ({@link App.refreshBlobMeta}) may
 * block the login kickoff before it gives up and falls back to the current
 * `blobDaysOld`. A few-byte GET; this only guards against a hung socket.
 */
const BLOB_META_PROBE_TIMEOUT_MS = 2500;

/**
 * Resolve `promise`, or reject once `ms` elapses — used to time-box the C4 blob
 * meta probe so a hung network can never block the login kickoff. The timer is
 * always cleared so it cannot keep the event loop alive after settling.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}


/**
 * Heartbeat cadence for the auto-refresh scheduler while the market is **settled**
 * (closed, with every settled close and today's NAV already in hand). No prices
 * are fetched in this state — see {@link App.runScheduledRefresh} — but the timer
 * keeps ticking on this slow interval so the app promptly notices the next
 * session open or NAV publish (and runs the near-free new-data probe when due)
 * instead of going silent until the user reopens it.
 */
const SETTLED_HEARTBEAT_MS = 5 * 60 * 1000;

/**
 * localStorage key holding the app version this device last booted, so the next
 * boot can spot a version change and note it in the polling log (item 6).
 */
const APP_VERSION_KEY = "iv.web.app_version";

/**
 * Daily free-tier credits remaining at or below which the UI warns the user it
 * is close to the limit (and starts spacing refreshes out). Two per-minute
 * windows' worth of headroom — enough warning to be useful without nagging.
 * Derived from the live (Settings-configurable) per-minute limit, so lowering
 * the limit tightens the warning band in step.
 */
function dailyBudgetWarnCredits(): number {
  return 2 * FREE_TIER.creditsPerMinute;
}

/** A `YYYY-MM-DD` date shifted by `n` whole UTC days (n may be negative). */
function isoPlusDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * How recently the app must have actually pulled fresh data from the network for
 * the coverage summary to claim holdings are "up to date". This is tied to the
 * auto-refresh window (`config.updateMinutes`): within one refresh cycle of a real
 * network pull the on-screen prices are as current as the schedule intends, so the
 * summary may honestly say "up to date"; beyond it, it names them last-pulled
 * instead. See {@link App.upToDateWindowMs}.
 */

/**
 * Fraction of the daily free-tier credit budget that must remain for a manual
 * "refresh now" to force a fresh market pull. Below this reserve a tap falls
 * back to the normal cache-respecting refresh so the last of the day's budget
 * isn't burnt in one go. Matches the user's "unless I have less than 10% of
 * credits available" rule.
 */
const FORCE_REFRESH_MIN_CREDIT_FRACTION = 0.1;

/**
 * What triggered a price refresh: a `manual` tap of the Refresh button or an
 * `auto` background pull by the scheduler. Drives the distinct visual feedback
 * each gets (a spinning button + "Refreshing…" pill vs. an "Auto-updating…"
 * pill) so the user can tell their tap registered *and* that the automatic
 * refresh keeps working on its own.
 */
export type RefreshKind = "start" | "auto" | "manual" | "reset";

/**
 * Whether a refresh `kind` is one the **user explicitly triggered** and therefore
 * expects visible, held-on-screen feedback and an outcome confirmation toast for:
 * the manual Refresh tap and the Settings "reset & re-pull everything". The
 * background mechanisms (`start` login warm-up, `auto` cadence) instead show the
 * quieter auto-updating affordance. Pillar 6: `kind` is the mechanism; this is the
 * one place feedback policy keys off it.
 */
export function isUserRefresh(kind: RefreshKind): boolean {
  return kind === "manual" || kind === "reset";
}

/** What a scheduled refresh tick should do — see {@link refreshTickAction}. */
export type RefreshTickAction = "run" | "defer" | "stop";

/**
 * Decide what one scheduled refresh tick should do, kept pure so the loop's
 * survival rules are testable in isolation:
 *
 *  - **stop** — the session was superseded (a lock, or a newer unlock); abandon
 *    this stale tick entirely.
 *  - **defer** — an automatic background tick while the tab is hidden: skip the
 *    network this round to save credits, but the caller MUST still re-arm the
 *    next tick so the auto-refresh loop is never permanently abandoned.
 *  - **run** — do the live refresh now.
 *
 * The post-unlock **kickoff** always runs, even when the tab reports hidden: a
 * fingerprint unlock on mobile frequently (and sometimes stickily) flips the
 * page to `hidden` for a beat, which used to drop the one startup refresh *and*,
 * because the loop is only re-armed after a completed round, leave auto-refresh
 * un-armed forever — so no price update fired at all until a manual tap. The
 * kickoff is user-initiated (they are actively waiting on fresh prices), so it
 * bypasses the hidden skip.
 *
 * Only the steady `auto` cadence ever defers on a hidden tab; the three
 * user-/login-driven mechanisms (`start`, `manual`, `reset`) always run.
 */
export function refreshTickAction(args: {
  sessionMatches: boolean;
  kind: RefreshKind;
  hidden: boolean;
  kickoff: boolean;
}): RefreshTickAction {
  if (!args.sessionMatches) return "stop";
  if (args.kind === "auto" && !args.kickoff && args.hidden) return "defer";
  return "run";
}

/** What a tap of the Refresh button should do — see {@link manualRefreshDecision}. */
export type ManualRefreshDecision = "run" | "promote" | "cooldown";

/**
 * Decide how to handle a manual tap of the Refresh button, kept pure so the
 * (otherwise stateful) credit-saving rules are testable in isolation:
 *
 *  - **cooldown** — a manual refresh was accepted only moments ago (within
 *    {@link MANUAL_REFRESH_COOLDOWN_MS}), or one is already in flight. Treat this
 *    tap as an accidental double-click: acknowledge it on screen but spend no
 *    credits on a second forced pull.
 *  - **promote** — an *automatic* background pull is mid-flight. We can't start a
 *    second overlapping refresh, but the user's deliberate tap should win, so the
 *    in-flight round is upgraded to a manual one: it gets the manual feedback and
 *    completion toast, and pushes the next automatic refresh out by the full
 *    configured interval — so it truly feels like the manual refresh took over.
 *  - **run** — nothing is in flight and the cooldown has lapsed: do the manual
 *    pull now.
 */
export function manualRefreshDecision(args: {
  refreshing: boolean;
  inFlightKind: RefreshKind | null;
  lastManualAt: number;
  now: number;
  cooldownMs?: number;
}): ManualRefreshDecision {
  const cooldownMs = args.cooldownMs ?? MANUAL_REFRESH_COOLDOWN_MS;
  // A manual pull already running, or a second tap within the cooldown window of
  // the last accepted one, is an accidental double-tap: don't spend more credits.
  if (args.refreshing && args.inFlightKind === "manual") return "cooldown";
  if (args.now - args.lastManualAt < cooldownMs) return "cooldown";
  // An automatic pull is in flight: hand it the manual baton instead of bailing.
  if (args.refreshing && args.inFlightKind === "auto") return "promote";
  return "run";
}

/**
 * NAV-priced asset classes that are real, tickered funds and so can be priced
 * live (their NAV publishes ~once a day). Only genuine `mutual_fund` holdings
 * qualify.
 *
 * `money_market` funds are deliberately excluded: their NAV is pinned at $1 by
 * design, so it never moves — requesting a quote for them only ever returns the
 * same dollar and wastes a free-tier credit. They keep their exported value,
 * like synthetic `cash`/`savings` rows (which have no ticker at all).
 */
const FETCHABLE_NAV_CLASSES = new Set(["mutual_fund"]);

interface SessionState {
  config: AppConfig;
  passphrase: string | null;
  data: MobileExport | null;
}

export class App {
  private readonly root: HTMLElement;
  private readonly state: SessionState;
  /** The last computed model, kept so the currency toggle can re-render it. */
  private model: DashboardModel | null = null;
  /**
   * Persistent IndexedDB-backed store for the live 1D/1W graphs'
   * intraday/daily bars (smart-backfill across re-opens). Created lazily on the
   * first live-graph build so the default chart path never touches IndexedDB.
   */
  private timeSeriesStore: TimeSeriesStore | null = null;
  /** The decrypted-from envelope and when it was downloaded (for re-download skip). */
  private envelope: Envelope | null = null;
  private envelopeAt: number | null = null;
  /** Last `portfolio.meta.json` version stamp seen, for the cheap freshness probe. */
  private metaVersion: string | null = null;
  /**
   * ISO publish time of the **best-available** blob, read from the
   * `portfolio.meta.json` sidecar (`published_at`). This is the Pillar-1
   * "will a fresh blob save a token?" signal (assumption 8) — the orchestrator
   * keys its `blobDaysOld` freshness on the *remote metadata's* recency, never the
   * on-device blob's download age. Null until a sidecar with a publish time is read.
   */
  private blobPublishedAt: string | null = null;
  /**
   * Epoch ms of the last successful network data pull (fresh quotes or FX),
   * loaded from persistent storage at startup so the very first cache-only
   * paint can already show when the data was last pulled.
   */
  private lastDataPullAt: number | null = readLastPull();
  /**
   * The most recent live-coverage summary (e.g. "13/13 live, 5 NAVs expected
   * tonight"), kept so
   * a subsequent cache-only re-paint (currency toggle, blob swap) can re-show it
   * instead of blanking the status the user just read. Set after each live
   * refresh; surfaced on the overview as a calm inline note.
   */
  private lastCoverage: string | null = null;
  /**
   * The structured facts behind {@link lastCoverage}, kept so the manual-refresh
   * toast can re-summarise the same network round without re-deriving them.
   */
  private lastCoverageFacts: CoverageFacts | null = null;
  /** NAV-priced symbols from the latest fetch plan, for coverage classification. */
  private lastNavSymbols: ReadonlySet<string> = new Set();
  /**
   * Honest one-liner about the login-time prefetch, surfaced on the unlock
   * ("Welcome back") screen so the warming of live prices is visible: "Warming
   * live prices…" while in flight, then the real outcome (what it pulled + when
   * it last pulled). Null until the prefetch starts. Never claims a value is live
   * that isn't — it only ever describes what the prefetch actually fetched.
   */
  private prefetchStatus: string | null = null;
  /**
   * The in-flight prefetch, awaited by {@link maybeSignalPrefetchSpin} so the
   * login refresh-glyph spin can fire once the prefetch settles.
   */
  private prefetchPromise: Promise<void> | null = null;
  /**
   * What Step 1 (the login prefetch) actually booked — the market/NAV symbol set
   * and whether FX was warmed — so the post-decrypt kickoff (Step 2) can reconcile
   * the decrypted truth against it via {@link reconcileHandshake} and pull only the
   * deduped diff (Pillar 2 / WS5). Null until the first prefetch books a set.
   */
  private prefetchBooked: { symbols: string[]; predicted?: string[]; fx: boolean } | null = null;
  /**
   * C9 — the **deferred work-queue**: symbols a pull skipped for budget, each with
   * the reason it was parked, so the next round *explicitly* drains them (or clears
   * an entry with a logged reason once the decrypted blob's `nav_prices` already
   * satisfied it) — never the old "hope its per-symbol cache TTL re-pulls it" that
   * silently stranded NAVs when the blob didn't rescue them. Bounded by
   * {@link DEFERRED_QUEUE_MAX} and per-entry retry-capped so a never-filling symbol
   * cannot drive an infinite burst.
   */
  private deferredQueue = new DeferredQueue();
  /**
   * Per-holding update-status signals threaded into the holdings render so each
   * card narrates its own price-pull cycle:
   *   - {@link holdingUpdatedAt}: epoch ms a symbol last had a *fresh* price land,
   *     driving the brief "Updated ✓" success flash that settles to "Updated <time>";
   *   - {@link holdingQueued}: symbols parked behind the free-tier budget this round,
   *     shown as the calmer "Updating…" queued state until they actually pull.
   * The live "Updating…" state at the *start* of a round is applied straight to
   * the DOM ({@link markHoldingsUpdating}) so motion shows the instant a pull begins.
   */
  private holdingUpdatedAt = new Map<string, number>();
  private holdingQueued = new Set<string>();
  /**
   * Whether the login prefetch actually fetched *new* data (≥1 quote or a live
   * FX pull). Drives the one-off login spin of the Refresh glyph: it spins only
   * when the prefetch genuinely got something newer, and stays still when the
   * book was already as fresh as possible.
   */
  private prefetchFetchedSomething = false;
  /**
   * Whether the prefetch status line may be shown on the unlock screen. True only
   * for the fresh page-load prefetch — so the login banner reflects a genuinely
   * fresh warm-up. After a lock (auto or manual) it is cleared, so a stale status
   * never reappears; the next unlock interaction re-warms the caches silently.
   */
  private prefetchShownOnLogin = false;
  /**
   * Symbols the latest *network* refresh genuinely failed to price (primary
   * couldn't, backup didn't fill) — still stuck on a last-known value. Kept so
   * the "Prices up to date" startup confirmation never claims everything is
   * current while a holding actually failed to price.
   */
  private lastUnresolvedFailures: string[] = [];
  /** Symbols whose freshly-fetched price was non-positive (suspect/wrong data). */
  private lastSuspectSymbols: string[] = [];
  /** Tiingo fallback budget used so far (hour/day), for the usage overview. */
  private lastTiingoBudget: TiingoBudgetView | null = null;
  /** Symbols served via the Tiingo fallback on the latest network round. */
  private lastTiingoSymbols: string[] = [];
  /**
   * The subset of {@link lastTiingoSymbols} that were a *genuine* fallback this
   * round — the primary tried and fell short (unavailable/outdated) so we pulled
   * from the backup instead. Drives the "N prices via fallback" status note, so a
   * symbol merely smart-routed to the backup for budget efficiency isn't flagged.
   */
  private lastFallbackSymbols: string[] = [];
  /**
   * The Tiingo backup's own error from the latest network round, if it was
   * needed but couldn't be reached (proxy down, Worker `/price` route missing,
   * bad token). Drives the "backup unreachable" banner clause + manual toast so
   * a silently-failing backup provider is visible instead of leaving a holding
   * (e.g. FSKAX) blank with no explanation.
   */
  private lastTiingoError: PriceError | null = null;
  /**
   * Monotonic session token. Bumped on every unlock and on lock so that
   * in-flight background work (timers, fetches) from a previous session is
   * recognised as stale and discarded.
   */
  private sessionId = 0;
  /** Pending auto-refresh timer, if any. */
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** Installed visibility listener, kept so it can be removed on lock. */
  private visibilityHandler: (() => void) | null = null;
  /**
   * Installed `pageshow` listener, kept so it can be removed on lock. Some mobile
   * browsers restore a backgrounded PWA from the bfcache (or after a fingerprint
   * unlock) without a reliable `visibilitychange`, so this is a second, belt-and
   * -braces trigger to resume the refresh the moment the app is shown again.
   */
  private pageShowHandler: ((event: PageTransitionEvent) => void) | null = null;
  /**
   * Installed `online` listener, kept so it can be removed on lock. Fires the
   * moment the device regains a network link, so a dashboard that was paused on
   * "No internet connection" pulls fresh prices immediately rather than waiting
   * out the slow auto-refresh cadence.
   */
  private onlineHandler: (() => void) | null = null;
  /**
   * Connectivity verdict from the last refresh round (see {@link classifyConnectivity}):
   * `offline` (the device has no link), `unreachable` (online, but no price
   * service responded), or `online` (a service answered). Drives the honest
   * "no connection / no new prices" messaging so a refresh never claims to be
   * updating when nothing could actually be fetched.
   */
  private lastConnectivity: ConnectivityState = "online";
  /** Guards against overlapping price refreshes. */
  private refreshing = false;
  /**
   * Kind of the price refresh currently in flight (`null` when idle). Lets a
   * manual tap tell an automatic background pull apart from another manual one,
   * so {@link manualRefreshDecision} can hand an in-flight *auto* round the
   * manual baton instead of bailing.
   */
  private refreshingKind: RefreshKind | null = null;
  /**
   * Set when a manual tap lands mid-flight on an automatic pull: the running
   * round finishes as a *manual* one (manual feedback + toast, and the next
   * auto-refresh pushed out by the full configured interval), so the tap takes
   * priority and "feels like" a manual refresh without a second overlapping pull.
   */
  private promoteToManual = false;
  /**
   * Wall-clock time of the last *accepted* manual refresh, used by
   * {@link manualRefreshDecision} to swallow accidental double-taps without
   * spending a second forced pull's worth of credits.
   */
  private lastManualAt = 0;
  /**
   * Whether every live-priced holding was up to date as of the last network
   * refresh. Starts true so a portfolio that prices in a single round stays
   * quiet; it flips false the moment a round has to defer symbols (the staged
   * fill is underway), and the false→true transition is what pops the brief
   * "all prices live" confirmation once the last laggard catches up.
   */
  private pricesAllLive = true;
  /**
   * Wall-clock time of the last background encrypted-blob check, so the
   * automatic "is there a newer export?" probe still runs on a slow cadence for
   * portfolios whose prices never fully stop deferring (more symbols than the
   * free-tier budget). Without this throttle such portfolios would burst
   * forever and never auto-detect new data.
   */
  private lastBlobCheckAt = 0;
  /**
   * Epoch-ms the 1D/1W graph bars were last primed this session, or `null` if not
   * yet primed. The **sole 1D-bar authority** during market hours (Pillar 4): the
   * clock-hour gate ({@link barClockHourDue}) keys off this so a bar is primed at
   * most once per `:00`, instead of `primeStaleGraphPackages` firing every refresh
   * round (the self-perpetuating storm Pillar 1 dissolved it to avoid).
   */
  private lastBarPrimeMs: number | null = null;
  /**
   * When the manual refresh feedback (pill + spinning glyph) may be torn down.
   * A cache-served refresh finishes almost instantly, so we hold the feedback
   * until at least this time for it to be perceptible. Paired with
   * {@link manualFeedbackTimer}, the pending deferred-teardown timer.
   */
  private manualFeedbackUntil = 0;
  private manualFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  /** Pending idle auto-lock timer, if any. */
  private autoLockTimer: ReturnType<typeof setTimeout> | null = null;
  /** Pending timer that surfaces the "locking soon" warning ahead of the lock. */
  private autoLockWarnTimer: ReturnType<typeof setTimeout> | null = null;
  /** The live "locking soon" warning element, if currently shown. */
  private autoLockWarnEl: HTMLElement | null = null;
  /** Interval ticking the warning's countdown, if shown. */
  private autoLockCountdownTimer: ReturnType<typeof setInterval> | null = null;
  /** The configured idle-lock window in ms (0 = disabled). */
  private autoLockTimeoutMs = 0;
  /** Epoch-ms the idle-lock timers were last (re)armed, for the reset throttle. */
  private autoLockArmedAt = 0;
  /** Epoch-ms the resume token's activity stamp was last refreshed (throttle). */
  private lastResumeTouchAt = 0;
  /** True for the first paint after a page reload resumed the session. */
  private resumedFromRefresh = false;
  /** Installed activity listeners that reset the idle auto-lock timer. */
  private activityHandler: (() => void) | null = null;

  /**
   * Demo / preview state, present only while a sample dashboard is on screen.
   * Holds the active persona, the live-tick index (0 = frozen snapshot), whether
   * the offline live-sim is running, and the deep-linked tab still to apply.
   */
  private demo: { persona: string; tick: number; sim: boolean; initialTab: string | null } | null = null;
  /** The running live-sim interval, if any (advances {@link demo.tick}). */
  private demoTimer: ReturnType<typeof setInterval> | null = null;
  /** Teardown for an open guided tour, if any. */
  private stopTour: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.state = { config: defaultConfig(), passphrase: null, data: null };
  }

  async start(): Promise<void> {
    this.logVersionUpdate();
    this.state.config = await loadConfig();
    applyProviderLimits(this.state.config);
    const demoParams = this.demoParams();
    if (demoParams.requested) this.enterDemo(demoParams);
    else if (!this.isConfigured()) {
      this.showSetup();
    } else {
      // A page reload (F5) of this tab may resume the unlocked session directly —
      // opt-in, passphrase-wrapped and idle/version/context-bound — so a refresh
      // behaves like the manual refresh button rather than forcing a re-login.
      // Falls through to the normal unlock screen when resume isn't applicable.
      if (await this.tryResumeFromRefresh()) return;
      // Warm live quotes for the symbols we already know about *before* the user
      // finishes unlocking, so the first post-login paint is live rather than
      // starting the per-minute clock from zero. Honours the shared credit budget
      // so it can't double-spend with the later refresh. Kept as a promise so the
      // login spin + welcome status can react once it settles. This is the *fresh
      // page load* warm-up, so its status is allowed to show on the login screen.
      this.startPrefetch({ shownOnLogin: true });
      // First unlock of the session: auto-prompt the fingerprint sheet when the
      // device is enrolled, so a returning user can unlock with a single touch
      // and no extra tap.
      this.showUnlock(undefined, { autoPrompt: true });
    }
  }

  /**
   * Attempt to resume the unlocked session after a full-page reload (F5).
   *
   * Returns `true` only when it took over the boot flow (the resume path is now
   * driving the unlock); `false` means "not applicable — carry on to the normal
   * unlock screen". All of these must hold for a resume to even be tried:
   *   - the user opted in ({@link AppConfig.resumeOnRefresh});
   *   - this navigation is a reload / back-forward, not a cold open;
   *   - the device is **not** biometric-enrolled — a fingerprint auto-prompt is
   *     the stronger path, so we prefer it and never weaken it with a token;
   *   - a stored token exists and is still valid (version + data-source match and
   *     within the idle window — see {@link isResumeTokenValid}).
   *
   * On a valid token we unwrap the passphrase and drive the ordinary
   * {@link unlock} flow, so a newer blob that arrived since the last load is
   * re-downloaded and re-decrypted exactly as on a manual refresh.
   */
  private async tryResumeFromRefresh(): Promise<boolean> {
    if (!this.state.config.resumeOnRefresh) return false;
    if (!isReloadNavigation()) return false;
    // Prefer biometric: a single fingerprint touch is stronger than a stored
    // token, so an enrolled device keeps the one-tap auto-prompt instead.
    if (hasBiometricEnrolment()) return false;
    const env = readResumeEnvelope();
    const ok = isResumeTokenValid(env, {
      now: Date.now(),
      appVersion: APP_VERSION,
      blobUrl: resolveBlobUrl(this.state.config) ?? "",
      autoLockMinutes: this.state.config.autoLockMinutes,
    });
    if (!env || !ok) {
      // Stale / mismatched / idle-expired token: drop it and re-authenticate.
      clearResumeToken();
      return false;
    }
    let passphrase: string;
    try {
      passphrase = await unwrapResumePassphrase(env);
    } catch {
      clearResumeToken();
      return false;
    }
    this.resumedFromRefresh = true;
    await this.unlock(passphrase);
    return true;
  }

  /**
   * Kick off a single live-data prefetch, unless one is already in flight (or has
   * already run this page load / since the last lock). `shownOnLogin` decides
   * whether its status line may surface on the unlock screen: true for the fresh
   * page-load warm-up, false for the silent re-warm fired by an unlock
   * interaction after a lock — so a stale status never reappears on the login.
   */
  private startPrefetch(options: { shownOnLogin: boolean }): void {
    if (this.prefetchPromise) return;
    this.prefetchShownOnLogin = options.shownOnLogin;
    this.prefetchPromise = this.prefetchLiveData();
  }

  /**
   * Login-time prefetch (idea B): using the cached priority plan from the last
   * session, start filling the quote + FX caches while the passphrase is typed
   * and the blob decrypts. No decrypted data is needed — the plan is just
   * tickers + coarse sizes — and {@link loadQuotes}/{@link loadFxRates} write
   * straight into the same caches the real refresh reads, so the work is shared,
   * never duplicated. Best-effort: any failure is swallowed.
   *
   * It is **market-aware** (see {@link planPrefetch}): FX is warmed first in line
   * (the forex market trades longest and values the whole book), then quotes only
   * for what is actually worth a credit — the stocks/ETFs while the market is
   * open, the after-close NAVs and any outdated settled close while it is shut,
   * and nothing at all when everything is already in hand. A large closed-market
   * catch-up rapid-fires through Tiingo instead of trickling through the primary.
   *
   * The outcome is surfaced honestly on the unlock screen (see
   * {@link describePrefetch}) and decides the one-off login spin of the Refresh
   * glyph — it only spins when the prefetch actually got something newer.
   */
  private async prefetchLiveData(): Promise<void> {
    const { config } = this.state;
    if (!config.apiKey) return;
    const plan = readSymbolPlan();
    if (plan.length === 0) {
      // No plan yet (first ever run): we can still warm FX cheaply.
      this.prefetchStatus = describePrefetch({
        inFlight: true,
        hasPlan: false,
        quoteFetched: 0,
        quoteTotal: 0,
        fxLive: false,
        lastPullAt: this.lastDataPullAt,
      });
      this.updatePrefetchStatus();
      this.pollLog("login", "Login warm-up started — no symbol plan yet, warming FX only.");
      const warmth = await this.warmPrefetchFx(config);
      this.pollLog(
        "fx",
        `Login warm-up: EUR/USD ${warmth.eurUsd !== null ? warmth.eurUsd.toFixed(5) : "—"} ` +
          `from ${warmth.spotSource} (${warmth.fxLive ? "freshly pulled" : "served from cache"}).`,
      );
      this.pollLog(
        "primary",
        `Login warm-up: no symbol plan yet, only warmed FX (EUR/USD spot ${warmth.spotSource}). No quote credits spent.`,
      );
      this.finishPrefetch({ quoteFetched: 0, quoteTotal: 0, hasPlan: false, fxLive: warmth.fxLive });
      return;
    }
    // Market-aware plan: only fetch what is actually worth a credit right now —
    // stocks/ETFs while the market is open, the after-close (pre-NAV) mutual
    // funds and any outdated settled close while it is shut, nothing when the
    // book is already current. Decided purely from the cached plan + caches +
    // device-stored graph bars, no decrypted data needed.
    const navFetchSymbols = new Set(plan.filter((e) => e.priceType !== "market").map((e) => e.symbol));
    const marketOpen = isUsMarketOpen();
    const now = new Date();
    const targets = this.prefetchTargets(plan, now);
    // Graph staleness is read cache-only from the device's bar store (no decrypt),
    // and only matters when the live graphs are switched on. The market sleeve is
    // the *only* thing the 1D/1W graphs ever pull — NAV funds never get bars.
    const graphStale = await this.prefetchGraphStaleness(targets.marketSymbols, now);
    const prefetch = planPrefetch({
      marketOpen,
      marketSymbols: targets.marketSymbols,
      outdatedMarketSymbols: targets.outdatedMarketSymbols,
      awaitingNavSymbols: targets.awaitingNavSymbols,
      tiingoAvailable: resolvePriceProxyUrl(config) !== null,
      graphSessionStale: graphStale.session,
      graphWeekStale: graphStale.week,
    });
    // C1 — route the warm-up's leg decision through the **single brain**. The
    // planPrefetch above named *which* symbols/providers are worth a credit; this
    // pre-decrypt {@link planPull} pass is the leg gate layered on top, so the
    // warm-up obeys the very same freshness tiers + clock-hour bar gate + rolling
    // quote / FX overlays as the post-decrypt kickoff and can never diverge from
    // it. A suppressed leg drops its symbols here (they are picked up by the
    // kickoff/auto round if still due), so no credit is spent the brain didn't
    // approve. FX is gated by the warm-up's own interval-aware {@link warmPrefetchFx}
    // (same user interval as Overlay 3), so it is not re-gated here.
    const warmupPlan = this.planWarmupPull(plan, targets, now);
    this.pollLog("orchestrator", `Login warm-up plan — ${describePlan(warmupPlan)}.`);
    if (!warmupPlan.legs.quotes) prefetch.symbols = [];
    if (!warmupPlan.legs.nav) prefetch.navSymbols = [];
    if (!warmupPlan.legs.dayBars) prefetch.graphSessionSymbols = [];
    if (!warmupPlan.legs.weekBars) prefetch.graphWeekSymbols = [];
    const quoteTotal =
      prefetch.symbols.length +
      prefetch.navSymbols.length +
      new Set([...prefetch.graphSessionSymbols, ...prefetch.graphWeekSymbols]).size;
    this.prefetchStatus = describePrefetch({
      inFlight: true,
      hasPlan: true,
      quoteFetched: 0,
      quoteTotal,
      fxLive: false,
      lastPullAt: this.lastDataPullAt,
    });
    this.updatePrefetchStatus();
    // The warm-up draws on the *same* free-tier per-minute/day budget as the
    // kickoff refresh that follows, so log it like any other pull (otherwise the
    // kickoff's "PRIMARY 0/min" looks unexplained in the polling log). Spell out
    // which branch of the routing fired and why, plus the prior-session delta.
    this.pollLog("login", this.describePrefetchRoute(plan.length, marketOpen, prefetch, graphStale));
    // Currency first, always: the forex market trades longest and values the
    // whole book, so warm the FX cache before any ticker — FX simply goes first
    // in line, with no per-minute reserve held back from the quotes. The live
    // EUR/USD spot is pulled from Twelve Data first (the most relevant mark for
    // a USD-booked book), not just the keyless end-of-day base rates.
    const warmth = await this.warmPrefetchFx(config);
    const fxLive = warmth.fxLive;
    // The prefetch FX pull shares the same EUR/USD budget as every other pull, so
    // it must show up in the polling log too (it was previously silent).
    this.pollLog(
      "fx",
      `Login warm-up: EUR/USD ${warmth.eurUsd !== null ? warmth.eurUsd.toFixed(5) : "—"} ` +
        `from ${warmth.spotSource} (${fxLive ? "freshly pulled" : "served from cache"}).`,
    );
    // Graph-bar backfill (idea #1): when a 1D/1W curve is stale and we have a
    // Tiingo pipe, pull its bars now — the market sleeve only, *never* NAV funds —
    // so the graph is warm on first paint and each bar's newest mark is folded
    // back into the quote cache, sparing those symbols a separate quote credit.
    // C2: pass the *pre-decrypt* currency map (from the unencrypted plan) so the
    // primed quotes actually land — without it `primeQuotesFromBars` skipped every
    // bare native price and the post-decrypt kickoff saw an empty quote cache and
    // re-pulled the whole market sleeve (the "31/40 Tiingo in 40s" double-pull).
    const planCurrency = this.planCurrencyMap(plan);
    const graphFetched = await this.prefetchGraphBars(
      prefetch.graphSessionSymbols,
      prefetch.graphWeekSymbols,
      config,
      now,
      planCurrency,
    );
    // After-hours FX close completion: when the session's price bars were already
    // in hand (so no 1D backfill ran above to grab the FX track alongside them)
    // but the stored EUR→USD track never reached the 16:00 ET close, pull the FX
    // alone so the freeze anchor + currency-effect split read the true settle, not
    // a mid-session rate. Gated to the closed market — during the session the
    // close has simply not happened yet — and skipped when a session backfill just
    // fetched the FX in the same pass. Routed through the same reservation/breaker.
    if (!marketOpen && graphStale.fxIncomplete && prefetch.graphSessionSymbols.length === 0) {
      await this.prefetchSessionFx(config, now);
    }
    // C5 — bars-first NAV. Before spending a NAV *quote* credit, pull the 1W
    // daily-NAV bars for any moving fund whose week is not covered through the
    // latest settled session: the last bar is that settled NAV, it fills the whole
    // week line in one shot, and it is primed back as the (value-dated, settled)
    // headline NAV. The funds it primes are dropped from the quote leg below, so
    // the separate NAV quote is skipped — no duplicate spend, week correct in one.
    const navBarsPrimed = await this.prefetchNavWeekBars(prefetch.navSymbols, config, now, planCurrency);
    const navPrimedSet = new Set(navBarsPrimed);
    const navQuoteSymbols = prefetch.navSymbols.filter((s) => !navPrimedSet.has(s));
    const quoteWork = prefetch.symbols.length + navQuoteSymbols.length;
    if (quoteWork === 0) {
      this.pollLog(
        "primary",
        `Login warm-up: no quotes to warm beyond the graph backfill — ` +
          `${graphFetched.stored} graph series, FX ${warmth.spotSource}. No extra quote credits spent.`,
      );
      this.finishPrefetch({ quoteFetched: 0, quoteTotal, hasPlan: true, fxLive, graphFetched: graphFetched.stored });
      // C3: even with no quote work, the graph backfill may have primed market
      // quotes — book those *actual* fills so the reconcile doesn't re-pull them.
      // C5: bars-first NAV fills count as genuine fills too.
      this.prefetchBooked = {
        symbols: [...graphFetched.primed, ...navBarsPrimed],
        predicted: plan.map((e) => e.symbol),
        fx: true,
      };
      return;
    }
    const options = this.buildQuoteOptions(navFetchSymbols, config);
    // Pillar 5 (WS6) — the *provider fan-out* is now the **decision of record** for
    // this login pull, not just a log line. The pure planner owns the split of the
    // market sleeve across the two providers; the dispatch below simply executes
    // the legs it names. Each leg still re-clamps against the live reservation +
    // 429 breaker, so the planner can only ever propose *fewer* credits than are
    // truly spendable — it cannot overspend. Logged whether or not it fans out, so
    // no login routing is silent.
    const fanoutNow = Date.now();
    const fanout = planFanout({
      kind: "start",
      symbols: prefetch.symbols,
      navSymbols: navQuoteSymbols,
      twelveDataSpendable: twelveDataAvailable(fanoutNow),
      tiingoSpendable: tiingoAvailable(fanoutNow),
      tiingoAvailable: resolvePriceProxyUrl(config) !== null,
      twelveDataBatch: FREE_TIER.creditsPerMinute,
    });
    this.pollLog("login", `Login fan-out (${prefetch.symbols.length} mkt symbol(s)): ${fanout.reason}`);
    // Execute the fan-out the planner decided: the Twelve Data lead (≤8) runs
    // alongside any Tiingo overflow for an instant first paint. C8: NAV funds ride
    // the planner's split too, so when Twelve Data's minute is already spent (e.g.
    // the 1D graph backfill ate it) and Tiingo is idle, NAVs spill to Tiingo on the
    // reserve-exempt login pull instead of starving. Symbols that fit no budget this
    // round are recorded on the C9 deferred work-queue, drained by the next round.
    let fetchedCount = 0;
    const twelveSymbols = [...fanout.twelveData, ...fanout.navTwelveData];
    const legs: Promise<number>[] = [];
    if (twelveSymbols.length > 0) {
      legs.push(this.prefetchViaPrimary(twelveSymbols, config, options));
    }
    const tiingoSymbols = [...fanout.tiingo, ...fanout.navTiingo];
    if (tiingoSymbols.length > 0) {
      legs.push(this.prefetchViaTiingo(tiingoSymbols, navFetchSymbols, plan, config, options));
    }
    for (const filled of await Promise.all(legs)) fetchedCount += filled;
    if (fanout.deferred.length > 0) {
      this.pollLog(
        "login",
        `Login fan-out: ${fanout.deferred.length} symbol(s) over budget, deferred to the post-unlock kickoff ` +
          `[${fanout.deferred.join(", ")}].`,
      );
      // C9: a deferral is a tracked promise, not a hope. Queue it so the next round
      // explicitly drains it (or clears it with a logged reason once the blob covers it).
      this.enqueueDeferred(fanout.deferred, "login fan-out over budget");
    }
    this.finishPrefetch({
      quoteFetched: fetchedCount,
      quoteTotal,
      hasPlan: true,
      fxLive,
      graphFetched: graphFetched.stored,
    });
    // Record what Step 1 booked so the post-decrypt kickoff (Step 2) can reconcile
    // the decrypted truth against it and pull only the deduped diff (Pillar 2/WS5).
    // C3: book the **true filled set** — the symbols actually dispatched to a
    // provider leg this round plus the market symbols the graph backfill primed —
    // and **exclude** the deferred set (handed to the C9 queue). Previously this
    // booked *intent* (every planned symbol incl. deferred, but omitting the
    // graph-primed ones), which made the reconcile re-pull the whole sleeve.
    // `predicted` stays the full last-known-holdings universe so Step 2 can label a
    // diff symbol "newly-bought" only when the prediction genuinely never knew it.
    const deferredSet = new Set(fanout.deferred);
    const bookedSet = new Set<string>([
      ...fanout.twelveData,
      ...fanout.tiingo,
      ...fanout.navTwelveData,
      ...fanout.navTiingo,
      ...graphFetched.primed,
      ...navBarsPrimed,
    ]);
    this.prefetchBooked = {
      symbols: [...bookedSet].filter((s) => !deferredSet.has(s)),
      predicted: plan.map((e) => e.symbol),
      fx: true,
    };
  }

  /**
   * Compose the one-line routing-decision log for the login warm-up: which branch
   * of {@link planPrefetch} fired and why, the NAV-to-Twelve split, the graph-bar
   * backfill, and a short delta against the prior-session snapshot — so the
   * Settings polling log explains *why* this login spent (or saved) what it did.
   */
  private describePrefetchRoute(
    planSize: number,
    marketOpen: boolean,
    prefetch: ReturnType<typeof planPrefetch>,
    graphStale: { session: string[]; week: string[] },
  ): string {
    const prior = readSessionStatus();
    const priorBit = prior
      ? ` Last seen: market ${prior.marketPhase}, ` +
        `closes ${prior.marketCovered ? "in hand" : "behind"}, NAVs ${prior.navCovered ? "in hand" : "behind"}.`
      : "";
    const graphBits: string[] = [];
    if (graphStale.session.length > 0) graphBits.push(`1D bars ×${prefetch.graphSessionSymbols.length}`);
    if (graphStale.week.length > 0) graphBits.push(`1W bars ×${prefetch.graphWeekSymbols.length}`);
    const graphClause = graphBits.length > 0 ? ` Graph backfill via Tiingo: ${graphBits.join(", ")}.` : "";
    const quoteClause =
      prefetch.symbols.length > 0
        ? `${prefetch.symbols.length} quote(s) via ${prefetch.route === "tiingo" ? "Tiingo rapid-fire" : "Twelve Data"}`
        : "no market quotes";
    const navClause =
      prefetch.navSymbols.length > 0 ? `, ${prefetch.navSymbols.length} NAV fund(s) via Twelve Data` : "";
    return (
      `Login warm-up route — market ${marketOpen ? "open" : "closed"} (plan of ${planSize}). ` +
      `${quoteClause}${navClause}.${graphClause}${priorBit}`
    );
  }

  /**
   * Warm the currency caches at login — currency first, always (the forex market
   * trades longest and values the whole book). The **live EUR/USD spot is pulled
   * from Twelve Data first** (one credit, the most relevant mark for valuing a
   * USD-booked book), with the Tiingo backup FX provider and the keyless ECB
   * end-of-day rate as graceful fallbacks; the keyless base rates
   * ({@link loadFxRates}) are warmed alongside for any non-USD holdings and feed
   * the end-of-day fallback. A still-fresh cached spot (within the user-set
   * auto-refresh interval) is reused for free, so a re-login moments after a
   * refresh spends nothing.
   *
   * Returns whether a genuinely fresh rate was pulled (a live/Tiingo spot, or
   * fresh base rates) so the login spin + status read honestly, plus the spot's
   * provenance for the polling log.
   */
  private async warmPrefetchFx(
    config: AppConfig,
  ): Promise<{ fxLive: boolean; spotSource: EurUsdSource; eurUsd: Decimal | null }> {
    const fx = await loadFxRates().catch(() => undefined);
    const eurUsd = await loadEurUsd(config.apiKey, {
      eodFallback: fx?.fx.rates.USD ?? null,
      // Use the user-set interval: a still-fresh spot within the interval is
      // reused for free; older than the interval we pull fresh. No hardcoded 15 min.
      ttlMs: config.updateMinutes * 60 * 1000,
      tiingoProxyUrl: resolvePriceProxyUrl(config),
      // Frozen over the weekend forex close — serve the cached Friday spot.
      forexOpen: isForexMarketOpen(),
    }).catch(() => null);
    const spotSource: EurUsdSource = eurUsd?.source ?? "none";
    const spotLive = spotSource === "live" || spotSource === "tiingo";
    const baseLive = fx ? !fx.cached : false;
    return { fxLive: spotLive || baseLive, spotSource, eurUsd: eurUsd?.now ?? null };
  }

  /**
   * Split the cached prefetch plan into the symbols worth warming at login,
   * judged against what the caches already hold — so the market-aware warm-up
   * ({@link planPrefetch}) can skip a closed market that is already up to date.
   * Pure cache reads (no decrypted data): mirrors {@link outdatedFetchCount}'s
   * per-symbol "behind" test against the latest settled close / settled NAV.
   */
  private prefetchTargets(
    plan: PlannedSymbol[],
    now: Date = new Date(),
  ): {
    marketSymbols: string[];
    outdatedMarketSymbols: string[];
    awaitingNavSymbols: string[];
  } {
    const cached = readCachedQuotes();
    const settled = latestSettledSessionDate(now);
    const marketOpen = isUsMarketOpen(now);
    const marketSymbols: string[] = [];
    const outdatedMarketSymbols: string[] = [];
    const awaitingNavSymbols: string[] = [];
    for (const entry of plan) {
      const cq = cached.get(entry.symbol)?.quote;
      if (entry.priceType === "market") {
        marketSymbols.push(entry.symbol);
        if (!holdsSettledClose(cq, settled)) outdatedMarketSymbols.push(entry.symbol);
      } else {
        // A NAV fund is worth warming only while the market is *closed* and we do
        // not yet hold the latest settled session's NAV — the after-close window
        // in which tonight's NAV is awaited until it lands. While the session is
        // open the NAV cannot have struck yet, so there is nothing to chase.
        const have = cq?.valueDate ?? null;
        if (!marketOpen && (!have || have < settled)) awaitingNavSymbols.push(entry.symbol);
      }
    }
    return { marketSymbols, outdatedMarketSymbols, awaitingNavSymbols };
  }

  /**
   * Read, **cache-only** (no decrypt), which market sleeve symbols the live 1D/1W
   * graphs are still missing bars for on this device — the pre-flight that lets
   * the login warm-up pull a stale graph's bars in the same expensive Tiingo pass
   * as the catch-up quotes. NAV funds are never included: the graphs never plot
   * them, so they never need (or get) bars. Returns empty sets when there are no
   * market symbols to plot.
   *
   * `fxIncomplete` is the after-hours signal the FX-only backfill keys on: the 1D
   * EUR→USD track on the device has **not** reached the session close (it was last
   * fetched mid-session, or never), so the freeze anchor / currency-effect split
   * would otherwise read a mid-session rate as "the close" until the next session.
   * See {@link sessionFxBarsComplete} and {@link prefetchSessionFx}.
   */
  private async prefetchGraphStaleness(
    marketSymbols: string[],
    now: Date,
  ): Promise<{ session: string[]; week: string[]; fxIncomplete: boolean }> {
    if (marketSymbols.length === 0) {
      return { session: [], week: [], fxIncomplete: false };
    }
    const store = this.ensureTimeSeriesStore();
    const day = lastSessionDate(now);
    const today = await store.loadSession(day).catch(() => null);
    const marketClosed = !isUsMarketOpen(now);
    const close = sessionCloseMs(day);
    // Expected-empty ≠ stale (market_open_token_burn_fix_plan.md WS1): a fresh,
    // just-opened session has no completed intraday bar yet, so the absence of
    // today's bars is *expected*. Queueing a 1D backfill for a window that has
    // not elapsed is the market-open burn — skip it and let the curve accrue
    // tick-by-tick from the live tip. Only once a full bar interval of trading
    // time has passed does a still-missing symbol read genuinely stale.
    //
    // A symbol with *partial* bars that never reached the 16:00 ET close is the
    // after-close sibling of the missing case (scenario F): bars pulled
    // mid-session sit in the store looking present, so a length check alone would
    // leave the 1D curve ending early. Once the market is shut, treat such a stale
    // partial-day track as stale too so the same backfill completes its tail (and
    // grabs the FX track alongside — the FX-close repair below is then a no-op).
    const session = sessionIsWarmingUp(now)
      ? []
      : marketSymbols.filter((s) => {
          const bars = today?.bars[s];
          if (!bars?.length) return true;
          return marketClosed && !sessionBarsComplete(bars, close, INTRADAY_BAR_INTERVAL_MS);
        });
    const weekStored = await store.loadSession(WEEK_STORE_KEY).catch(() => null);
    // Match the 1W build's coverage test, not a looser presence check: a
    // stale-but-present store (only pre-settlement bars) must read *stale* here,
    // else priming is skipped and the dashboard build re-pulls it via Tiingo
    // moments later (docs/tiingo_polling_storm_cleanup_plan.md item 5b).
    const week = weekStaleSymbols(weekStored, marketSymbols, now);
    // The 1D FX track reads incomplete when no bar has reached this session's
    // 16:00 ET close — the after-hours gap the FX-only backfill closes.
    const fxIncomplete = !sessionFxBarsComplete(today?.fx ?? [], close);
    return { session, week, fxIncomplete };
  }

  /**
   * The decrypted holdings' native-currency map (price symbol → currency), used
   * to prime quotes from graph bars after unlock. Empty before the first render.
   */
  private primingCurrencyMap(): Map<string, string | null> {
    const map = new Map<string, string | null>();
    for (const h of this.model?.holdings ?? []) {
      const symbol = h.priceSymbol ?? h.symbol;
      if (symbol) map.set(symbol, h.nativeCurrency ?? null);
    }
    return map;
  }

  /**
   * The **pre-decrypt** currency map (C2): native currency per ticker, read from
   * the unencrypted symbol plan instead of the decrypted model. Lets the login
   * warm-up's {@link prefetchGraphBars} prime a quote from a bare native bar price
   * before unlock, so the freshness ledger is honest at the post-decrypt kickoff
   * (no faked "market quote missing" → heavily-outdated full re-pull). A `null`
   * entry (legacy plan, or a ticker whose holdings disagreed on currency) simply
   * falls back to post-decrypt priming for that symbol.
   */
  /**
   * C6 — the symbols whose decrypted native currency differs from the currency
   * the pre-decrypt plan (C2) assumed. Compares the saved {@link readSymbolPlan}
   * (written last session, read pre-decrypt) against the now-decrypted holdings'
   * `nativeCurrency`. A difference means a quote Step 1 may have primed in the
   * wrong denomination, so the reconcile must re-pull it. A plan entry with no
   * stored currency (`null`, e.g. a legacy plan) never counts as a mismatch — it
   * made no assumption to contradict. A steady-state USD-only book returns none.
   */
  private currencyMismatchSymbols(): string[] {
    const planCurrency = this.planCurrencyMap();
    if (planCurrency.size === 0) return [];
    const mismatches: string[] = [];
    const seen = new Set<string>();
    for (const h of this.model?.holdings ?? []) {
      const symbol = h.priceSymbol ?? h.symbol;
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      const assumed = planCurrency.get(symbol);
      const actual = h.nativeCurrency ?? null;
      if (assumed != null && actual != null && assumed !== actual) mismatches.push(symbol);
    }
    return mismatches;
  }

  private planCurrencyMap(plan: PlannedSymbol[] = readSymbolPlan()): Map<string, string | null> {
    const map = new Map<string, string | null>();
    for (const e of plan) map.set(e.symbol, e.nativeCurrency);
    return map;
  }

  /**
   * C9 — record budget-deferred symbols on the work-queue, delegating the bounded
   * bookkeeping to {@link DeferredQueue}. Each entry carries the reason it was
   * parked; re-deferring a still-queued symbol does not reset its attempt count.
   */
  private enqueueDeferred(symbols: Iterable<string>, reason: string): void {
    this.deferredQueue.enqueue(symbols, reason);
  }

  /**
   * C9 — drain the deferred work-queue at the start of a round. Any queued symbol
   * the decrypted blob has since satisfied is **cleared with a logged reason**
   * rather than re-fetched; the genuinely-still-missing symbols are returned so the
   * round can pull them explicitly. Per-symbol attempts are capped so a
   * never-filling symbol is dropped (logged) instead of bursting forever. Returns
   * the symbols that still need a pull this round.
   *
   * "Satisfied" tests **freshness, not mere presence** (the freshness-plan §3
   * fix): a parked symbol is only cleared when its cached observation `at` is
   * within the live window (the user-set auto-refresh interval), so a symbol whose
   * cache is *stale* stays queued and is threaded into the round's fetch set rather
   * than being silently cleared on the strength of an aged value. The freshly-aged
   * `at` must not be in the future (clock skew), mirroring the live-badge guards.
   */
  private drainDeferredQueue(now: Date): string[] {
    if (this.deferredQueue.size === 0) return [];
    const cached = readCachedQuotes();
    const nowMs = now.getTime();
    const liveWindowMs =
      this.state.config.updateMinutes > 0
        ? this.state.config.updateMinutes * 60 * 1000
        : LIVE_PRICE_MAX_STALENESS_MS;
    const { stillMissing, clearedBySatisfied, exhausted } = this.deferredQueue.drain((symbol) => {
      const at = cached.get(symbol)?.quote?.at ?? null;
      if (at === null) return false;
      const age = nowMs - at;
      return age >= 0 && age <= liveWindowMs;
    });
    if (clearedBySatisfied.length > 0) {
      this.pollLog(
        "orchestrator",
        `Deferred queue: ${clearedBySatisfied.length} cleared by fresh cached/blob data within the live window (no re-fetch) ` +
          `[${clearedBySatisfied.join(", ")}].`,
      );
    }
    if (exhausted.length > 0) {
      this.pollLog(
        "orchestrator",
        `Deferred queue: ${exhausted.length} dropped after ${DEFERRED_MAX_ATTEMPTS} attempts ` +
          `[${exhausted.join(", ")}].`,
      );
    }
    if (stillMissing.length > 0) {
      this.pollLog(
        "orchestrator",
        `Deferred queue: ${stillMissing.length} still missing (stale cache), forcing a re-pull this round [${stillMissing.join(", ")}].`,
      );
    }
    return stillMissing;
  }

  /**
   * Whether the 1D/1W graph bars should be primed this round, and why — the
   * **dissolution of the old unconditional `primeStaleGraphPackages()` pre-step**
   * into the orchestrator's freshness decision (Pillar 1/4). The decision is no
   * longer re-implemented inline: it is delegated to the one pull orchestrator
   * ({@link planPull} in `data-orchestrator.ts`), so the bar gate is decided in
   * exactly one place. The clock-hour bar gate is the *sole* 1D-bar authority
   * during market hours, so this is what stops the prime self-perpetuating on
   * every refresh round:
   *
   * - **reset / force-all** — always due (the heaviest escape hatch re-pulls all).
   * - **market open** — due only when the orchestrator's clock-hour overlay says a
   *   bar is due: the first bar once ≥1 interval of session has elapsed, then at
   *   most once per `:00`. Between gates, breadcrumbs carry the line.
   * - **market closed** — due (the prime self-gates on staleness, so a loaded book
   *   pulls nothing; a stale close still backfills).
   */
  private graphPrimeDecision(
    kind: RefreshKind,
    opts: { force?: boolean; forceAll?: boolean },
    plan: PullPlan,
    now: Date,
  ): { due: boolean; market: "open" | "closed"; reason: string } {
    const market: "open" | "closed" = isUsMarketOpen(now) ? "open" : "closed";
    // The bar-prime "due" verdict is read from the **one** plan this round already
    // computed for its quote / NAV / FX legs (Pillar 1 — a single orchestrator
    // decision per round, so the bar gate and the leg gate can never disagree and
    // bars are never decided — or pulled — twice). During market hours the plan's
    // clock-hour overlay is the sole 1D-bar authority (it turns the bar leg on at a
    // new `:00` even when quotes are fresh, off otherwise). On reset / force-all the
    // plan is a full re-pull. A closed-market round always hands off to the prime,
    // which self-gates on bar-package staleness downstream (so a loaded book pulls
    // nothing; a stale settled close still backfills).
    const orchestrator = `orchestrator: ${describePlan(plan)}`;
    if (kind === "reset" || (opts.forceAll ?? false)) {
      return {
        due: true,
        market,
        reason: `${kind === "reset" ? "reset" : "force-all"} → full graph re-prime (${orchestrator})`,
      };
    }
    if (market === "closed") {
      return { due: true, market, reason: `market closed → prime self-gates on staleness (${orchestrator})` };
    }
    const due = plan.legs.dayBars || plan.legs.weekBars;
    if (!due) {
      const reason =
        this.lastBarPrimeMs === null
          ? `market open <1 bar-interval in (session +${Math.round(elapsedSessionMs(now) / 60000)}m) → no bar yet, breadcrumbs carry the line (${orchestrator})`
          : `market open, within the same clock hour as the last bar → held (breadcrumbs carry the line) (${orchestrator})`;
      return { due: false, market, reason };
    }
    return {
      due: true,
      market,
      reason:
        this.lastBarPrimeMs === null
          ? `market open, first bar of the session is due (${orchestrator})`
          : `market open, a new clock hour → bar due (${orchestrator})`,
    };
  }

  /**
   * Whole market days the **best-available** blob trails by — the Pillar-1
   * `blobDaysOld` freshness signal (assumption 8), read from the remote
   * `portfolio.meta.json` `published_at`, **not** the on-device blob's download
   * age. A blob published after the latest settled close is 0 days old. When the
   * sidecar carried no publish time (older desktop export / no sidecar) it falls
   * back to the on-device envelope's download age in settled sessions, then to a
   * large value (treated as "heavily behind") so a missing signal never *masks* a
   * genuine market-data gap.
   *
   * This is the **metadata prediction** only ("will a fresh blob save a token?").
   * Its suppressive power is honoured solely while the blob is still *pending* — a
   * live refresh round runs *after* the blob is decrypted and applied, so
   * {@link buildPullFreshness} layers the **Pillar-4 blob-trust re-engage overlay**
   * on top of this value (see there) and never lets a recent metadata timestamp
   * mask a gap the applied blob turned out not to cover.
   */
  private blobDaysOld(now: Date): number {
    if (this.blobPublishedAt) return settledSessionsSince(this.blobPublishedAt, now);
    if (this.envelopeAt !== null) return settledSessionsSince(new Date(this.envelopeAt).toISOString(), now);
    return 10;
  }

  /**
   * Build the **real** freshness ledger the single orchestrator keys on, so the
   * quote / NAV / FX round decision is genuinely routed through {@link planPull}
   * (Pillar 1) rather than decided ad-hoc in {@link refreshPrices}.
   *
   * Every age is deliberately the **most-stale** component (the *oldest* still
   * fetchable quote, the live FX spot, any wholly-missing symbol ⇒ `Infinity`), so
   * the orchestrator can only ever land on the "fresh — pull nothing" tier when
   * *every* fetchable symbol and FX are already within their rolling window. That
   * makes the orchestrator's leg gating in {@link refreshPrices} strictly no more
   * aggressive than the per-symbol cache TTLs the executors already enforce: it can
   * skip a leg only when the executor would itself have fetched nothing.
   *
   * **Pillar-4 blob-trust re-engage overlay.** The metadata `blobDaysOld` predicts
   * "a fresh blob will cover the gap, so don't spend a market token". That
   * prediction is only safe *before* the blob is decrypted. A refresh round runs
   * *after* decrypt (the dashboard is already built from the blob), so here we lift
   * `blobDaysOld` to at least the observed on-device gap (`deviceDaysMissing`): if
   * the applied blob actually covered the gap the device is fresh and this is a
   * no-op, but if it *lacked* the coverage its metadata can no longer mask the gap —
   * the heavily-outdated row re-engages and the skipped leg is pulled for real
   * (`docs/centralized_data_pull_plan.md`, "Blob-trust re-engage" overlay).
   */
  private buildPullFreshness(now: Date): PullFreshness {
    const data = this.state.data;
    const nowMs = now.getTime();
    const blobDaysOldMeta = this.blobDaysOld(now);
    if (!data) {
      return {
        dataAgeMs: 0,
        deviceDaysMissing: 0,
        blobDaysOld: blobDaysOldMeta,
        quoteAgeMs: 0,
        navHeldForToday: true,
      };
    }
    const plan = buildFetchPlan(data, FETCHABLE_NAV_CLASSES);
    const cached = readCachedQuotes();
    let oldestQuoteAt: number | null = null;
    let anyQuoteMissing = false;
    let anyMarketMissing = false;
    // C1 — currency-known gate. An empty quote cache is only *evidence* of a
    // missing market day when we actually know the holding's currency: a genuine
    // first-ever login (no saved plan, C2) has no currency yet, so an empty cache
    // there is the unknown-start state, not a 10-day gap. Inflating
    // `deviceDaysMissing` to 10 off that unknown cache is exactly the bug that
    // faked "heavily-outdated" and triggered the full re-pull, so a missing market
    // quote only counts when its native currency is known.
    for (const entry of plan) {
      const at = cached.get(entry.symbol)?.quote?.at ?? null;
      if (at === null) {
        anyQuoteMissing = true;
        if (entry.priceType === "market" && entry.nativeCurrency !== null) {
          anyMarketMissing = true;
        }
        continue;
      }
      if (oldestQuoteAt === null || at < oldestQuoteAt) oldestQuoteAt = at;
    }
    // FX age: tracked separately so the orchestrator's Overlay 3 can suppress the
    // FX leg individually (e.g. after the login warm-up just pulled a fresh spot)
    // without that freshness masking a stale quote leg in dataAgeMs.
    const fxCached = readCachedEurUsd();
    const fxAgeMs = fxCached && fxCached.now !== null ? nowMs - fxCached.at : Number.POSITIVE_INFINITY;
    const quoteAgeMs = anyQuoteMissing || oldestQuoteAt === null ? Number.POSITIVE_INFINITY : nowMs - oldestQuoteAt;
    const dataAgeMs = Math.max(quoteAgeMs, fxAgeMs);
    // Market-side device gap, biased *up* when uncertain so the heavily-outdated
    // tier (which simply restores today's full pass) can never under-pull.
    const marketOpen = isUsMarketOpen(now);
    const marketStale = this.staleFetchSymbols(marketOpen, now).some((s) => {
      const e = plan.find((p) => p.symbol === s);
      return e?.priceType === "market";
    });
    const deviceDaysMissing_ = deviceDaysMissing({ anyMarketMissing, marketStale, dataAgeMs });
    // Blob-trust re-engage overlay (post-decrypt): the metadata prediction can only
    // *raise* the floor, never mask the observed on-device gap. See the docstring.
    const blobDaysOld = Math.max(blobDaysOldMeta, deviceDaysMissing_);
    const navHeldForToday = !this.navStale(now);
    return { dataAgeMs, deviceDaysMissing: deviceDaysMissing_, blobDaysOld, quoteAgeMs, fxAgeMs, navHeldForToday };
  }

  /** Whether any NAV-priced fund is still behind its expected publish (closed-NAV row). */
  private navStale(now: Date): boolean {
    const data = this.state.data;
    if (!data) return false;
    const navPlan = buildFetchPlan(data, FETCHABLE_NAV_CLASSES).filter((e) => e.priceType !== "market");
    if (navPlan.length === 0) return false;
    const stale = new Set(this.staleFetchSymbols(false, now));
    return navPlan.some((e) => stale.has(e.symbol));
  }

  /**
   * The single orchestrator's verdict for a whole refresh round, keyed on the
   * **real** freshness ledger — the decision of record for the quote / NAV / FX
   * legs (Pillar 1). {@link refreshPrices} dispatches only the legs this names; the
   * existing fetchers re-clamp each against the per-symbol cache TTL, the
   * reservation authority and the 429 breaker, so this can only ever propose *less*
   * work than the executors would do, never more. A `reset` / `force-all` round
   * maps to the orchestrator's `reset` mechanism (every leg on); a `manual` tap
   * maps to `manual` (skips the rolling-TTL quote suppression — the user is asking
   * "is there anything new?"); every other round is `auto`.
   */
  private planRoundPull(
    kind: RefreshKind,
    opts: { force?: boolean; forceAll?: boolean },
    now: Date,
  ): PullPlan {
    const pullKind: PullKind =
      kind === "reset" || (opts.forceAll ?? false)
        ? "reset"
        : kind === "manual" || (opts.force ?? false)
          ? "manual"
          : kind === "start"
            ? "start"
            : "auto";
    const marketOpen = isUsMarketOpen(now);
    return planPull({
      kind: pullKind,
      nowMs: now.getTime(),
      market: marketOpen ? "open" : "closed",
      minutesSinceOpenMs: marketOpen ? elapsedSessionMs(now) : 0,
      autoIntervalMs: this.state.config.updateMinutes * 60 * 1000,
      freshness: this.buildPullFreshness(now),
      phase: "post-decrypt",
      currencyKnown: this.currencyKnownForPlan(),
      barGate: {
        lastBarPullMs: this.lastBarPrimeMs,
        sessionOpenMs: sessionOpenMs(lastSessionDate(now)),
      },
    });
  }

  /**
   * C1 — whether every market holding's native currency is known this pass. Only
   * `false` on a genuine first-ever login with no decrypted model yet (so an empty
   * quote cache is the unknown-start state, not a missing-days gap). Mirrors the
   * gate {@link buildPullFreshness} applies to `deviceDaysMissing`.
   */
  private currencyKnownForPlan(): boolean {
    const data = this.state.data;
    if (!data) return false;
    return buildFetchPlan(data, FETCHABLE_NAV_CLASSES).every(
      (e) => e.priceType !== "market" || e.nativeCurrency !== null,
    );
  }

  /**
   * C1 — the **pre-decrypt** twin of {@link currencyKnownForPlan}: whether every
   * market symbol in the *unencrypted* plan carries a native currency (C2). A
   * legacy plan (no currency) or a genuine first-ever login leaves this `false`,
   * so the warm-up's freshness ledger does not inflate an empty quote cache into a
   * faked "heavily-outdated" gap.
   */
  private currencyKnownForPrefetch(plan: PlannedSymbol[]): boolean {
    return plan.every((e) => e.priceType !== "market" || e.nativeCurrency !== null);
  }

  /**
   * C1 — the **pre-decrypt** freshness ledger, the twin of
   * {@link buildPullFreshness} built from the *unencrypted* symbol plan + caches
   * (no decrypted model). Feeding it to {@link planPull} is what makes the login
   * warm-up the orchestrator's **Pass 1** rather than a second brain: the same
   * `gradedPull` math + overlays now decide the warm-up's legs, so it can never
   * diverge from the post-decrypt kickoff. Every age is the most-stale component
   * (oldest still-cached quote, the live FX spot, any wholly-missing market symbol
   * ⇒ `Infinity`), and the C1 currency-known gate guards the `deviceDaysMissing`
   * inflation exactly as the post-decrypt builder does.
   */
  private buildPrefetchFreshness(
    plan: PlannedSymbol[],
    targets: { outdatedMarketSymbols: string[]; awaitingNavSymbols: string[] },
    now: Date,
  ): PullFreshness {
    const nowMs = now.getTime();
    const currencyKnown = this.currencyKnownForPrefetch(plan);
    const cached = readCachedQuotes();
    let oldestQuoteAt: number | null = null;
    let anyQuoteMissing = false;
    let anyMarketMissing = false;
    for (const entry of plan) {
      const at = cached.get(entry.symbol)?.quote?.at ?? null;
      if (at === null) {
        anyQuoteMissing = true;
        // C1 gate: a missing market quote is only evidence of a gap when we know
        // the symbol's currency (C2). A legacy / first-ever plan stays unknown.
        if (entry.priceType === "market" && currencyKnown && entry.nativeCurrency !== null) {
          anyMarketMissing = true;
        }
        continue;
      }
      if (oldestQuoteAt === null || at < oldestQuoteAt) oldestQuoteAt = at;
    }
    const fxCached = readCachedEurUsd();
    const fxAgeMs = fxCached && fxCached.now !== null ? nowMs - fxCached.at : Number.POSITIVE_INFINITY;
    const quoteAgeMs = anyQuoteMissing || oldestQuoteAt === null ? Number.POSITIVE_INFINITY : nowMs - oldestQuoteAt;
    const dataAgeMs = Math.max(quoteAgeMs, fxAgeMs);
    // A market symbol still missing its latest settled close ⇒ the device is at
    // least a day behind on the market sleeve (mirrors the post-decrypt builder's
    // `marketStale`). Currency-gated like the missing-quote case above.
    const marketStale = currencyKnown && targets.outdatedMarketSymbols.length > 0;
    const deviceDaysMissing_ = deviceDaysMissing({ anyMarketMissing, marketStale, dataAgeMs });
    const blobDaysOld = Math.max(this.blobDaysOld(now), deviceDaysMissing_);
    // NAV is "held for today" unless a fund is still awaiting its latest publish.
    const navHeldForToday = targets.awaitingNavSymbols.length === 0;
    return { dataAgeMs, deviceDaysMissing: deviceDaysMissing_, blobDaysOld, quoteAgeMs, fxAgeMs, navHeldForToday };
  }

  /**
   * C1 — the single orchestrator's verdict for the **login warm-up** (Pass 1),
   * the pre-decrypt twin of {@link planRoundPull}. It routes the warm-up's
   * fetch decision through {@link planPull} (`kind: "start"`, `phase:
   * "pre-decrypt"`) so the warm-up and the post-decrypt kickoff share **one** code
   * path: the same freshness tiers, the same clock-hour bar gate, the same rolling
   * quote-TTL and FX-interval overlays. The symbol-level routing (which provider,
   * which graph) still comes from {@link planPrefetch}; this plan is the leg gate
   * layered on top, so the warm-up only fires a leg the single brain approves.
   */
  private planWarmupPull(
    plan: PlannedSymbol[],
    targets: { outdatedMarketSymbols: string[]; awaitingNavSymbols: string[] },
    now: Date,
  ): PullPlan {
    const marketOpen = isUsMarketOpen(now);
    return planPull({
      kind: "start",
      nowMs: now.getTime(),
      market: marketOpen ? "open" : "closed",
      minutesSinceOpenMs: marketOpen ? elapsedSessionMs(now) : 0,
      autoIntervalMs: this.state.config.updateMinutes * 60 * 1000,
      freshness: this.buildPrefetchFreshness(plan, targets, now),
      phase: "pre-decrypt",
      currencyKnown: this.currencyKnownForPrefetch(plan),
      barGate: {
        lastBarPullMs: this.lastBarPrimeMs,
        sessionOpenMs: sessionOpenMs(lastSessionDate(now)),
      },
    });
  }

  /**
   * Smart Tiingo gate for **any** rapid-fire quote pull: before a fast Tiingo
   * round fetches plain quotes, pull any *stale* 1D/1W graph package instead —
   * each bar's newest point doubles as the quote, so priming the quote cache from
   * those bars lets the quote pull skip them. This stops Tiingo being spent twice
   * for one symbol (once for the rapid-fire quote, once for the 1D/1W graph),
   * whether the round is a hard reset or a routine "via backup" rapid-fire.
   *
   * Self-gating: only the genuinely missing (stale) bars are pulled, so a graph
   * already fully loaded — e.g. a closed-market book in hand — fetches nothing.
   * Returns the number of symbol-series actually stored this prime (0 when the
   * graphs were already loaded), so the caller can stamp the clock-hour gate only
   * when a market-hours prime genuinely pulled bars.
   *
   * It is also the shared after-hours home of the incomplete-1D-FX-close backfill
   * ({@link prefetchSessionFx}): wiring it here — not only in the login warm-up —
   * means every auto/manual/reset round repairs a session FX track that never
   * reached the 16:00 ET close, so a failed login warm-up can no longer strand the
   * freeze anchor / currency-effect split on a mid-session rate. The FX-only pull
   * runs only while the market is shut and only when no session bar pull this round
   * would already grab the FX track; it never affects the returned bar count.
   */
  private async primeStaleGraphPackages(now: Date = new Date()): Promise<number> {
    const { config } = this.state;
    if (!config.apiKey || resolvePriceProxyUrl(config) === null) return 0;
    const marketSymbols = readSymbolPlan()
      .filter((e) => e.priceType === "market")
      .map((e) => e.symbol);
    if (marketSymbols.length === 0) return 0;
    const stale = await this.prefetchGraphStaleness(marketSymbols, now);
    // After-hours FX close completion — mirror of the login warm-up (see
    // {@link prefetchOnStart}) so the FX-only backfill is wired into **every**
    // pulling mechanic, not just the start prefetch. If the login warm-up ever
    // fails before it reaches its FX step, the routine auto/manual/reset rounds all
    // flow through here while the market is shut, so they repair the incomplete 1D
    // EUR→USD close instead of leaving the freeze anchor + currency-effect split
    // reading a mid-session rate as "the close" until the next session. Same gate
    // as the start path: closed market, FX track short of the close, and no session
    // bar pull this round (a session backfill already grabs the FX track alongside).
    if (!isUsMarketOpen(now) && stale.fxIncomplete && stale.session.length === 0) {
      await this.prefetchSessionFx(config, now);
    }
    if (stale.session.length === 0 && stale.week.length === 0) return 0;
    const result = await this.prefetchGraphBars(stale.session, stale.week, config, now, this.primingCurrencyMap());
    return result.stored;
  }

  /**
   * only** (NAV funds are never plotted, so never fetched), and fold the result
   * back into the device store + quote cache:
   *
   *  - the bars are merged into the {@link TimeSeriesStore} under their day/window
   *    key, so the dashboard's later 1D/1W build finds them already present and
   *    does **not** re-spend the same Tiingo credit (no double-buy of the
   *    hourly-capped budget);
   *  - each symbol's newest bar is a current native mark, so {@link primeQuotesFromBars}
   *    hands it back to the holding rows — they skip a separate quote credit;
   *  - the session/window FX track is pulled in the same pass, so the one
   *    expensive spend grabs the most data it can.
   *
   * Every pull is metered against the Tiingo/Twelve Data budget logs (the shared
   * accounting that keeps the live-quote refresh from overrunning the free tier).
   * Returns the number of symbol-series actually stored.
   */
  private async prefetchGraphBars(
    sessionSymbols: string[],
    weekSymbols: string[],
    config: AppConfig,
    now: Date,
    currencyBySymbol: Map<string, string | null> = new Map(),
  ): Promise<{ stored: number; primed: string[] }> {
    if (sessionSymbols.length === 0 && weekSymbols.length === 0) return { stored: 0, primed: [] };
    const proxyUrl = resolvePriceProxyUrl(config);
    if (!proxyUrl) return { stored: 0, primed: [] }; // graph bars only come cheaply via the Tiingo /price pipe
    const store = this.ensureTimeSeriesStore();
    let stored = 0;
    // C3/C7: track the symbols whose quote cache this backfill genuinely primed,
    // so (a) the post-decrypt reconcile books the *true* filled set (not intent),
    // and (b) the log reports the real primed count, not a blind "primed those
    // quotes" that lies when `primeQuotesFromBars` skipped every bare native price.
    const primedSet = new Set<string>();

    const pull = async (
      symbols: string[],
      param: "intraday" | "daily",
      window: { startDate: string; endDate: string },
      fxResample: string,
      storeKey: string,
      label: string,
      extra: { interval?: string; outputsize?: number } = {},
      // The FX-history leg can span a wider window than the price bars (the 1D
      // FX track reaches back to the prior session's close so the FX KPI's
      // baseline survives an empty start), defaulting to the price window.
      fxWindow: { startDate: string; endDate: string } = window,
    ): Promise<void> => {
      if (symbols.length === 0) return;
      // Every metered request this backfill makes flows through the single
      // reservation authority (audit Rec 4): it atomically reserves each leg's
      // credits against the live shared budgets (Twelve Data per-minute/day + 429
      // freeze, Tiingo hourly/daily + freeze) before the call fires, so no path
      // can overshoot. The meters below are therefore *observation-only* — they
      // log/tally the spend and trip the 429 breaker, and a not-billed result
      // releases the reservation rather than touching the raw ledger twice.
      const reservation = ledgerReservation();
      const spent = { credits: 0 };
      const { tiingoMeter, twelveDataMeter } = instrumentedGraphRecorders({
        range: `${label} warm-up`,
        bookTwelveData: () => undefined,
        refundTwelveData: (n) => reservation.release("twelvedata", n, Date.now()),
        bookTiingo: () => undefined,
        refundTiingo: (n) => reservation.release("tiingo", n, Date.now()),
        log: (message) => this.pollLog("graph", message),
        spent,
        // Two-tier braking, tier 2 (WS4/WS5): a provider 429 is the authoritative
        // cross-device "out of credits" signal, so trip its circuit breaker here.
        onTwelveData429: () => recordTwelveData429(Date.now()),
        onTwelveDataSuccess: () => recordTwelveDataSuccess(),
        onTiingo429: () => recordTiingo429(Date.now()),
      });
      const fetchBars = makePriceBarFetcher({
        apiKey: config.apiKey,
        proxyUrl,
        param,
        startDate: window.startDate,
        endDate: window.endDate,
        tiingoMeter,
        twelveDataMeter,
        // One routing path (WS3) through the reservation authority: fill Twelve
        // Data up to whatever its shared per-minute/day budget has left (sliced to
        // the minute cap, WS2, so a 12-credit batch can never 429 a fresh 8-credit
        // minute), then route only the genuine overflow to Tiingo up to *its*
        // scarce budget — never Tiingo-first, and never over either cap. The
        // remainder is deferred to the next refresh round. A 429 freeze zeroes the
        // frozen provider's grant, so the split routes nothing to it until it lifts.
        reservation,
        // Two-tier braking, tier 1 (WS4): a per-symbol series backoff parks a
        // dead/empty series instead of re-pulling it every ~60s round, exactly as
        // the FX leg below already is.
        backoff: { memo: cacheSeriesBackoff(), scope: `bars:${param}`, now: () => Date.now() },
        ...extra,
      });
      if (!fetchBars) return;
      const bars = await fetchBars(symbols).catch(() => null);
      if (!bars) {
        this.pollLog("graph", `Login warm-up: ${label} bar backfill failed; graph left for on-demand build.`, "warn");
        return;
      }
      const incoming: Record<string, Bar[]> = {};
      for (const [symbol, list] of bars) if (list.length > 0) incoming[symbol] = list;
      // Bars double as quotes. When a caller hands in the decrypted holdings'
      // currency map (e.g. the post-unlock hard reset) each bar primes its
      // holding row's quote so the forced refresh's Tiingo quote fallback skips
      // it — that is the smart gate that stops Tiingo being spent on both the
      // rapid-fire quote *and* the 1D/1W graph for the same symbol. Pre-decrypt
      // (the empty-map default) primeQuotesFromBars reuses each symbol's existing
      // cached currency and skips any it cannot resolve.
      primeQuotesFromBars(bars, currencyBySymbol, Date.now()).forEach((s) => primedSet.add(s));
      // Grab the matching FX track in the same pass so the curve re-marks each
      // point at its own settled rate (finest granularity) for one more credit.
      const fetchFx = makeWindowFxFetcher(proxyUrl, fxWindow, fxResample, undefined, tiingoMeter, {
        apiKey: config.apiKey,
        twelveDataMeter,
        backoff: cacheSeriesBackoff(),
        backoffKey: `fx:${label}:${fxResample}`,
        reservation,
      });
      let fx: Bar[] | undefined;
      if (fetchFx) fx = await fetchFx().catch(() => undefined);
      await store.mergeSession(storeKey, { bars: incoming, fx }, now.getTime());
      const count = Object.keys(incoming).length;
      stored += count;
      // C7: report the *real* primed count for this leg, not a blind claim. The
      // primed total may be < stored when a bar was older than an existing quote
      // or its currency could not be resolved pre-decrypt.
      const primedHere = Object.keys(incoming).filter((s) => primedSet.has(s)).length;
      this.pollLog(
        "graph",
        `Login warm-up: ${label} backfill stored ${count} series (Tiingo ${param} bars) ` +
          `and primed ${primedHere} quote(s).`,
      );
    };

    await pull(
      sessionSymbols,
      "intraday",
      sessionFxWindow(now),
      "1hour",
      lastSessionDate(now),
      "1D",
      {},
      // Pull the FX track one session wider than the price bars so the stored 1D
      // EUR/USD track carries the prior session's settled close — the FX KPI's
      // "today" baseline, recovered from here when the live provider omits it.
      sessionFxHistoryWindow(now),
    );
    await pull(weekSymbols, "daily", weekFxWindow(now), "1day", WEEK_STORE_KEY, "1W", {
      interval: "1day",
      outputsize: 8,
    });
    return { stored, primed: [...primedSet] };
  }

  /**
   * C5 — **bars-first NAV** for the login warm-up. On a fresh device the 1W NAV
   * history is missing the latest settled session, so instead of spending a NAV
   * *quote* credit (whose value is then duplicated when the 1W curve later gap-
   * fills the very same day) this pulls the **1W daily-NAV bars** up front: the
   * last bar *is* the current settled NAV, it fills the whole week line in one
   * shot, and {@link primeQuotesFromBars} stamps it back as the headline NAV
   * (value-dated, settled — never "live"). The funds it primes are then dropped
   * from the quote leg, so the separate NAV quote is skipped.
   *
   * Only the genuine, NAV-fetchable moving funds are eligible (money-market /
   * pinned-$1 funds are not in `navSymbols`, stay flat, and are never fetched).
   * Routed through the same reservation authority + 429 breaker as every other
   * pull, and fully best-effort — a failure just leaves the NAV quote leg to run.
   * Returns the funds whose headline NAV this primed (to drop from the quote leg).
   */
  private async prefetchNavWeekBars(
    navSymbols: string[],
    config: AppConfig,
    now: Date,
    currencyBySymbol: Map<string, string | null>,
  ): Promise<string[]> {
    if (navSymbols.length === 0) return [];
    const proxyUrl = resolvePriceProxyUrl(config);
    if (!proxyUrl) return []; // NAV daily bars only come cheaply via the Tiingo /price pipe
    const store = this.ensureTimeSeriesStore();
    const weekStored = await store.loadSession(WEEK_STORE_KEY).catch(() => null);
    const stale = navBackfillStaleSymbols(weekStored, navSymbols, now);
    if (stale.length === 0) return []; // week already covers every settled NAV → pull nothing
    const reservation = ledgerReservation();
    const spent = { credits: 0 };
    const { tiingoMeter, twelveDataMeter } = instrumentedGraphRecorders({
      range: "1W NAV warm-up",
      bookTwelveData: () => undefined,
      refundTwelveData: (n) => reservation.release("twelvedata", n, Date.now()),
      bookTiingo: () => undefined,
      refundTiingo: (n) => reservation.release("tiingo", n, Date.now()),
      log: (message) => this.pollLog("graph", message),
      spent,
      onTwelveData429: () => recordTwelveData429(Date.now()),
      onTwelveDataSuccess: () => recordTwelveDataSuccess(),
      onTiingo429: () => recordTiingo429(Date.now()),
    });
    const window = weekFxWindow(now);
    const fetchBars = makePriceBarFetcher({
      apiKey: config.apiKey,
      proxyUrl,
      param: "daily",
      startDate: window.startDate,
      endDate: window.endDate,
      tiingoMeter,
      twelveDataMeter,
      reservation,
      backoff: { memo: cacheSeriesBackoff(), scope: "bars:nav", now: () => Date.now() },
      interval: "1day",
      outputsize: 8,
    });
    if (!fetchBars) return [];
    // Collapse to one settling NAV per UTC day (day-start stamped) so the warmed
    // history aligns with the bars the 1W curve accumulates for free from quotes.
    const navBars = await wrapDailyNavFetcher(fetchBars)(stale).catch(() => null);
    if (!navBars) {
      this.pollLog("graph", "Login warm-up: NAV bar backfill failed; funds left to the quote leg.", "warn");
      return [];
    }
    const incoming: Record<string, Bar[]> = {};
    for (const [symbol, list] of navBars) if (list.length > 0) incoming[symbol] = list;
    if (Object.keys(incoming).length === 0) return [];
    await store.mergeSession(WEEK_STORE_KEY, { bars: incoming }, now.getTime());
    // Prime each fund's headline NAV from its settled bar tip (value-dated, not
    // live) so the quote leg can skip it. The NAV set drives the value-date stamp.
    const primed = primeQuotesFromBars(
      navBars,
      currencyBySymbol,
      Date.now(),
      undefined,
      new Set(stale),
    );
    this.pollLog(
      "graph",
      `Login warm-up: NAV bars-first stored ${Object.keys(incoming).length} fund week(s) and ` +
        `primed ${primed.length} headline NAV(s) from the settled bar tip — quote leg skips them.`,
    );
    return primed;
  }

  /**
   * Backfill **only** the 1D EUR→USD bar track for the current session, used by
   * the after-hours pulls (the login warm-up's start prefetch **and** the routine
   * auto/manual/reset rounds via {@link primeStaleGraphPackages}) when the price
   * bars are already in hand (so the graph-bar backfill above never ran to grab
   * the FX alongside them) yet the stored FX track stopped short of the 16:00 ET
   * close — an *incomplete 1D FX bar*. Completing it means the freeze anchor
   * ({@link graphAnchorFx}) and the hero currency-effect split read the genuine
   * settle from the bars rather than a stale mid-session rate that would otherwise
   * persist until the next session.
   *
   * It pulls nothing but the FX, and only through the Tiingo `/price` FX-history
   * pipe (the same pipe the graph backfill uses for the FX track). The fetch is
   * routed through the single {@link ledgerReservation} authority and the 429
   * breaker exactly like every other pull, so it can never overshoot the shared
   * EUR/USD budget, and a per-series backoff parks a dead/empty FX leg. Returns
   * whether a fresh FX bar was stored.
   */
  private async prefetchSessionFx(config: AppConfig, now: Date): Promise<boolean> {
    const proxyUrl = resolvePriceProxyUrl(config);
    if (!proxyUrl) return false; // graph FX bars only come cheaply via the Tiingo /price pipe
    // Span the prior session too (one batched request either way) so this after-
    // hours completion also lands the prior session's settled close — the FX KPI's
    // "today" baseline recovered by {@link barsPrevSessionCloseFx}.
    const window = sessionFxHistoryWindow(now);
    // Same reservation + observation-only meters + breaker wiring as the graph
    // backfill's FX track, so this spend is governed identically.
    const reservation = ledgerReservation();
    const spent = { credits: 0 };
    const { tiingoMeter, twelveDataMeter } = instrumentedGraphRecorders({
      range: "1D FX close",
      bookTwelveData: () => undefined,
      refundTwelveData: (n) => reservation.release("twelvedata", n, Date.now()),
      bookTiingo: () => undefined,
      refundTiingo: (n) => reservation.release("tiingo", n, Date.now()),
      log: (message) => this.pollLog("graph", message),
      spent,
      onTwelveData429: () => recordTwelveData429(Date.now()),
      onTwelveDataSuccess: () => recordTwelveDataSuccess(),
      onTiingo429: () => recordTiingo429(Date.now()),
    });
    const fetchFx = makeWindowFxFetcher(proxyUrl, window, "1hour", undefined, tiingoMeter, {
      apiKey: config.apiKey,
      twelveDataMeter,
      backoff: cacheSeriesBackoff(),
      backoffKey: "fx:1D:1hour",
      reservation,
    });
    if (!fetchFx) return false;
    const fx = await fetchFx().catch(() => undefined);
    if (!fx || fx.length === 0) {
      this.pollLog("graph", "After-hours FX close backfill found no new EUR/USD bars.");
      return false;
    }
    await this.ensureTimeSeriesStore().mergeSession(lastSessionDate(now), { fx }, now.getTime());
    this.pollLog(
      "graph",
      `After-hours FX close backfill stored ${fx.length} EUR/USD bar(s) to complete the session close ` +
        `(price bars already in hand, FX track was short of the 16:00 ET settle).`,
    );
    return true;
  }

  /** Warm the chosen symbols on the Twelve Data primary; returns how many it fetched. */
  private async prefetchViaPrimary(
    symbols: string[],
    config: AppConfig,
    options: LoadQuotesOptions,
  ): Promise<number> {
    const quoteLoad = await loadQuotes(symbols, config.apiKey, options).catch(() => null);
    const report = quoteLoad?.report ?? null;
    if (!report) {
      this.pollLog("primary", "Login warm-up: quote fetch failed; caches left as-is.", "warn");
      return 0;
    }
    const list = (xs: string[]): string => (xs.length ? xs.join(", ") : "none");
    this.pollLog(
      "primary",
      `Login warm-up (Twelve Data): fetched ${report.fetched.length} [${list(report.fetched)}], ` +
        `served ${report.servedFresh.length} from cache, deferred ${report.deferred.length} [${list(report.deferred)}]. ` +
        `Budget left: ${report.minuteRemaining}/min, ${report.dayRemaining}/day.` +
        (report.error ? ` Non-fatal error: ${report.error.message}.` : ""),
    );
    return report.fetched.length;
  }

  /**
   * Rapid-fire a large closed-market catch-up through Tiingo: one batched request
   * with no per-minute cap. Quotes are served from cache first (empty key), then
   * the backup re-pulls every still-behind holding within its spare budget (the
   * startup reserve is honoured). Returns how many Tiingo actually filled.
   */
  private async prefetchViaTiingo(
    symbols: string[],
    navFetchSymbols: Set<string>,
    plan: PlannedSymbol[],
    config: AppConfig,
    options: LoadQuotesOptions,
  ): Promise<number> {
    const quoteLoad = await loadQuotes(symbols, "", options).catch(() => null);
    if (!quoteLoad) {
      this.pollLog("fallback", "Login warm-up: cache read for the Tiingo rapid-fire failed; caches left as-is.", "warn");
      return 0;
    }
    const sizes = new Map(plan.map((e) => [e.symbol, e.sizeEur] as const));
    const fallback = await runTiingoFallback({
      symbols,
      navSymbols: navFetchSymbols,
      quotes: quoteLoad.quotes,
      report: quoteLoad.report,
      proxyUrl: resolvePriceProxyUrl(config),
      now: Date.now(),
      manual: true,
      forceAll: true,
      reserveCredits: STARTUP_TIINGO_RESERVE,
      sizeForSymbol: (symbol) => sizes.get(symbol) ?? 0,
    });
    const b = fallback.budget;
    this.pollLog(
      "fallback",
      `Login warm-up (Tiingo rapid-fire): filled ${fallback.tiingoSymbols.length} ` +
        `[${fallback.tiingoSymbols.length ? fallback.tiingoSymbols.join(", ") : "none"}] of ${symbols.length} outdated. ` +
        `Budget: ${b.hourUsed}/${b.hourLimit} this hour, ${b.dayUsed}/${b.dayLimit} today.` +
        (fallback.error ? ` Error: ${fallback.error.message}.` : ""),
    );
    return fallback.tiingoSymbols.length;
  }

  /**
   * Record the prefetch outcome: stamp "last pulled" when it genuinely fetched
   * fresh data (so the welcome line and coverage read honestly), set the login
   * spin signal, and refresh the unlock-screen status text.
   */
  private finishPrefetch(outcome: {
    quoteFetched: number;
    quoteTotal: number;
    hasPlan: boolean;
    fxLive: boolean;
    graphFetched?: number;
  }): void {
    const graphFetched = outcome.graphFetched ?? 0;
    const gotNew = outcome.quoteFetched > 0 || outcome.fxLive || graphFetched > 0;
    this.prefetchFetchedSomething = gotNew;
    if (gotNew) {
      // The prefetch really did pull fresh data, so "last pulled" is now — keep it
      // honest and persisted, mirroring the live refresh's own stamp.
      this.lastDataPullAt = Date.now();
      writeLastPull(this.lastDataPullAt);
    }
    // Save what we now hold, so the *next* login's pre-flight can reason about the
    // delta before any decrypt (the "good saving when logging off" half).
    void this.saveSessionStatus();
    this.prefetchStatus = describePrefetch({
      inFlight: false,
      hasPlan: outcome.hasPlan,
      quoteFetched: outcome.quoteFetched,
      quoteTotal: outcome.quoteTotal,
      fxLive: outcome.fxLive,
      graphFetched,
      lastPullAt: this.lastDataPullAt,
    });
    this.updatePrefetchStatus();
  }

  /**
   * Persist a compact {@link SessionStatus} snapshot of what the book looks like
   * right now — coverage flags + market phase + on-device graph days — so the next
   * login's pre-flight can explain (and coarsely route) the delta before the blob
   * is decrypted. Cache-only and best-effort; holds no price, holding, or secret.
   */
  private async saveSessionStatus(now: Date = new Date()): Promise<void> {
    try {
      const plan = readSymbolPlan();
      const marketSymbols = plan.filter((e) => e.priceType === "market").map((e) => e.symbol);
      // Reflect what the device store actually holds for the 1W daily window: the
      // week graph is "covered" only when every market symbol already has bars (an
      // empty sleeve is trivially covered). Read best-effort; a missing/failed store
      // read just leaves the coarse "no market symbols" answer.
      let weekGraphCovered = marketSymbols.length === 0;
      if (this.timeSeriesStore !== null && marketSymbols.length > 0) {
        const weekStored = await this.timeSeriesStore.loadSession(WEEK_STORE_KEY).catch(() => null);
        weekGraphCovered = marketSymbols.every((s) => (weekStored?.bars[s]?.length ?? 0) > 0);
      }
      const status: SessionStatus = {
        at: now.getTime(),
        lastPullAt: this.lastDataPullAt,
        marketPhase: isUsMarketOpen(now) ? "open" : this.fullyUpToDate(now) ? "settled" : "closed",
        marketCovered: !this.marketDataOutdated(now),
        navCovered: !this.navOutstanding(now),
        sessionGraphDay: this.timeSeriesStore !== null ? lastSessionDate(now) : null,
        weekGraphCovered,
      };
      writeSessionStatus(status);
    } catch {
      // A snapshot is a pure optimisation for the next login; never let it throw.
    }
  }

  /** Live-update the unlock-screen prefetch status line, if it is on screen. */
  private updatePrefetchStatus(): void {
    if (typeof document === "undefined") return;
    const el = document.getElementById("prefetch-status");
    if (el && this.prefetchStatus !== null) el.textContent = this.prefetchStatus;
  }

  /**
   * Once the login prefetch settles, spin the Refresh glyph briefly *iff* it
   * actually fetched new data — the honest "the prefetch got you something newer"
   * signal. When the book was already as fresh as possible the glyph stays still.
   */
  private async maybeSignalPrefetchSpin(session: number): Promise<void> {
    if (this.prefetchPromise) await this.prefetchPromise.catch(() => undefined);
    if (session !== this.sessionId) return;
    if (this.prefetchFetchedSomething) this.signalFreshSpin();
  }

  /** A brief, standalone spin of the Refresh glyph (no pill) used as a signal. */
  private signalFreshSpin(): void {
    if (typeof document === "undefined") return;
    const glyph = document.querySelector('[data-action="refresh"] .icon-btn-glyph');
    if (!glyph) return;
    glyph.classList.add("is-spinning");
    setTimeout(() => glyph.classList.remove("is-spinning"), PREFETCH_SPIN_MS);
  }

  /** Demo mode is opt-in via a `?demo`/`?preview` query flag (see parseDemoParams). */
  private demoParams(): DemoParams {
    try {
      return parseDemoParams(window.location.search);
    } catch {
      return { requested: false, persona: getPersona(null).id, tab: null, tour: false, sim: false };
    }
  }

  private isConfigured(): boolean {
    const { config } = this.state;
    return config.apiKey.length > 0 && resolveBlobUrl(config) !== null;
  }

  private mount(node: HTMLElement): void {
    this.root.replaceChildren(node);
  }

  // --- Setup screen -----------------------------------------------------------

  private showSetup(error?: string, mode: "setup" | "settings" = "setup"): void {
    this.leaveDemoChrome();
    const settingsMode = mode === "settings";
    const { config } = this.state;
    const apiKey = h("input", {
      type: "password",
      id: "f-apikey",
      autocomplete: "off",
      placeholder: "Twelve Data API key",
      value: config.apiKey,
    });
    const blobUrl = h("input", {
      type: "url",
      id: "f-bloburl",
      autocomplete: "off",
      placeholder: "https://your-worker.workers.dev/portfolio.enc",
      value: config.blobUrl,
    });
    const priceProxyUrl = h("input", {
      type: "url",
      id: "f-priceproxy",
      autocomplete: "off",
      placeholder: "(optional) price-proxy URL override",
      value: config.priceProxyUrl,
    });
    const updateMinutes = h("input", {
      type: "number",
      id: "f-update",
      min: "1",
      max: String(MAX_UPDATE_MINUTES),
      step: "1",
      autocomplete: "off",
      placeholder: String(DEFAULT_UPDATE_MINUTES),
      value: String(config.updateMinutes),
    });
    const autoLock = h("input", {
      type: "number",
      id: "f-autolock",
      min: "0",
      max: String(MAX_AUTO_LOCK_MINUTES),
      step: "1",
      autocomplete: "off",
      placeholder: String(DEFAULT_AUTO_LOCK_MINUTES),
      value: String(config.autoLockMinutes),
    });
    const investmentAmount = h("input", {
      type: "number",
      id: "f-invest",
      min: "1",
      max: String(MAX_INVESTMENT_AMOUNT_EUR),
      step: "1",
      autocomplete: "off",
      placeholder: String(DEFAULT_INVESTMENT_AMOUNT_EUR),
      value: String(config.investmentAmountEur),
    });
    // Data-provider rate limits (Settings only). Each defaults to the provider's
    // documented free-tier value, *recommended* for a free account but not forced:
    // lower them to share one account across more devices, or raise them above the
    // free tier on a paid plan. No hard `max` — only a placeholder hint of the
    // recommended value (`parseProviderLimit` guards against absurd entries).
    const providerLimitInput = (id: string, value: number, recommended: number): HTMLInputElement =>
      h("input", {
        type: "number",
        id,
        min: "1",
        step: "1",
        autocomplete: "off",
        placeholder: String(recommended),
        value: String(value),
      }) as HTMLInputElement;
    const tdPerMinute = providerLimitInput("f-td-min", config.twelveDataPerMinute, DEFAULT_TWELVE_DATA_PER_MINUTE);
    const tdPerDay = providerLimitInput("f-td-day", config.twelveDataPerDay, DEFAULT_TWELVE_DATA_PER_DAY);
    const tiingoPerHour = providerLimitInput("f-ti-hour", config.tiingoPerHour, DEFAULT_TIINGO_PER_HOUR);
    const tiingoPerDay = providerLimitInput("f-ti-day", config.tiingoPerDay, DEFAULT_TIINGO_PER_DAY);
    const resumeOnRefresh = h("select", { id: "f-resume", class: "select" }, [
      h("option", { value: "0" }, ["Off — re-login on every page refresh"]),
      h("option", { value: "1" }, ["On — stay unlocked across a refresh (this tab)"]),
    ]) as HTMLSelectElement;
    resumeOnRefresh.value = config.resumeOnRefresh ? "1" : "0";
    resumeOnRefresh.setAttribute("aria-label", "Stay unlocked across a page refresh");

    // Hidden file picker backing the "Import config" button: pick a previously
    // exported packet, repopulate the (still editable) fields, and let the user
    // review or tweak before continuing. Available in both setup and Settings.
    const importInput = h("input", {
      type: "file",
      id: "f-import",
      accept: "application/json,.json",
      hidden: "hidden",
    }) as HTMLInputElement;
    const importBtn = h("button", { class: "btn ghost", type: "button" }, ["Import config file"]);
    importBtn.addEventListener("click", () => importInput.click());
    importInput.addEventListener("change", () => {
      const file = importInput.files?.[0];
      importInput.value = "";
      if (!file) return;
      file
        .text()
        .then((text) => {
          const imported = parseConfigPacket(text);
          // Re-render the same screen seeded with the imported values; fields
          // stay visible and editable so the user can adjust before saving.
          this.state.config = imported;
          this.showSetup(undefined, mode);
        })
        .catch((err: unknown) => {
          this.showSetup((err as Error).message || "Couldn't read that config file.", mode);
        });
    });

    const actions: Array<Node | string> = [
      h("button", { class: "btn", type: "submit" }, [settingsMode ? "Save & reload" : "Save & continue"]),
    ];
    if (settingsMode) {
      actions.push(h("button", { class: "btn ghost", type: "button", "data-action": "back" }, ["Back"]));
    } else {
      actions.push(
        h("button", { class: "btn ghost", type: "button", "data-action": "demo" }, [
          "Preview with sample data",
        ]),
      );
    }

    const intro = settingsMode
      ? "Update where the companion looks for your data and how it behaves. Changes stay on this device."
      : "These stay on this device. The API key powers live quotes; the data-source URL is where the app finds your encrypted portfolio.";

    const formChildren: Array<Node | string> = [
      h("h1", {}, [settingsMode ? "Settings" : "Set up the companion"]),
      h("p", { class: "muted" }, [intro]),
    ];

    // Discoverability: a prominent "try it now" call-to-action on first run, so a
    // visitor (or an interviewer) can explore the whole dashboard from synthetic
    // sample data before entering any key or URL — no signup, nothing to type.
    if (!settingsMode) {
      const tryBtn = h("button", { class: "btn cta", type: "button", "data-action": "demo" }, [
        "Try the live demo — no signup",
      ]);
      formChildren.push(
        h("div", { class: "demo-cta" }, [
          h("p", { class: "demo-cta-text" }, [
            "Curious what this looks like? Explore a fully-interactive sample portfolio — live-feeling prices, charts and risk metrics — with no account, no key and no real data.",
          ]),
          h("div", { class: "row" }, [tryBtn]),
        ]),
      );
    }

    // Import lives right at the top on first run so a returning user can restore
    // everything from a saved packet in one tap instead of retyping. In Settings
    // it sits with Export down in the "Backup" section instead.
    if (!settingsMode) {
      formChildren.push(
        importInput,
        h("div", { class: "row import-row" }, [importBtn]),
        h("p", { class: "field-hint" }, [
          "Have a saved config file from another device? Import it, then review the fields below.",
        ]),
      );
    }

    // Core data source: the two things that genuinely must be set, plus the
    // single refresh interval that replaced the old cache/auto-refresh pair.
    if (settingsMode) formChildren.push(h("h2", { class: "settings-section" }, ["Data source"]));
    formChildren.push(
      field("Price API key", apiKey, "Free key from twelvedata.com — never leaves this device."),
      field(
        "Data source URL",
        blobUrl,
        "The CORS-enabled URL that serves your encrypted portfolio — usually your Cloudflare Worker (…/portfolio.enc).",
      ),
      field(
        "Update prices every (minutes)",
        updateMinutes,
        `How often live prices refresh. Lower is fresher but spends more of the Twelve Data budget (${config.twelveDataPerMinute}/min, ${config.twelveDataPerDay}/day). Default is ${DEFAULT_UPDATE_MINUTES}.`,
      ),
    );

    // Advanced (Settings only): the Tiingo price-fallback proxy override. It is
    // derived from the data-source URL's origin by default, so this stays out of
    // the streamlined first-run setup and is offered only for the rare case where
    // the price proxy lives somewhere the derivation can't guess.
    if (settingsMode) {
      formChildren.push(
        field(
          "Price proxy URL override",
          priceProxyUrl,
          "Advanced: the web/proxy Worker /price route for the price fallback. Leave blank to derive it from the data-source URL. The provider token stays in the Worker — never in the browser.",
        ),
      );
    }

    // Data providers (Settings only): editable per-provider rate caps. They
    // default to each provider's free-tier value — recommended for a free
    // account — but are not forced: lower them to spread one account across
    // several devices, or raise them above the free tier on a paid plan.
    if (settingsMode) {
      formChildren.push(
        h("h2", { class: "settings-section" }, ["Data providers"]),
        h("p", { class: "field-hint" }, [
          "These cap how many API calls each price provider may spend. The defaults match each provider's free-tier limit — the recommended values for a free account. Lower them to share one account across more devices, or raise them above the free tier if you're on a paid plan.",
        ]),
        field(
          "Twelve Data — per minute",
          tdPerMinute,
          `Primary-provider credits allowed each minute. Recommended ${DEFAULT_TWELVE_DATA_PER_MINUTE} for the free tier; raise it on a paid plan.`,
        ),
        field(
          "Twelve Data — per day",
          tdPerDay,
          `Primary-provider credits allowed each day. Recommended ${DEFAULT_TWELVE_DATA_PER_DAY} for the free tier; raise it on a paid plan.`,
        ),
        field(
          "Tiingo — per hour",
          tiingoPerHour,
          `Backup-provider credits allowed each clock hour. Recommended ${DEFAULT_TIINGO_PER_HOUR} for the free tier (the web share); raise it on a paid plan.`,
        ),
        field(
          "Tiingo — per day",
          tiingoPerDay,
          `Backup-provider credits allowed each day. Recommended ${DEFAULT_TIINGO_PER_DAY} for the free tier (the web share); raise it on a paid plan.`,
        ),
      );
    }

    // Preferences: appearance + security. Shown on first-run setup too (not just
    // Settings) so the user can pick dark mode, clock format and auto-lock once,
    // before ever typing the passphrase — and never has to revisit them.
    formChildren.push(
      h("h2", { class: "settings-section" }, ["Appearance"]),
      field("Theme", renderThemeToggle(), "Switch between system, light and dark themes."),
      field("Clock format", renderTimeFormatToggle(), "Show times as 12-hour (AM/PM) or 24-hour. Auto follows your device locale."),
      field(
        "Regular investment amount (€)",
        investmentAmount,
        `The euros you wire over on a recurring basis to keep investing. In USD display the currency panel shows how many more or fewer dollars this buys as EUR/USD moves — your "bang for the buck". Default is €${DEFAULT_INVESTMENT_AMOUNT_EUR}.`,
      ),
      h("h2", { class: "settings-section" }, ["Security"]),
      field(
        "Auto-lock (minutes)",
        autoLock,
        `Lock the dashboard after this many minutes of inactivity. Set 0 to never auto-lock. Default is ${DEFAULT_AUTO_LOCK_MINUTES}. A dismissable warning appears ~15s before locking.`,
      ),
      field(
        "Stay unlocked across a page refresh",
        resumeOnRefresh,
        "When on, reloading the whole page (F5) in this tab resumes your session instead of asking for the passphrase again — like the refresh button. Closing the tab, or being idle past the auto-lock window, still locks. The passphrase is never stored in the clear, only ever this tab. Off by default.",
      ),
    );
    // Fingerprint unlock toggle — only meaningful while unlocked (we need the
    // in-memory passphrase to enrol) and on a device with a platform
    // authenticator, so it's revealed asynchronously below. Only reachable from
    // Settings, where a passphrase is already in memory.
    if (settingsMode && this.state.passphrase) {
      const fingerprintSlot = h("div", { class: "settings-slot", hidden: "hidden" });
      formChildren.push(fingerprintSlot);
      void this.addFingerprintSetting(fingerprintSlot);
    }

    // Backup: export the current config to a portable file (Settings only — on
    // first run there's nothing saved yet to export). Import is offered here too
    // for symmetry with the top-of-setup importer.
    if (settingsMode) {
      const exportBtn = h("button", { class: "btn ghost", type: "button" }, ["Export config file"]);
      exportBtn.addEventListener("click", () => this.exportConfig());
      formChildren.push(
        h("h2", { class: "settings-section" }, ["Backup"]),
        importInput,
        field(
          "Portable config",
          h("div", { class: "row import-row" }, [exportBtn, importBtn]),
          "Export saves your API key, data-source URL, update interval, and auto-lock setting to a JSON file you can import on another device. Keep the file private — it contains your API key.",
        ),
      );
    }
    // Graphs: the live 1D/1W curves are always on now; this opt-in only adds the
    // longer 3M / 6M history ranges back for anyone who wants them (Settings only).
    if (settingsMode) {
      formChildren.push(
        h("h2", { class: "settings-section" }, ["Graphs"]),
        field(
          "Extra ranges",
          renderExtendedGraphsToggle(),
          "Add the longer 3M and 6M history ranges to the value chart. Off by default for a cleaner look; the live 1D and 1W curves are always shown. Takes effect when you return to the dashboard.",
        ),
      );
    }
    // Maintenance: two manual escape hatches for when prices look stuck. Both
    // only make sense once unlocked with data loaded — the dashboard they refresh
    // has to exist.
    if (settingsMode && this.state.data) {
      // (1) Force-fetch every price now: ignore the NAV close-await skips and the
      // market-closed skips and re-pull *all* symbols as if each were expecting a
      // brand-new price. Keeps the caches intact.
      const forceAll = h(
        "button",
        { class: "btn ghost", type: "button", "data-action": "force-all" },
        ["Force-fetch every price now"],
      );
      forceAll.addEventListener("click", () => this.forceFetchAllNow());
      // (2) Reset everything: clear every cached price, re-check the data file,
      // then re-pull from scratch.
      const updateAll = h(
        "button",
        { class: "btn ghost", type: "button", "data-action": "update-all" },
        ["Reset cache & re-pull everything"],
      );
      updateAll.addEventListener("click", () => this.updateAllFromScratch());
      // (3) Try the backup data provider: route the whole book through Tiingo for
      // one pull, skipping the primary and re-pricing every non-recent holding.
      const viaBackup = h(
        "button",
        { class: "btn ghost", type: "button", "data-action": "via-backup" },
        ["Try the backup data provider now"],
      );
      viaBackup.addEventListener("click", () => this.refreshViaBackupProvider());
      // (4) Download the data-polling log: a detailed, timestamped trail of what
      // every refresh did (cache hits, live fetches, fallback usage, budgets,
      // blob checks) for transparency and debugging. Paired with a clear button.
      const downloadLog = h(
        "button",
        { class: "btn ghost", type: "button", "data-action": "download-log" },
        ["Download data polling log"],
      );
      downloadLog.addEventListener("click", () => this.downloadPollLog());
      const clearLog = h(
        "button",
        { class: "btn ghost", type: "button", "data-action": "clear-log" },
        ["Clear log"],
      );
      clearLog.addEventListener("click", () => this.clearPollLogNow());
      formChildren.push(
        h("h2", { class: "settings-section" }, ["Maintenance"]),
        field(
          "Force-fetch every price",
          forceAll,
          "Re-pull every quote now, ignoring NAV close-await skips and market-closed skips — as if all prices were expected to update. Keeps your caches. Respects your daily free-tier budget.",
        ),
        field(
          "Reset & re-pull everything",
          updateAll,
          "Clear every cached price, re-check the data file, and re-fetch all quotes and FX from scratch. Use this if a price ever looks stuck. Respects your daily free-tier budget.",
        ),
        field(
          "Try the backup data provider",
          viaBackup,
          "Route the whole book through the secondary provider for one pull, skipping the primary — but only for holdings whose value isn't already recent. Use it for a second opinion when the primary looks wrong or stuck. Respects the backup provider's own budget.",
        ),
        field(
          "Data polling log",
          h("div", { class: "row import-row" }, [downloadLog, clearLog]),
          "Download a detailed, timestamped trail of exactly what each refresh did: which holdings were served from cache, fetched live, or filled from the backup provider (and why), the free-tier budgets at each step, and the data-file checks. Useful for debugging when prices look wrong or stuck. The log stays on this device.",
        ),
      );
    }
    formChildren.push(
      error ? h("p", { class: "note err" }, [error]) : document.createTextNode(""),
      h("div", { class: "row" }, actions),
    );

    const form = h("form", { class: "panel", novalidate: "novalidate" }, formChildren);

    form.querySelectorAll('[data-action="demo"]').forEach((el) =>
      el.addEventListener("click", () => this.enterDemo(this.demoParams())),
    );
    form.querySelector('[data-action="back"]')?.addEventListener("click", () => this.exitSettings());

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const next: AppConfig = {
        apiKey: (apiKey as HTMLInputElement).value.trim(),
        blobUrl: (blobUrl as HTMLInputElement).value.trim(),
        priceProxyUrl: (priceProxyUrl as HTMLInputElement).value.trim(),
        updateMinutes: parseUpdateMinutes((updateMinutes as HTMLInputElement).value),
        autoLockMinutes: parseAutoLockMinutes((autoLock as HTMLInputElement).value),
        twelveDataPerMinute: parseProviderLimit(tdPerMinute.value, DEFAULT_TWELVE_DATA_PER_MINUTE),
        twelveDataPerDay: parseProviderLimit(tdPerDay.value, DEFAULT_TWELVE_DATA_PER_DAY),
        tiingoPerHour: parseProviderLimit(tiingoPerHour.value, DEFAULT_TIINGO_PER_HOUR),
        tiingoPerDay: parseProviderLimit(tiingoPerDay.value, DEFAULT_TIINGO_PER_DAY),
        resumeOnRefresh: resumeOnRefresh.value === "1",
        investmentAmountEur: parseInvestmentAmount((investmentAmount as HTMLInputElement).value),
      };
      if (!next.apiKey) return this.showSetup("Enter your price API key.", mode);
      if (!next.blobUrl) return this.showSetup("Enter your data-source URL.", mode);
      this.state.config = next;
      // A settings change can alter the resume identity (the data source) or turn
      // resume off — drop any existing token so it can't apply to the new state;
      // a still-enabled session re-mints a fresh, correctly-bound token via
      // afterUnlock below.
      clearResumeToken();
      // Persist (the API key is encrypted at rest) before advancing. In Settings
      // (already unlocked) re-run the load pipeline with the new config; otherwise
      // continue the first-run flow to the unlock screen.
      void saveConfig(next).then(() => {
        if (settingsMode && this.state.data) void this.afterUnlock(false);
        else this.showUnlock();
      });
      return undefined;
    });

    this.mount(h("div", { class: "screen" }, [form]));
  }

  /** Open the editable settings while logged in (reachable from the topbar). */
  private showSettings(): void {
    this.showSetup(undefined, "settings");
  }

  /**
   * Export the current config to a portable JSON packet the user can save and
   * re-import on another device. Plaintext by design (Plan A): it's a private
   * file, no more exposed than the device's own localStorage. Reads live values
   * from the in-memory config, which Settings keeps in sync on save.
   */
  private exportConfig(): void {
    try {
      const json = serializeConfig(this.state.config);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = h("a", { href: url, download: "investment-overview-config.json" }) as HTMLAnchorElement;
      document.body.append(a);
      a.click();
      a.remove();
      // Revoke on the next tick so the download has a chance to start.
      setTimeout(() => URL.revokeObjectURL(url), 0);
      this.toast("Config exported — keep the file private; it holds your API key.");
    } catch {
      this.toast("Couldn't export the config on this device.");
    }
  }

  /** Leave Settings without saving: back to the dashboard, or the unlock screen. */
  private exitSettings(): void {
    if (this.state.data && this.model) this.renderDashboard(this.model);
    else this.showUnlock();
  }

  // --- Unlock screen ----------------------------------------------------------

  private showUnlock(error?: string, options: { autoPrompt?: boolean } = {}): void {
    this.leaveDemoChrome();
    // Back at the lock screen, a resume attempt (if any) is over — clear the flag
    // so a later manual unlock doesn't mislabel itself as a refresh-resume.
    this.resumedFromRefresh = false;
    const enrolled = hasBiometricEnrolment();

    const pass = h("input", {
      type: "password",
      id: "f-pass",
      autocomplete: "off",
      placeholder: "Mobile passphrase",
    }) as HTMLInputElement;

    // Optional "remember with fingerprint" enrolment — only offered on the
    // passphrase-first screen (device not yet enrolled) and only when a platform
    // authenticator is present (revealed async by revealEnrolToggle).
    const enrol = h("input", { type: "checkbox", id: "f-bio", class: "switch-input", role: "switch" }) as HTMLInputElement;
    const enrolField = switchField("Enable fingerprint unlock on this device", enrol);
    enrolField.hidden = true;

    const actions = h("div", { class: "row" }, [
      h("button", { class: "btn", type: "submit" }, ["Unlock"]),
      h("button", { class: "btn ghost", type: "button", "data-action": "settings" }, ["Settings"]),
    ]);

    // The passphrase fields. On an enrolled device this is the secondary fallback
    // path, hidden until the user explicitly opts into it.
    const passBlock = h("div", { class: "unlock-pass" }, [field("Passphrase", pass), enrolField, actions]);

    const formChildren: Array<Node | string> = [
      h("h1", {}, [enrolled ? "Welcome back" : "Unlock"]),
      h("p", { class: "muted" }, [
        enrolled
          ? "Touch the sensor to unlock — your data is decrypted on this device only."
          : "Your passphrase decrypts the data in this browser. It is never stored or sent.",
      ]),
    ];

    // The live-data prefetch status: show that the app is already warming live
    // prices (and what it found / when it last pulled) while the user unlocks.
    // Rendered only for the fresh page-load warm-up — never the stale status left
    // over from before a lock (which has cleared the flag).
    if (this.prefetchStatus !== null && this.prefetchShownOnLogin) {
      formChildren.push(
        h(
          "p",
          { id: "prefetch-status", class: "note prefetch-status", role: "status", "aria-live": "polite" },
          [this.prefetchStatus],
        ),
      );
    }

    if (enrolled) {
      // Biometric-first layout: one prominent fingerprint CTA, with the
      // passphrase tucked behind a quiet "Use passphrase instead" link.
      const bioBtn = h("button", { class: "btn bio bio-primary", type: "button" }, [
        fingerprintIcon(),
        h("span", {}, ["Unlock with fingerprint"]),
      ]);
      bioBtn.addEventListener("click", () => void this.unlockBiometric());

      const usePass = h("button", { class: "linkish", type: "button" }, ["Use passphrase instead"]);
      passBlock.hidden = true;
      usePass.addEventListener("click", () => {
        passBlock.hidden = false;
        usePass.hidden = true;
        pass.focus();
      });

      formChildren.push(bioBtn);
      if (error) formChildren.push(h("p", { class: "note err" }, [error]));
      formChildren.push(usePass, passBlock);
    } else {
      if (error) formChildren.push(h("p", { class: "note err" }, [error]));
      formChildren.push(passBlock);
    }

    // Always-visible entry into the synthetic sample dashboard, so the demo is
    // reachable straight from the normal app link even on a configured (locked)
    // device — not only from the first-run setup screen or a `?demo` deep link.
    // Once inside, every part of the demo (personas, tabs, tour, live-sim) is
    // driven by on-screen controls rather than URL parameters.
    const demoLink = h("button", { class: "linkish", type: "button", "data-action": "demo" }, [
      "Preview with sample data",
    ]);
    formChildren.push(h("p", { class: "unlock-demo" }, [demoLink]));

    const form = h("form", { class: "panel unlock", novalidate: "novalidate" }, formChildren);
    form.querySelector('[data-action="settings"]')?.addEventListener("click", () => this.showSetup());
    form.querySelector('[data-action="demo"]')?.addEventListener("click", () => this.enterDemo(this.demoParams()));
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const passphrase = pass.value;
      if (!passphrase) return this.showUnlock("Enter your passphrase.");
      void this.unlock(passphrase, enrol.checked);
      return undefined;
    });

    this.mount(h("div", { class: "screen" }, [form]));

    if (enrolled) {
      (form.querySelector(".bio-primary") as HTMLElement | null)?.focus();
      // Auto-prompt the platform sheet on the first unlock so a returning user
      // gets straight in with a single touch and no extra tap.
      if (options.autoPrompt) void this.unlockBiometric(true);
    } else {
      pass.focus();
      void this.revealEnrolToggle(enrolField);
    }
  }

  /** Reveal the enrolment toggle once we confirm the device has an authenticator. */
  private async revealEnrolToggle(enrolField: HTMLElement): Promise<void> {
    if (await isBiometricSupported()) enrolField.hidden = false;
  }

  /**
   * Attempt a fingerprint unlock, then run the normal decrypt pipeline. An
   * auto-prompt (page load) that the user dismisses — or that the browser blocks
   * for want of a user gesture — must not shout an error; it quietly falls back
   * to the manual button. An explicit tap does surface the reason.
   */
  private async unlockBiometric(auto = false): Promise<void> {
    // An explicit fingerprint tap is the "interact again" signal after a lock:
    // start warming the caches right away, in parallel with the platform sheet.
    // No-op on the fresh page-load auto-prompt (prefetch already running).
    if (!auto) this.startPrefetch({ shownOnLogin: false });
    try {
      const passphrase = await unlockWithBiometric();
      await this.unlock(passphrase, false);
    } catch (err) {
      if (auto) this.showUnlock();
      else this.showUnlock((err as Error).message);
    }
  }

  /**
   * Settings: a fingerprint unlock toggle. Shown only on a capable device (or
   * one already enrolled). Turning it on enrols using the in-memory passphrase;
   * turning it off forgets the enrolment. Wired into a slot that stays hidden on
   * devices that can't offer it.
   */
  private async addFingerprintSetting(slot: HTMLElement): Promise<void> {
    const enrolled = hasBiometricEnrolment();
    if (!enrolled && !(await isBiometricSupported())) return;
    const input = h("input", { type: "checkbox", class: "switch-input", role: "switch" }) as HTMLInputElement;
    input.checked = enrolled;
    const fieldEl = switchField(
      "Fingerprint unlock",
      input,
      "Use this device's fingerprint sensor to unlock instead of typing your passphrase.",
    );
    input.addEventListener("change", () => void this.toggleFingerprint(input));
    slot.replaceChildren(fieldEl);
    slot.hidden = false;
  }

  /** Enrol/forget biometric unlock when the Settings toggle flips. */
  private async toggleFingerprint(input: HTMLInputElement): Promise<void> {
    if (input.checked) {
      const passphrase = this.state.passphrase;
      if (!passphrase) {
        input.checked = false;
        return;
      }
      try {
        await enrolBiometric(passphrase);
        this.toast("Fingerprint unlock enabled on this device.");
      } catch (err) {
        input.checked = false;
        this.toast((err as Error).message);
      }
    } else {
      clearBiometricEnrolment();
      this.toast("Fingerprint unlock disabled on this device.");
    }
  }

  private showStatus(message: string): void {
    this.mount(h("div", { class: "screen" }, [h("div", { class: "panel status" }, [h("p", {}, [message])])]));
  }

  // --- Demo / preview ---------------------------------------------------------

  /** Cadence of the offline live-tick simulator while "Live" is selected. */
  private static readonly DEMO_SIM_INTERVAL_MS = 2500;

  /** True when the viewer asked the OS to minimise motion. */
  private prefersReducedMotion(): boolean {
    try {
      return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    } catch {
      return false;
    }
  }

  /**
   * Enter demo mode from a parsed deep link (or the setup CTA). Sets up the
   * persona/tick/sim state, renders the sample dashboard, and — when requested
   * and motion is allowed — starts the live-sim and/or the guided tour.
   */
  private enterDemo(params: DemoParams): void {
    this.demo = { persona: params.persona, tick: 0, sim: false, initialTab: params.tab };
    this.renderDemo();
    if (params.sim && !this.prefersReducedMotion()) this.setSim(true);
    if (params.tour) this.startDemoTour();
  }

  /**
   * Render the dashboard from baked-in sample data — no key, passphrase, or
   * network. A banner explains it is synthetic and carries the persona switcher,
   * the frozen/live-sim toggle and the guided-tour button. "Exit demo" (the
   * topbar lock action) returns to the real app.
   */
  private renderDemo(): void {
    if (!this.demo) return;
    const model = buildDemoModel({ persona: this.demo.persona, tick: this.demo.tick });
    // Seed the EUR→USD rate from the sample export so the currency toggle works.
    setEurUsdRate(model.overview.fxRateEurUsd);
    setInvestmentAmountEur(this.state.config.investmentAmountEur);
    this.model = model;

    const banner = this.renderDemoBanner();
    // The deep-linked tab only applies on the first paint, so subsequent
    // re-renders (live ticks, currency toggle) respect the viewer's navigation.
    const initialTabId = this.demo.initialTab ?? undefined;
    this.demo.initialTab = null;

    const dashboard = renderDashboard(
      model,
      () => this.tickDemo(), // Refresh = advance one live tick (offline).
      () => this.exitDemo(), // Lock button reads "Exit demo" here.
      () => this.renderDemo(), // Currency toggle re-renders without ticking.
      () => this.showDemoSettings(),
      "Exit demo",
      undefined,
      { initialTabId },
    );
    this.mount(h("div", { class: "demo-shell" }, [banner, dashboard]));
  }

  /** The demo banner: synthetic-data note, persona "story", and the controls. */
  private renderDemoBanner(): HTMLElement {
    const persona = getPersona(this.demo?.persona);

    const note = h("div", { class: "demo-note" }, [
      h("strong", {}, ["Demo mode"]),
      " — sample data, no real portfolio. ",
      h("span", { class: "demo-tagline" }, [persona.tagline]),
    ]);

    // Persona switcher.
    const select = h("select", { class: "demo-select", "aria-label": "Sample portfolio" }) as HTMLSelectElement;
    for (const p of DEMO_PERSONAS) {
      const option = h("option", { value: p.id }, [p.label]) as HTMLOptionElement;
      if (p.id === this.demo?.persona) option.selected = true;
      select.appendChild(option);
    }
    select.addEventListener("change", () => this.switchPersona(select.value));

    // Frozen ↔ live-sim toggle.
    const live = this.demo?.sim === true;
    const simBtn = h(
      "button",
      { class: `demo-btn${live ? " live" : ""}`, type: "button", "aria-pressed": live ? "true" : "false" },
      [live ? "● Live" : "Frozen"],
    );
    simBtn.title = live
      ? "Prices are moving (simulated, offline). Click to freeze for screenshots."
      : "Prices are frozen for stable screenshots. Click for a simulated live feed.";
    simBtn.addEventListener("click", () => this.setSim(!live));

    // Guided tour.
    const tourBtn = h("button", { class: "demo-btn", type: "button" }, ["Take the tour"]);
    tourBtn.addEventListener("click", () => this.startDemoTour());

    const toolbar = h("div", { class: "demo-toolbar" }, [select, simBtn, tourBtn]);
    return h("div", { class: "demo-banner" }, [note, toolbar]);
  }

  /** Switch the active sample portfolio, resetting to its frozen snapshot. */
  private switchPersona(id: string): void {
    if (!this.demo) return;
    this.demo.persona = getPersona(id).id;
    this.demo.tick = 0;
    this.renderDemo();
  }

  /** Advance the offline live-tick simulator by one step and repaint. */
  private tickDemo(): void {
    if (!this.demo) return;
    this.demo.tick += 1;
    this.renderDemo();
  }

  /** Turn the live-sim on or off (explicit user action overrides reduced-motion). */
  private setSim(on: boolean): void {
    if (!this.demo) return;
    this.demo.sim = on;
    if (on) this.startDemoTimer();
    else this.clearDemoTimer();
    this.renderDemo();
  }

  private startDemoTimer(): void {
    if (this.demoTimer !== null) return;
    this.demoTimer = setInterval(() => {
      // Pause while the tab is hidden so a backgrounded demo doesn't churn.
      if (typeof document !== "undefined" && document.hidden) return;
      this.tickDemo();
    }, App.DEMO_SIM_INTERVAL_MS);
  }

  private clearDemoTimer(): void {
    if (this.demoTimer !== null) {
      clearInterval(this.demoTimer);
      this.demoTimer = null;
    }
  }

  /** Launch the guided spotlight tour, pausing the live-sim while it runs. */
  private startDemoTour(): void {
    this.endTour();
    const resumeSim = this.demo?.sim === true;
    this.clearDemoTimer();
    this.stopTour = startTour(DEMO_TOUR_STEPS, {
      onClose: () => {
        this.stopTour = null;
        if (resumeSim && this.demo?.sim) this.startDemoTimer();
      },
    });
  }

  private endTour(): void {
    const stop = this.stopTour;
    this.stopTour = null;
    stop?.();
  }

  /** Tear down all demo chrome (timer + tour). Safe to call off the demo path. */
  private leaveDemoChrome(): void {
    this.clearDemoTimer();
    this.endTour();
    this.demo = null;
  }

  /**
   * A deliberately trimmed Settings sheet for demo mode: appearance only, plus a
   * reminder that the data is synthetic. It never renders the API-key,
   * data-source or maintenance fields, so screen-sharing the demo can't leak a
   * real key/URL and the viewer can't accidentally leave the preview.
   */
  private showDemoSettings(): void {
    this.clearDemoTimer(); // Pause the sim while the sheet is open.
    const back = h("button", { class: "btn", type: "button" }, ["Back to demo"]);
    back.addEventListener("click", () => {
      this.renderDemo();
      if (this.demo?.sim) this.startDemoTimer();
    });
    const exit = h("button", { class: "btn ghost", type: "button" }, ["Exit demo"]);
    exit.addEventListener("click", () => this.exitDemo());

    const form = h("form", { class: "panel", novalidate: "novalidate" }, [
      h("h1", {}, ["Demo settings"]),
      h("p", { class: "muted" }, [
        "This is a read-only preview of synthetic sample data. The live app's data-source and security settings are hidden here — there is nothing to configure and no real data involved.",
      ]),
      h("h2", { class: "settings-section" }, ["Appearance"]),
      field("Theme", renderThemeToggle(), "Switch between system, light and dark themes."),
      field("Clock format", renderTimeFormatToggle(), "Show times as 12-hour (AM/PM) or 24-hour. Auto follows your device locale."),
      field(
        "Currency",
        h("p", { class: "field-static muted" }, ["Use the € / $ toggle in the topbar to flip the whole dashboard between EUR and USD."]),
        "EUR and USD are equal, first-class display currencies.",
      ),
      h("div", { class: "row" }, [back, exit]),
    ]);
    this.mount(h("div", { class: "screen" }, [form]));
  }

  /**
   * Leave the preview for the real app, regardless of a `?demo` URL flag. Tears
   * down the demo chrome first so no timer or tour outlives it.
   */
  private exitDemo(): void {
    this.leaveDemoChrome();
    void (async () => {
      this.state.config = await loadConfig();
      applyProviderLimits(this.state.config);
      if (this.isConfigured()) this.showUnlock();
      else this.showSetup();
    })().catch(() => this.showSetup());
  }

  // --- Load pipeline ----------------------------------------------------------

  /**
   * Unlock the dashboard. To make a quick re-open feel instant, we decrypt the
   * encrypted blob we already cached *first* and render from cached prices, then
   * re-download the blob and refresh prices in the background. Only when there is
   * no usable cached blob do we block on a fresh download.
   */
  private async unlock(passphrase: string, enrolRequested = false): Promise<void> {
    // Re-warm the live caches the moment the user interacts to unlock after a
    // lock. No-op on the fresh page load (the prefetch is already running) and
    // silent — its status never shows on the login (see {@link startPrefetch}).
    this.startPrefetch({ shownOnLogin: false });
    const cached = readCachedEnvelope();
    if (cached) {
      try {
        const data = await decryptEnvelopeToJson<MobileExport>(cached.envelope, passphrase);
        this.state.passphrase = passphrase;
        this.state.data = data;
        this.envelope = cached.envelope;
        this.envelopeAt = cached.at;
        this.metaVersion = cached.metaVersion;
        await this.afterUnlock(enrolRequested);
        return;
      } catch {
        // The cached blob didn't decrypt — usually it was re-encrypted with a
        // new passphrase. Fall through to a fresh download and try again there.
      }
    }
    this.showStatus("Downloading encrypted data…");
    const url = resolveBlobUrl(this.state.config);
    if (!url) return this.showSetup("No data source configured.");
    try {
      const result = await fetchEnvelopeConditional(url, null);
      // A first download has no cached validators, so the server can only answer
      // 200; treat the (impossible here) 304 defensively by falling back.
      if (result.status === "not-modified") return this.showUnlock("No data available.");
      const envelope = result.envelope;
      this.showStatus("Decrypting…");
      const data = await decryptEnvelopeToJson<MobileExport>(envelope, passphrase);
      this.state.passphrase = passphrase;
      this.state.data = data;
      this.envelope = envelope;
      this.metaVersion = null;
      this.persistEnvelope(envelope, { etag: result.etag, lastModified: result.lastModified });
      await this.afterUnlock(enrolRequested);
    } catch (err) {
      this.showUnlock((err as Error).message);
    }
    return undefined;
  }

  /**
   * Post-unlock: paint the dashboard from cached prices immediately, then kick
   * off the background passes (optional biometric enrolment, blob re-download,
   * and the live-price auto-refresh) that don't need to block the first paint.
   */
  private async afterUnlock(enrolRequested: boolean): Promise<void> {
    this.sessionId += 1;
    const session = this.sessionId;

    // 1. Instant first paint from cached quotes — no network on the hot path.
    await this.refreshPrices(session, false);

    // Make the successful unlock unmistakably visible: a top-of-page banner that
    // confirms the login was detected and that a price refresh is about to run.
    // It sits clear of the bottom refreshing pill / coverage toast so both show
    // at once — the user sees "welcome back" *and* the live update underneath.
    // After a page-reload resume, say so explicitly so the restore is never
    // silent or confusing — the Lock control stays available in the topbar.
    if (this.resumedFromRefresh) {
      this.welcomeBanner("Resumed after refresh — checking prices…");
      this.pollLog("login", "Session resumed after page reload — painting cache, starting refresh.");
    } else {
      this.welcomeBanner("Welcome back — checking prices…");
      this.pollLog("login", "Unlock detected — painting cache, starting refresh.");
    }
    this.resumedFromRefresh = false;

    // Once the login prefetch settles, spin the Refresh glyph briefly *iff* it
    // actually fetched new data — the honest "the prefetch got you something
    // newer" signal. Stays still when the book was already as fresh as possible.
    void this.maybeSignalPrefetchSpin(session);

    // 2. Optionally remember the verified passphrase behind the fingerprint.
    if (enrolRequested && this.state.passphrase) {
      try {
        await enrolBiometric(this.state.passphrase);
        this.toast("Fingerprint unlock enabled on this device.");
      } catch (err) {
        this.toast((err as Error).message);
      }
    }

    // 3. Re-download the encrypted blob in the background (skipped on a quick
    //    re-open) and 4. start the live-price auto-refresh (burst then slow).
    void this.maybeRefreshBlob(session);
    this.installVisibilityRefresh(session);
    // Startup quick-refresh: when prices are badly outdated, repopulate the book
    // fast. Tiingo answers a whole batch in a single request with no per-minute
    // cap — far faster than the Twelve Data primary, which trickles ~8 symbols/min
    // — so a big outdated set routes through Tiingo. But that scarcer budget is
    // protected by two rules (see {@link planStartupRefresh}): it never spends the
    // last few Tiingo credits, and it never fires for a small (≤8) outdated set the
    // primary can clear within a minute. A set too large for the spare budget is
    // split across both providers; a spent (or unconfigured) Tiingo budget forces
    // the Twelve Data primary instead. Throttled to ~once/hour via the persisted
    // stamp (set only when Tiingo is actually used) so it doesn't burn the budget
    // on every re-open. The subsequent scheduled refreshes (armed via
    // {@link scheduleNext}) carry no options, so they return to the normal
    // Twelve-Data-first cadence.
    const tiingoState = readTiingoState();
    const marketOpen = isUsMarketOpen();
    const quick = shouldQuickRefresh({
      now: Date.now(),
      marketOpen,
      lastQuickRefreshAt: tiingoState.lastQuickRefreshAt,
      freshestPriceAt: this.lastDataPullAt,
      holdsLatestClose: this.holdsLatestClose(),
    });
    // When badly outdated, decide how to route the pull. The startup Tiingo
    // quick-refresh never spends the last few Tiingo credits and never fires for a
    // small outdated set (the Twelve Data primary clears ≤8 within a minute); a
    // set too big for the spare Tiingo budget is split across both providers, and
    // a fully-spent (or unconfigured) Tiingo budget falls back to forcing Twelve.
    let quickOpts: { force?: boolean; viaTiingo?: boolean; tiingoReserve?: number } = {};
    if (quick) {
      const tiingoAvailable = resolvePriceProxyUrl(this.state.config) !== null;
      const plan = planStartupRefresh({
        outdatedCount: this.outdatedFetchCount(marketOpen),
        tiingoRemaining: tiingoRemainingCredits(Date.now()),
        tiingoAvailable,
      });
      if (plan.route === "tiingo") {
        quickOpts = { viaTiingo: true, tiingoReserve: STARTUP_TIINGO_RESERVE };
        noteQuickRefresh(Date.now());
      } else if (plan.route === "split") {
        // Force the Twelve Data primary (it clears the largest ~8 holdings), then
        // let the reserved Tiingo fallback fill the rest within its spare budget.
        quickOpts = { force: true, tiingoReserve: STARTUP_TIINGO_RESERVE };
        noteQuickRefresh(Date.now());
      } else {
        // route === "twelve": leave Tiingo untouched and force the primary; no
        // throttle stamp, so a later re-open may still fire Tiingo once it helps.
        quickOpts = { force: true };
      }
    }
    this.startupRefresh(session, quick, quickOpts);
    // 5. Arm the idle auto-lock so an unattended session locks itself.
    this.installAutoLock();
    // 6. Mint/refresh the tab-scoped resume token (opt-in) so a later page reload
    //    can pick this session back up without a re-login. A no-op (and a clear)
    //    when the option is off.
    void this.persistResumeToken();
  }

  /**
   * Mint or refresh the opt-in resume token after a successful unlock, wrapping
   * the in-memory passphrase with the per-device key. Bound to the current data
   * source so a later reload only resumes against the same book. When the option
   * is off (or there is somehow no passphrase) it instead clears any stale token.
   * Best-effort: a storage/crypto failure never blocks the dashboard.
   */
  private async persistResumeToken(): Promise<void> {
    if (!this.state.config.resumeOnRefresh || !this.state.passphrase) {
      clearResumeToken();
      return;
    }
    try {
      await saveResumeToken({
        passphrase: this.state.passphrase,
        blobUrl: resolveBlobUrl(this.state.config) ?? "",
        now: Date.now(),
      });
      this.lastResumeTouchAt = Date.now();
    } catch {
      /* resume is a convenience; never let a persist failure surface. */
    }
  }

  /**
   * The login-time refresh. The user's first question on opening the app is
   * always "is this data current?", so answer it *visibly*:
   *
   *   - if there is genuinely something to pull (the session is open, or a NAV is
   *     still awaited) — kick off an immediate, guaranteed-visible refreshing
   *     animation so it's obvious fresh data is being fetched right now; or
   *   - if everything is already settled and in hand — don't waste credits
   *     re-polling a closed market; instead pop a small toast confirming the
   *     prices are up to date and *when* they were last pulled, so the user knows
   *     the cache is trusted rather than wondering whether anything happened.
   *
   * A throttled startup quick-refresh (the Tiingo catch-up for badly stale
   * prices) always pulls, since it only fires when prices are demonstrably old.
   */
  private startupRefresh(
    session: number,
    quick: boolean,
    quickOpts: { force?: boolean; viaTiingo?: boolean; tiingoReserve?: number } = {},
  ): void {
    if (!quick && this.fullyUpToDate()) {
      // Only claim everything is current when it genuinely is: if the last network
      // round left a holding unable to price (and still stuck on a last-known
      // value), say so honestly instead of a blanket "up to date".
      if (this.lastUnresolvedFailures.length > 0) {
        this.toast(
          `No live price for ${this.lastUnresolvedFailures.join(", ")} · ` +
            `last pulled ${formatLastPull(this.lastDataPullAt)}`,
        );
      } else {
        this.toast(`Prices up to date · last pulled ${formatLastPull(this.lastDataPullAt)}`);
      }
      this.scheduleNext(session, SETTLED_HEARTBEAT_MS);
      return;
    }
    // The post-unlock kickoff: always run this first live refresh, even if the
    // tab momentarily reports hidden (common right after a fingerprint unlock).
    // This surfaces fresh prices immediately (with a guaranteed-visible startup
    // animation) and arms the auto-refresh loop via the scheduleNext at the end
    // of the round.
    void this.runScheduledRefresh(session, "start", { ...quickOpts, startup: true, kickoff: true });
  }

  // --- Idle auto-lock ---------------------------------------------------------

  /**
   * Arm an inactivity timer that locks the session after
   * {@link AppConfig.autoLockMinutes} minutes without interaction. Genuine
   * interaction — pointer/touch presses *and movement*, wheel, scroll, key,
   * typing, clicks and tab re-focus — resets the countdown, so the lock truly
   * only bites when the user has actually been away. A value of `0` disables the
   * feature. Safe to call repeatedly — it tears down any prior wiring first, so a
   * Settings change re-arms with the new timeout.
   *
   * Ahead of the lock, a dismissable warning ({@link showAutoLockWarning}) gives
   * the user a few seconds (and a one-tap "Stay unlocked") before it fires.
   */
  private installAutoLock(): void {
    this.removeAutoLock();
    const minutes = this.state.config.autoLockMinutes;
    if (minutes <= 0) {
      this.autoLockTimeoutMs = 0;
      return;
    }
    this.autoLockTimeoutMs = minutes * 60_000;
    const reset = (): void => {
      // Only keep counting while a session is actually unlocked.
      if (!this.state.passphrase) return;
      const now = Date.now();
      // Keep the resume token's idle clock honest, throttled so heavy movement
      // doesn't thrash storage.
      this.touchResume(now);
      const warningUp = this.autoLockWarnEl !== null;
      // High-frequency events (pointer/mouse moves, wheel) re-arm at most once a
      // second — but a *visible* warning is always cancelled immediately, so any
      // flicker of activity reliably keeps the user logged in.
      if (!warningUp && now - this.autoLockArmedAt < AUTO_LOCK_RESET_THROTTLE_MS) return;
      this.dismissAutoLockWarning();
      this.armAutoLockTimers();
    };
    this.activityHandler = reset;
    for (const event of AUTO_LOCK_ACTIVITY_EVENTS) {
      window.addEventListener(event, reset, { passive: true });
    }
    this.armAutoLockTimers();
  }

  /**
   * (Re)arm the warning + lock timers for the current {@link autoLockTimeoutMs}.
   * The warning fires {@link AUTO_LOCK_WARN_LEAD_MS} before the lock (clamped to
   * at most half the window so a short window still shows a sensible lead).
   */
  private armAutoLockTimers(): void {
    if (this.autoLockTimer) clearTimeout(this.autoLockTimer);
    if (this.autoLockWarnTimer) clearTimeout(this.autoLockWarnTimer);
    const timeoutMs = this.autoLockTimeoutMs;
    if (timeoutMs <= 0) return;
    this.autoLockArmedAt = Date.now();
    const lead = Math.min(AUTO_LOCK_WARN_LEAD_MS, Math.floor(timeoutMs / 2));
    this.autoLockWarnTimer = setTimeout(() => this.showAutoLockWarning(lead), Math.max(0, timeoutMs - lead));
    this.autoLockTimer = setTimeout(() => {
      if (this.state.passphrase) this.lock();
    }, timeoutMs);
  }

  /** Throttled re-stamp of the resume token's last-activity time. */
  private touchResume(now: number): void {
    if (!this.state.config.resumeOnRefresh) return;
    if (now - this.lastResumeTouchAt < RESUME_TOUCH_THROTTLE_MS) return;
    this.lastResumeTouchAt = now;
    touchResumeActivity(now);
  }

  /**
   * Surface the dismissable "locking soon" warning with a live countdown and a
   * one-tap "Stay unlocked" that extends the session. The banner is also
   * dismissable (and any genuine interaction cancels it via the activity reset).
   */
  private showAutoLockWarning(leadMs: number): void {
    if (typeof document === "undefined") return;
    if (!this.state.passphrase) return;
    this.dismissAutoLockWarning();
    let remaining = Math.max(1, Math.ceil(leadMs / 1000));
    const message = (secs: number): string =>
      `Locking in ${secs} second${secs === 1 ? "" : "s"} due to inactivity`;
    const text = h(
      "span",
      { id: "auto-lock-warn-text", class: "auto-lock-warn-text", "aria-atomic": "true" },
      [message(remaining)],
    );
    const stay = h("button", { class: "btn", type: "button" }, ["Stay unlocked"]);
    const dismiss = h(
      "button",
      { class: "icon-btn ghost icon-only", type: "button", "aria-label": "Dismiss" },
      ["×"],
    );
    const node = h(
      "div",
      {
        id: "auto-lock-warning",
        class: "app-toast is-autolock-warn",
        role: "alertdialog",
        "aria-label": "Auto-lock warning",
        "aria-labelledby": "auto-lock-warn-text",
        "aria-live": "assertive",
      },
      [text, h("div", { class: "row auto-lock-warn-actions" }, [stay, dismiss])],
    );
    stay.addEventListener("click", () => {
      // Extend: cancel the warning and re-arm the full window from now.
      this.dismissAutoLockWarning();
      this.armAutoLockTimers();
      this.touchResume(Date.now());
    });
    dismiss.addEventListener("click", () => this.dismissAutoLockWarning());
    document.body.append(node);
    this.autoLockWarnEl = node;
    this.autoLockCountdownTimer = setInterval(() => {
      remaining -= 1;
      text.textContent = remaining > 0 ? message(remaining) : "Locking…";
    }, 1000);
  }

  /** Remove the "locking soon" warning and stop its countdown, if shown. */
  private dismissAutoLockWarning(): void {
    if (this.autoLockCountdownTimer) {
      clearInterval(this.autoLockCountdownTimer);
      this.autoLockCountdownTimer = null;
    }
    if (this.autoLockWarnEl) {
      this.autoLockWarnEl.remove();
      this.autoLockWarnEl = null;
    }
  }

  /** Tear down the idle auto-lock timer and its activity listeners. */
  private removeAutoLock(): void {
    if (this.autoLockTimer) {
      clearTimeout(this.autoLockTimer);
      this.autoLockTimer = null;
    }
    if (this.autoLockWarnTimer) {
      clearTimeout(this.autoLockWarnTimer);
      this.autoLockWarnTimer = null;
    }
    this.dismissAutoLockWarning();
    if (this.activityHandler) {
      for (const event of AUTO_LOCK_ACTIVITY_EVENTS) {
        window.removeEventListener(event, this.activityHandler);
      }
      this.activityHandler = null;
    }
  }

  /**
   * Background check for a newer encrypted export, cheapest-signal-first:
   *
   *   1. the tiny `portfolio.meta.json` version stamp (a few bytes) — if its
   *      version matches what we already have, there is nothing new and we stop
   *      without touching the blob at all;
   *   2. otherwise a **conditional** blob GET (`If-None-Match` /
   *      `If-Modified-Since`) — a `304 Not Modified` likewise costs no transfer
   *      and no decrypt;
   *   3. only a genuine change pulls the new ciphertext, decrypts and re-renders.
   *
   * Because the check is now near-free it runs on demand (no 2-minute guard).
   * Failures are swallowed — the already-rendered cached data stands.
   */
  /**
   * C4 — the **awaitable blob-meta probe**, split out of {@link maybeRefreshBlob}
   * so the login kickoff can `await` *only* the cheap remote-recency signal before
   * it decides the round, while the heavy blob *download* stays fire-and-forget.
   * Without this the kickoff's `blobDaysOld` was always stale (every
   * `maybeRefreshBlob` is `void`-called), so a fresh remote blob that already
   * covered the gap was ignored and the round re-spent market credits.
   *
   * It fetches nothing but `portfolio.meta.json` (a few bytes) and updates
   * {@link blobPublishedAt}. It is **time-boxed** ({@link BLOB_META_PROBE_TIMEOUT_MS})
   * so a hung network can never block the kickoff — on timeout/failure it simply
   * returns and the round falls back to the current `blobDaysOld`. It has **no**
   * render/refresh side effects (unlike `maybeRefreshBlob`), so it is safe to await.
   */
  private async refreshBlobMeta(session: number): Promise<void> {
    const { config } = this.state;
    const metaUrl = resolveMetaUrl(config);
    if (!metaUrl) return;
    try {
      const meta = await withTimeout(fetchBlobMeta(metaUrl), BLOB_META_PROBE_TIMEOUT_MS);
      if (session !== this.sessionId) return;
      if (meta?.publishedAt) this.blobPublishedAt = meta.publishedAt;
    } catch {
      /* time-boxed best-effort: keep the current blobDaysOld, never block the kickoff. */
    }
  }

  /**
   * @param options.force A hard reset ("Update all data now"): re-download the
   *   blob **unconditionally**, however new. The cheap meta-version short-circuit
   *   is skipped and the conditional validators are withheld so the server can
   *   never answer `304 Not Modified` and serve back the (possibly corrupt)
   *   cached copy — the freshest published blob is always pulled and re-rendered,
   *   even if it is byte-for-byte what we already hold.
   */
  private async maybeRefreshBlob(session: number, options: { force?: boolean } = {}): Promise<void> {
    const force = options.force ?? false;
    const { config, passphrase } = this.state;
    if (!passphrase) return;
    const url = resolveBlobUrl(config);
    if (!url) return;
    // Stamp the attempt up front so the slow-cadence throttle (blobCheckDue)
    // measures from when we last *tried*, regardless of the outcome below.
    this.lastBlobCheckAt = Date.now();
    try {
      // 1. Lightweight version probe. A matching stamp means "no newer export"
      //    — but a forced reset re-downloads regardless, so it never short-
      //    circuits here.
      const metaUrl = resolveMetaUrl(config);
      const meta = metaUrl ? await fetchBlobMeta(metaUrl) : null;
      if (session !== this.sessionId) return;
      // Remember the best-available blob's publish time so the orchestrator's
      // `blobDaysOld` freshness keys on the *remote* recency (Pillar 1 assumption
      // 8), not the on-device download age.
      if (meta?.publishedAt) this.blobPublishedAt = meta.publishedAt;
      if (!force && meta && this.metaVersion !== null && meta.version === this.metaVersion) {
        this.pollLog("blob", `Data-file check: unchanged (meta version ${meta.version}).`);
        return;
      }

      // 2. Download. A routine check is *conditional* (an unchanged blob comes
      //    back as a bodyless 304 — no transfer, no decrypt). A forced reset is
      //    *unconditional* (validators withheld) so the server can never answer
      //    304 and the full blob is always pulled afresh.
      const cached = readCachedEnvelope();
      const result = await fetchEnvelopeConditional(
        url,
        force ? null : { etag: cached?.etag, lastModified: cached?.lastModified },
      );
      if (session !== this.sessionId) return;

      if (result.status === "not-modified") {
        // Nothing changed on the wire; just remember the latest meta version so
        // the next probe can short-circuit on step 1. (Unreachable when forced —
        // a validator-less request can never 304 — but handled for safety.)
        if (meta) this.persistEnvelope(this.envelope, { metaVersion: meta.version, etag: cached?.etag, lastModified: cached?.lastModified });
        this.pollLog("blob", "Data-file check: 304 Not Modified (no new export).");
        return;
      }

      const envelope = result.envelope;
      this.metaVersion = meta?.version ?? null;
      this.persistEnvelope(envelope, {
        etag: result.etag,
        lastModified: result.lastModified,
        metaVersion: meta?.version,
      });
      // Nothing to do if the ciphertext is byte-for-byte what we already have.
      // For AES-256-GCM the (nonce, ciphertext) pair uniquely identifies the
      // plaintext: a fresh export always re-encrypts under a new random nonce,
      // so matching both fields means the decrypted portfolio is unchanged. A
      // forced reset deliberately re-decrypts and re-renders even an unchanged
      // blob — re-seeding the graphs from the freshly-pulled `live_graphs`.
      if (!force && this.envelope && envelope.ciphertext === this.envelope.ciphertext && envelope.nonce === this.envelope.nonce) {
        return;
      }
      // A genuinely new export is on the wire — and it's worth telling the user:
      // a new blob means the desktop published a larger update (new holdings,
      // transactions, fresh history), so a bigger refresh is about to land. The
      // *checking* stays silent (no toast on a 304 / unchanged version); only an
      // actual new-data load pops up. A forced reset already toasts "Re-pulling
      // …" from its caller, so it stays quiet here.
      const hadData = this.envelope !== null;
      if (hadData && !force) this.toast("New data found — loading the latest portfolio…");
      this.pollLog(
        "blob",
        force
          ? `Hard reset — forced full re-download of the encrypted export (meta version ${meta?.version ?? "unknown"}); decrypting and re-rendering.`
          : `New encrypted export downloaded (meta version ${meta?.version ?? "unknown"}) — decrypting and re-rendering.`,
      );
      const data = await decryptEnvelopeToJson<MobileExport>(envelope, passphrase);
      if (session !== this.sessionId) return;
      this.envelope = envelope;
      this.state.data = data;
      // Re-render the (possibly new) holdings from cache instantly; the running
      // price scheduler will fetch anything freshly added on its next tick. A
      // forced reset (the Settings hard reset) deliberately *skips* this cache-only
      // repaint: its caller ({@link wipeGraphStoreThenRefresh}) has just **wiped**
      // every price cache and immediately kicks off a full from-scratch network
      // re-pull, so painting the just-emptied cache here would render every holding
      // on its last-known (non-live) value — and, if that paint lands *after* the
      // network re-pull, it sticks, making a hard reset wrongly read as "no
      // live-priced holdings". Leaving the prior live model on screen until the
      // re-pull repaints with fresh quotes avoids that race entirely.
      if (!force) await this.refreshPrices(session, false);
    } catch {
      /* background, best-effort: keep showing the cached data. */
    }
  }

  /** Persist the envelope + validators and stamp the in-memory download time. */
  private persistEnvelope(
    envelope: Envelope | null,
    validators: { etag?: string | null; lastModified?: string | null; metaVersion?: string | null },
  ): void {
    if (!envelope) return;
    this.envelopeAt = Date.now();
    writeCachedEnvelope(envelope, this.envelopeAt, validators);
  }

  /** The symbols to price live (priority-ordered), and the loadQuotes options. */
  private quoteRequest(
    data: MobileExport,
    config: AppConfig,
    force = false,
    forceAll = false,
    forceSymbols: ReadonlySet<string> = new Set(),
  ): { symbols: string[]; options: LoadQuotesOptions } {
    // Priority-ordered fetch plan: ETFs/stocks (largest first), then mutual
    // funds (largest first). Money-market/cash rows are excluded — their NAV is
    // pinned at $1 and never requested. The leading symbols are the ones that
    // most move the headline, so they land first under the per-minute cap.
    const plan = buildFetchPlan(data, FETCHABLE_NAV_CLASSES);
    const navFetchSymbols = new Set(plan.filter((e) => e.priceType !== "market").map((e) => e.symbol));
    const symbols = plan.map((e) => e.symbol);

    // Cache the plan so the next login can start warming these quotes *before*
    // the blob is decrypted (sizes change slowly, so a slightly stale order is
    // fine). Tickers/sizes only — never anything decrypted or secret.
    writeSymbolPlan(plan.map((e) => ({
      symbol: e.symbol,
      priceType: e.priceType,
      assetClass: e.assetClass,
      sizeEur: e.sizeEur,
      nativeCurrency: e.nativeCurrency,
    })));

    return { symbols, options: this.buildQuoteOptions(navFetchSymbols, config, force, forceAll, forceSymbols) };
  }

  /**
   * Whether every fetchable holding already holds its latest settled close — i.e.
   * there is nothing newer to fetch while the market is shut. Market symbols are
   * judged against {@link latestSettledSessionDate}; NAV funds against that same
   * latest settled session's NAV date.
   * Mirrors the per-symbol "behind" test used by the manual {@link forceFetch}
   * path so the startup quick-refresh agrees with a manual pull on what counts as
   * outdated. Returns true when there is no data yet (nothing to chase).
   */
  private holdsLatestClose(): boolean {
    return this.outdatedFetchCount(false) === 0;
  }

  /**
   * How many fetchable holdings are outdated and worth re-pricing right now. With
   * the market **closed** this is the count behind the latest settled close (market
   * symbols vs {@link latestSettledSessionDate}, NAV funds vs that same settled
   * session's NAV) — the same per-symbol "behind" test {@link holdsLatestClose} uses. With
   * the market **open** intraday prices move continuously, so once the
   * startup quick-refresh fires (the whole book is >1h stale) every fetchable
   * holding counts. Drives the startup-refresh routing in {@link start}; returns 0
   * when there is no data yet (nothing to chase).
   */
  private outdatedFetchCount(marketOpen: boolean): number {
    return this.staleFetchSymbols(marketOpen, new Date()).length;
  }

  /**
   * The symbols whose price the freshness ledger still considers stale — the
   * single source of truth behind both {@link outdatedFetchCount} and the WS5
   * post-decrypt reconcile ({@link reconcileHandshake}). While the market is open
   * every fetchable symbol is stale (an intraday mark is always chaseable); while
   * it is shut a market symbol is stale only until its latest *settled* close is in
   * hand, and a NAV fund only until that settled session's NAV lands. Returns `[]`
   * when there is no data yet (nothing to chase).
   */
  private staleFetchSymbols(marketOpen: boolean, now: Date): string[] {
    const data = this.state.data;
    if (!data) return [];
    const plan = buildFetchPlan(data, FETCHABLE_NAV_CLASSES);
    if (plan.length === 0) return [];
    if (marketOpen) return plan.map((entry) => entry.symbol);
    const cached = readCachedQuotes();
    const settled = latestSettledSessionDate(now);
    const stale: string[] = [];
    for (const entry of plan) {
      const cq = cached.get(entry.symbol)?.quote;
      if (entry.priceType === "market") {
        // Market symbol: outdated unless we hold the latest *settled* close — an
        // intraday-only print still counts as outdated so the official close is
        // captured once after the bell.
        if (!holdsSettledClose(cq, settled)) stale.push(entry.symbol);
      } else {
        // NAV fund (market closed here): outdated until we hold the latest
        // settled session's NAV. Polled until it lands, however late.
        const have = cq?.valueDate ?? null;
        if (!have || have < settled) stale.push(entry.symbol);
      }
    }
    return stale;
  }

  /**
   * Whether the live EUR/USD spot is stale per the user-set auto-refresh interval —
   * the FX arm of the freshness ledger the WS5 reconcile keys on. Stale when no
   * live spot is cached or the cached one is older than the refresh interval.
   */
  private isFxStale(now: Date): boolean {
    const cached = readCachedEurUsd();
    if (!cached || cached.now === null) return true;
    return now.getTime() - cached.at > this.state.config.updateMinutes * 60 * 1000;
  }

  /**
   * Build the (NAV-aware) {@link loadQuotes} options for a set of symbols. Shared
   * by the live refresh and the login-time prefetch so both honour the same
   * per-symbol cache windows. `force` forces market
   * symbols to re-fetch (the "pull now" path behind a manual Refresh tap); NAV
   * symbols stay on their once-a-day adaptive window regardless.
   *
   * `forceAll` is the heavier "ignore every schedule" escape hatch (Settings →
   * "Force-fetch every price now"): it re-pulls *every* symbol unconditionally —
   * market symbols even while the exchange is shut and the close is in hand, and
   * NAV funds even when they already hold the latest settled session's NAV — as if
   * we expected all of them to have a brand-new price. The hard free-tier per-minute
   * /day budget in {@link loadQuotes} still applies, so overflow simply defers.
   */
  private buildQuoteOptions(
    navFetchSymbols: Set<string>,
    config: AppConfig,
    force = false,
    forceAll = false,
    forceSymbols: ReadonlySet<string> = new Set(),
  ): LoadQuotesOptions {
    const cacheTtlMs = config.updateMinutes * 60 * 1000;
    return {
      cacheTtlMs,
      navSymbols: navFetchSymbols,
      // Market symbols are never force-fetched blindly: the smart skip below
      // (in the `forceFetch` property) decides per symbol whether a manual "pull
      // now" has anything new to capture, so a tap during a closed market with
      // the close already in hand spends no credits.
      forceMarketFetch: false,
      cacheTtlMsForSymbol: (symbol, cached) => {
        const now = new Date();
        if (navFetchSymbols.has(symbol)) {
          // NAV fund: while the market is open it cannot strike, so rest; once it
          // closes, poll like a normal symbol until the settled session's NAV is
          // in hand (no upper catch-up cap — catches a late NAV, even past midnight).
          return navCacheTtlMs(cached?.quote, {
            now: now.getTime(),
            marketOpen: isUsMarketOpen(now),
            shortTtlMs: cacheTtlMs,
            longTtlMs: DEFAULT_NAV_CACHE_TTL_MS,
          });
        }
        // Market symbol: while the exchange is shut and we already hold the latest
        // settled close there is nothing new to fetch — rest until it reopens.
        return marketCacheTtlMs(cached?.quote, {
          shortTtlMs: cacheTtlMs,
          marketOpen: isUsMarketOpen(now),
          latestSettledDate: latestSettledSessionDate(now),
        });
      },
      // A manual "pull now" re-fetches a symbol only when there is genuinely
      // something new to capture, so a tap never burns credits re-pulling prices
      // that cannot have changed:
      //   - market symbols: only when the session is open, or we do not yet hold
      //     the latest settled close. While the market is shut and that close is
      //     in hand — true both after the closing bell *and* the next morning
      //     before the open — they stay quiet, mirroring the automatic skip.
      //   - NAV funds: only when *behind* the latest settled session's NAV (we are
      //     demonstrably missing it); otherwise they stay exempt so a tap never
      //     chases an unchanged NAV. While the market is open they are never behind
      //     (the NAV cannot have struck mid-session), so a tap leaves them quiet.
      // `forceAll` overrides all of that and re-pulls *every* symbol — the
      // explicit "ignore NAV schedules and market-closed skips" escape hatch.
      // `forceSymbols` (freshness-plan §3) is a per-round explicit drain of
      // parked-but-stale deferred-queue entries: those symbols re-pull this round
      // regardless of the per-symbol skip, so a deferral is resolved by an explicit
      // pull rather than left waiting on its cache TTL.
      forceFetch: forceAll
        ? () => true
        : force || forceSymbols.size > 0
          ? (symbol, cached) => {
              if (forceSymbols.has(symbol)) return true;
              if (!force) return false;
              const at = new Date();
              if (!navFetchSymbols.has(symbol)) {
                if (isUsMarketOpen(at)) return true;
                // Closed: re-pull unless we hold the latest *settled* close. An
                // intraday-only capture (value-date is today but taken before the
                // bell) still warrants one pull to record the official close.
                return !holdsSettledClose(cached?.quote, latestSettledSessionDate(at));
              }
              // NAV: nothing new while the market is open; once closed, re-pull
              // until the latest settled session's NAV is in hand.
              if (isUsMarketOpen(at)) return false;
              const have = cached?.quote.valueDate ?? null;
              return !(have && have >= latestSettledSessionDate(at));
            }
          : undefined,
    };
  }

  /**
   * Build and render the dashboard.
   *
   * When `network` is false this is a zero-credit paint straight from cache
   * (used for the instant first paint and after a blob change) — no quotes or FX
   * are fetched, and the staleness banner is suppressed because a real refresh
   * follows. When `network` is true it does a budgeted live refresh and returns
   * the load report so the auto-refresh scheduler can decide what to do next.
   *
   * `opts.plan` is the central orchestrator's verdict for this round (Pillar 1):
   * the FX, quotes, and NAV legs are only executed when the plan has turned them
   * on. A missing plan (cache-only calls) is treated conservatively — all legs
   * allowed — but in practice every `network === true` call passes the plan.
   */
  private async refreshPrices(
    session: number,
    network: boolean,
    opts: { force?: boolean; forceAll?: boolean; viaTiingo?: boolean; tiingoReserve?: number; connectivity?: ConnectivityState; plan?: PullPlan; forceSymbols?: ReadonlyArray<string> } = {},
  ): Promise<QuoteLoadReport | null> {
    const { data, config } = this.state;
    if (!data) return null;

    const forceAll = network && (opts.forceAll ?? false);
    // "Route everything through the backup provider": skip the Twelve Data
    // primary quote fetch entirely (serve quotes from cache only) and let the
    // Tiingo fallback below re-pull every still-behind holding instead.
    const viaTiingo = network && (opts.viaTiingo ?? false);
    // Freshness-plan §3 — parked-but-stale symbols drained from the deferred queue
    // are forced to re-pull this round (an explicit drain), not left to their cache
    // TTL. Only meaningful on a network round.
    const forceSymbols = network ? new Set(opts.forceSymbols ?? []) : new Set<string>();
    const { symbols, options } = this.quoteRequest(
      data,
      config,
      network && ((opts.force ?? false) || forceAll),
      forceAll,
      forceSymbols,
    );
    // Remember which symbols are NAV-priced funds so the coverage summary can
    // split the live market count from the once-a-day NAVs that are still
    // expected/awaited (see {@link summarizeCoverage}) rather than a bare count.
    this.lastNavSymbols = options.navSymbols ?? new Set();
    const apiKey = network ? config.apiKey : "";
    // The primary (Twelve Data) quote fetch is suppressed when routing through
    // the backup provider — an empty key makes loadQuotes serve quotes from
    // cache only, so the Tiingo pass below sources every non-recent holding.
    const quotesApiKey = viaTiingo ? "" : apiKey;

    // Orchestrator leg gates: only fetch what the central plan approved.
    // The plan is always provided for network rounds (from planRoundPull); a
    // missing plan (cache-only calls) defaults to "all on" so nothing is silently
    // dropped. A reset / force-all plan has all legs on already.
    const plan = opts.plan;
    const fetchFx = plan?.legs.fx ?? true;
    const fetchQuotes = plan?.legs.quotes ?? true;
    const fetchNav = plan?.legs.nav ?? true;
    // Filter the symbol list to only the legs the orchestrator approved. This
    // ensures NAV-only rounds don't spend market credits and vice versa.
    const symbolsToFetch = network
      ? symbols.filter((s) => {
          const isNav = this.lastNavSymbols.has(s);
          return isNav ? fetchNav : fetchQuotes;
        })
      : symbols;

    // Flip the on-screen status caption of every holding about to be pulled to a
    // live "Updating…" (lit dots) the instant the round begins — straight to the
    // DOM, so the motion shows immediately rather than only when the round lands.
    // Cache-only paints don't pull, so they never claim to be updating.
    if (network && symbolsToFetch.length > 0) {
      markHoldingsUpdating(this.root, symbolsToFetch);
    }

    // Pull the live currency (FX + EUR/USD spot) FIRST — before any stock, ETF or
    // fund quote — so the per-minute free-tier budget always funds the rate that
    // values the whole book, never spending it all on tickers and leaving FX last.
    // The orchestrator's FX leg gate ({@link fetchFx}) is the sole authority here:
    // when the FX spot was recently pulled (within the user-set interval) and this
    // is not a manual tap, Overlay 3 suppresses the leg and we serve from cache.
    let fx: FxRates;
    let fxReport: { cached: boolean; error: PriceError | null };
    let eurUsdNow: Decimal | null = null;
    let eurUsdPrev: Decimal | null = null;
    let eurUsdSource: EurUsdSource = "none";
    let eurUsdError: PriceError | null = null;
    let eurUsdAt: number | null = null;
    if (network && fetchFx) {
      const fxLoad = await loadFxRates();
      fx = fxLoad.fx;
      fxReport = fxLoad;
      // Live EUR/USD (current + prior close) for an FX-aware today's move.
      // The orchestrator decided this is due, so fetch fresh (ttlMs: 0). No
      // separate reuse window: the FX overlay in planPull suppresses this leg
      // when the spot is within the user's interval, replacing the old 45-second
      // REFRESH_EURUSD_REUSE_MS guard. Degrades gracefully — when the pair can't
      // be fetched (no budget/key, a transient failure, or the weekend FX close)
      // loadEurUsd falls back to the Tiingo backup FX provider (via the /price
      // Worker), then today's cached spot, then the ECB rate.
      const eurUsd = await loadEurUsd(apiKey, {
        eodFallback: fx.rates.USD ?? null,
        ttlMs: 0,
        tiingoProxyUrl: resolvePriceProxyUrl(config),
        // Over the weekend forex close, freeze on the last cached spot instead of
        // spending a credit to re-confirm Friday's unchanged close.
        forexOpen: isForexMarketOpen(),
      });
      eurUsdNow = eurUsd.now;
      eurUsdPrev = eurUsd.previousClose;
      eurUsdSource = eurUsd.source;
      eurUsdError = eurUsd.error;
      eurUsdAt = eurUsd.at;
    } else {
      // Cache-only paint (or FX leg suppressed by orchestrator): reuse the last
      // cached pair so the dashboard values the book off the most recent spot.
      const cachedFx = readCachedFx();
      fx = cachedFx?.fx ?? { base: "EUR", rates: {} };
      fxReport = { cached: cachedFx !== null, error: null };
      const cachedEurUsd = readCachedEurUsd();
      if (cachedEurUsd) {
        eurUsdNow = cachedEurUsd.now;
        eurUsdPrev = cachedEurUsd.previousClose;
        eurUsdSource = "cache";
        eurUsdAt = cachedEurUsd.at;
      }
    }
    // Prefer the live EUR/USD spot (more current than the ECB daily rate) for
    // all current marks, so value and today's move share one consistent rate.
    if (eurUsdNow !== null && eurUsdNow.greaterThan(0)) {
      fx = { base: fx.base, rates: { ...fx.rates, USD: eurUsdNow } };
    }

    // Now fetch the stock / ETF / fund quotes with whatever budget remains.
    // `symbolsToFetch` is already filtered by the orchestrator's leg gates.
    const quotePromise = loadQuotes(symbolsToFetch, quotesApiKey, options);

    const quoteLoad = await quotePromise;
    // A superseded session (lock, or a newer unlock) must not paint over the UI.
    if (session !== this.sessionId) return quoteLoad.report;

    // A *fatal* quote failure (a rejected / over-quota API key) is a config
    // problem the user must act on, so keep the explicit error screen with a
    // route to Settings. Any other failure (a 404, a 5xx, a network blip, a
    // rate limit) is non-fatal: never wipe a populated dashboard for it — fall
    // through and paint the cached / last-known values with a soft banner.
    if (network && quoteLoad.report.error?.fatal) {
      this.renderLoadError(quoteLoad.report.error.message);
      return null;
    }

    if (network) {
      const r = quoteLoad.report;
      const list = (xs: string[]): string => (xs.length ? xs.join(", ") : "none");
      this.pollLog(
        "fx",
        `EUR/USD source: ${eurUsdSource}${eurUsdError ? ` (error: ${eurUsdError.message})` : ""}.`,
      );
      this.pollLog(
        "primary",
        viaTiingo
          ? "Primary (Twelve Data) skipped — routing this pull through the backup provider; quotes served from cache."
          : `Primary (Twelve Data): fetched ${r.fetched.length} [${list(r.fetched)}], ` +
              `served ${r.servedFresh.length} from cache, deferred ${r.deferred.length} [${list(r.deferred)}]. ` +
              `Budget left: ${r.minuteRemaining}/min, ${r.dayRemaining}/day.` +
              (r.error ? ` Non-fatal error: ${r.error.message}.` : ""),
        viaTiingo ? "info" : r.error ? "warn" : "good",
      );
    }

    // --- Tiingo secondary-provider fallback ---------------------------------
    // After the Twelve Data (primary) pass, fill what it left missing/stale (and
    // the over-quota case) from Tiingo for US tickers, within Tiingo's own
    // ET-reset budget. NAV funds run the same eligibility + budget pass as stocks.
    // This mutates quoteLoad.quotes in place and never throws for a transient failure.
    if (network) {
      const proxyUrl = resolvePriceProxyUrl(config);
      const sizes = new Map(readSymbolPlan().map((e) => [e.symbol, e.sizeEur] as const));
      // Pillar 5 (WS6) — a **manual reload** of a big sleeve must respect the same
      // provider-fan-out invariant 4 as login: a *non-login* fan-out has to leave
      // the last {@link TIINGO_RESERVE_CREDITS} Tiingo credits untouched, so a big
      // manual reload can't drain the hourly Tiingo floor the next auto round and
      // other devices rely on. Here {@link planFanout} is consulted **only for that
      // reserve decision** — the actual TD-primary → Tiingo split is executed by the
      // sequential `loadQuotes` pass above plus the `runTiingoFallback` below, so the
      // planner's `twelveData`/`tiingo` legs are not re-dispatched (no double fetch).
      // Scoped to the force/force-all manual tap (the "via backup" route is a
      // deliberate drain and keeps its own reserve).
      const isManualReload = ((opts.force ?? false) || forceAll) && !viaTiingo;
      let reserveCredits = opts.tiingoReserve ?? 0;
      if (isManualReload) {
        const marketSleeve = symbolsToFetch.filter((s) => !this.lastNavSymbols.has(s));
        const fanoutNow = Date.now();
        const reserve = planFanout({
          kind: "manual",
          symbols: marketSleeve,
          twelveDataSpendable: twelveDataAvailable(fanoutNow),
          tiingoSpendable: tiingoAvailable(fanoutNow),
          tiingoAvailable: proxyUrl !== null,
          twelveDataBatch: FREE_TIER.creditsPerMinute,
        });
        this.pollLog(
          "fallback",
          `Manual fan-out reserve (${marketSleeve.length} mkt symbol(s)): ${reserve.reason}`,
        );
        if (reserve.fannedOut) reserveCredits = Math.max(reserveCredits, TIINGO_RESERVE_CREDITS);
      }
      const fallback = await runTiingoFallback({
        symbols: symbolsToFetch,
        navSymbols: this.lastNavSymbols,
        quotes: quoteLoad.quotes,
        report: quoteLoad.report,
        proxyUrl,
        now: Date.now(),
        manual: (opts.force ?? false) || viaTiingo,
        forceAll: viaTiingo,
        reserveCredits,
        sizeForSymbol: (symbol) => sizes.get(symbol) ?? 0,
      });
      if (session !== this.sessionId) return quoteLoad.report;
      this.lastTiingoSymbols = fallback.tiingoSymbols;
      this.lastFallbackSymbols = fallback.fallbackSymbols;
      this.lastTiingoBudget = fallback.budget;
      // Remember whether the backup itself failed this round (needed but
      // unreachable). Cleared to null on a clean round, so the banner/toast only
      // shout while the backup is genuinely down.
      this.lastTiingoError = fallback.error;
      const b = fallback.budget;
      this.pollLog(
        "fallback",
        fallback.tiingoSymbols.length > 0
          ? `Backup (Tiingo) filled ${fallback.tiingoSymbols.length} [${fallback.tiingoSymbols.join(", ")}]. ` +
              `Budget: ${b.hourUsed}/${b.hourLimit} this hour, ${b.dayUsed}/${b.dayLimit} today.` +
              (fallback.error ? ` Error: ${fallback.error.message}.` : "")
          : fallback.error
            ? `Backup (Tiingo) needed but unreachable: ${fallback.error.message}.`
            : proxyUrl
              ? "Backup (Tiingo) not needed this round (primary covered the book or nothing newer to fetch)."
              : "Backup (Tiingo) not configured (no /price proxy URL).",
        fallback.tiingoSymbols.length > 0 ? (fallback.error ? "warn" : "good") : fallback.error ? "error" : "info",
      );

      // --- Reverse safety net: Tiingo (primary) → Twelve Data ----------------
      // Smart routing lets a hard refresh route the whole book through Tiingo as
      // the *sole* primary (the Twelve Data quote pass above was skipped). If
      // Tiingo then fails somewhere — unreachable, over-quota, or nothing newer —
      // those holdings would be stuck on a cached / last-known price with no
      // provider behind them. Catch exactly Tiingo's holes on Twelve Data so a
      // Tiingo outage degrades to the primary instead of to stale data. The
      // re-pull self-clamps to the live Twelve Data per-minute/day budget (it
      // routes through the same `loadQuotes` reservation), so it respects the
      // same budget + scheduling as every other primary pull and never overspends.
      const safetyNet = planTwelveDataSafetyNet({
        viaTiingo,
        unfilled: quoteLoad.report.deferred,
        tiingoFilled: fallback.tiingoSymbols,
      });
      if (safetyNet.engaged && apiKey.length > 0) {
        const tdNet = await loadQuotes(safetyNet.twelveData, apiKey, {
          ...options,
          forceMarketFetch: true,
        });
        if (session !== this.sessionId) return quoteLoad.report;
        const filledNow = this.absorbSafetyNet(quoteLoad, tdNet);
        const list = (xs: readonly string[]): string => (xs.length ? xs.join(", ") : "none");
        this.pollLog(
          "primary",
          `Tiingo→Twelve Data safety net: ${safetyNet.reason} ` +
            `Filled ${filledNow.length} [${list(filledNow)}]. ` +
            `Budget left: ${tdNet.report.minuteRemaining}/min, ${tdNet.report.dayRemaining}/day.` +
            (tdNet.report.error ? ` Non-fatal error: ${tdNet.report.error.message}.` : ""),
        );
      } else if (viaTiingo) {
        this.pollLog("primary", `Tiingo→Twelve Data safety net: ${safetyNet.reason}`);
      }
    } else if (this.lastTiingoBudget === null) {
      this.lastTiingoSymbols = [];
      this.lastFallbackSymbols = [];
    }

    const unresolvedFailures = network ? this.unresolvedFailedSymbols(quoteLoad.report) : [];
    if (network) this.lastUnresolvedFailures = unresolvedFailures;
    // Suspect data — a freshly-fetched quote that came back with a non-positive
    // price (zero/negative). It isn't a *failure* (we got a number) but it is
    // *wrong data* the valuation would forward-fill, so it gets its own loud,
    // greppable line and is folded into the round's verdict (stolen from the
    // desktop pull-log's SUSPECT concept).
    if (network) {
      const suspect = suspectQuoteSymbols(quoteLoad.quotes, quoteLoad.report.fetched);
      this.lastSuspectSymbols = suspect;
      if (suspect.length > 0) {
        this.pollLog(
          "primary",
          `SUSPECT data — non-positive price for ${suspect.join(", ")}; ignoring rather than booking it into the valuation.`,
          "error",
        );
      }
    }
    // Classify what this round actually achieved on the wire so the UI never
    // claims to be "updating" when nothing could be fetched. A network round
    // derives it from what landed vs. which providers errored; a cache-only
    // paint carries the verdict in from the caller (the offline short-circuit).
    if (network) {
      this.lastConnectivity = classifyConnectivity({
        online: this.isOnline(),
        fetched: quoteLoad.report.fetched.length,
        fxFetched: !fxReport.cached && fxReport.error === null,
        quoteError: quoteLoad.report.error,
        tiingoError: this.lastTiingoError,
      });
    } else if (opts.connectivity !== undefined) {
      this.lastConnectivity = opts.connectivity;
    }
    const degradedReason = network
      ? this.describeDegradation(quoteLoad.report, fxReport, this.lastTiingoError, {
          eurUsdError,
          eurUsdSource,
        }, unresolvedFailures, this.lastConnectivity)
      : connectivityNotice(this.lastConnectivity);
    // Record when fresh market data actually landed: a live quote fetch, or a
    // live (non-cached) FX pull. This is "when we last pulled", independent of
    // how old the prices themselves are — so even over a closed-market weekend
    // it reflects today's pull. Persisted so it survives reload / re-open.
    if (network && (quoteLoad.report.fetched.length > 0 || !fxReport.cached)) {
      this.lastDataPullAt = Date.now();
      writeLastPull(this.lastDataPullAt);
    }
    // FX KPI baseline recovery. The "today" FX move is measured from the prior
    // session's settled EUR/USD close, which only the live provider's quote
    // carries directly. When the spot came from cache / Tiingo / end-of-day (or a
    // cold start) that prior close is missing, leaving the FX KPI stuck on "—"
    // with no way to recover. Fall back to the close persisted in the on-device
    // 1D FX bars (now fetched one session wide; see {@link sessionFxHistoryWindow})
    // so the baseline — and with it the FX-aware move and KPI — recovers from an
    // empty state rather than fabricating a swing.
    if (eurUsdPrev === null) {
      const recovered = await this.barsPrevSessionCloseFx(lastSessionDate(new Date()));
      if (recovered !== null) {
        eurUsdPrev = recovered;
        if (network) {
          this.pollLog("fx", "EUR/USD prior close recovered from on-device 1D FX bars.");
        }
      }
    }
    const model = buildDashboard(data, quoteLoad.quotes, fx, new Date(), degradedReason, {
      fxPrevEurUsd: eurUsdPrev,
      fxEurUsdSource: eurUsdSource,
      fxObservedAt: eurUsdAt,
      // Tie the "live" freshness window to the user-set auto-refresh interval.
      liveStalenessMs: this.state.config.updateMinutes * 60 * 1000,
    });
    model.overview.lastDataPullAt = this.lastDataPullAt;
    // Capture the session-close EUR/USD rate so the live 1D/1W graphs can freeze
    // their EUR view to it overnight (the market-day trajectory must not slide
    // with after-hours FX), and so the Overview can isolate the overnight FX
    // slice. While the regular session is open we keep recording the live spot as
    // the running close for today; the last value written before 16:00 ET is the
    // settled close. Once shut, we resolve the single authoritative session close
    // and surface it; the longer history graphs and the headline keep valuing at
    // the live spot, unchanged.
    {
      const now = new Date();
      const marketOpen = isUsMarketOpen(now);
      const liveFx = fx.rates.USD ?? model.overview.fxRateEurUsd;
      const sessionDay = lastSessionDate(now);
      if (marketOpen) {
        recordSessionCloseFx(sessionDay, liveFx);
        // Capture the first live spot of the session as a stand-in open rate, so
        // the currency split has an anchor immediately at the market start —
        // before the session's own FX bars have been fetched (the first bar can
        // lag 09:30 ET by minutes on the free tier, and a cold start mid-session
        // has none yet). Earliest-only, so it stays a fixed open, not the spot.
        recordSessionOpenFx(sessionDay, liveFx);
      }
      // Prefer the close read straight from the session's EUR→USD bars — the same
      // authoritative source the 1D/1W graphs freeze to (so the hero's currency-
      // effect split and the graph never disagree on what "the close" is), and the
      // only one that exists on a cold start / weekend when the app was never live
      // at 16:00 ET to capture a running close. Fall back to the live-captured
      // running close when no bars are on the device yet.
      model.overview.fxRateEurUsdSessionClose = marketOpen
        ? null
        : (await this.barsSessionCloseFx(sessionDay)) ?? readSessionCloseFx(sessionDay);
      // The session's open rate, read from the same FX bars. While the session is
      // running it lets the currency-effect split carve out the live market-hours
      // slice and keep last night's overnight as the remainder (so it survives the
      // market start); once the trading day has shut it is the "since last market
      // open" anchor the hero's "Today" stat re-bases to (so that stat stops
      // mirroring the now-settled "since close" move). Read on every session day —
      // open or shut. Until the day's first FX bar has landed (a common gap right
      // at the market start), fall back to the first-seen live spot we captured
      // above so the split shows immediately and then self-corrects to the precise
      // bar-read open once it arrives.
      model.overview.fxRateEurUsdSessionOpen =
        (await this.barsSessionOpenFx(sessionDay)) ?? readSessionOpenFx(sessionDay);
    }
    // Remember each fund's freshly-settled NAV as a daily bar in the 1W store, so
    // the week curve re-marks NAV funds from their real per-day drift at zero
    // graph cost (item 7a.1). Best-effort: a store failure never sinks the paint.
    if (network) this.persistFundNavBars(quoteLoad.quotes);
    // Refresh the live-coverage summary on a network pull; keep the last one on a
    // cache-only re-paint so a currency toggle / blob swap doesn't blank it.
    // Promote a cache-served EUR/USD that is still extremely fresh to "live": a
    // spot pulled moments ago and replayed from cache this round is, to the user,
    // just as live as the market prices — only a genuinely aged cache reads "recent".
    const fxDisplaySource = displayFxSource(
      eurUsdSource,
      eurUsdAt,
      Date.now(),
      this.state.config.updateMinutes * 60 * 1000,
    );
    if (network) {
      this.lastCoverageFacts = buildCoverageFacts(
        quoteLoad.report,
        quoteLoad.quotes,
        this.lastNavSymbols,
        {
          now: new Date(),
          marketOpen: isUsMarketOpen(),
          freshlyPulled: this.recentlyPulled(),
          fx: fxDisplaySource,
          fxMarketClosed: !isForexMarketOpen(),
          liveStalenessMs: this.state.config.updateMinutes * 60 * 1000,
        },
      );
      this.lastCoverage = summarizeCoverage(this.lastCoverageFacts);
      const cf = this.lastCoverageFacts;
      this.pollLog(
        "note",
        `Coverage: market ${cf.marketFresh} live / ${cf.marketUpdating} updating / ` +
          `${Math.max(0, cf.marketHeld - cf.marketFresh - cf.marketUpdating)} cached / ` +
          `${cf.marketAtClose} at last close of ${cf.marketTotal}; ` +
          `NAVs ${cf.navTotal - cf.navAwaiting}/${cf.navTotal} in (${cf.navAwaiting} awaiting); ` +
          `FX ${cf.fx}; market ${cf.marketOpen ? "open" : "closed"} → “${this.lastCoverage}”.`,
      );
    } else if (this.lastCoverage === null) {
      // First paint after unlock is a *cache-only* render (network === false), so
      // the coverage summary above never ran and the overview would show a blank
      // coverage line until the background network refresh finishes. The login
      // prefetch has already warmed the quote/FX caches, so summarise honestly
      // from what we hold *right now* — cached observations and their value-dates,
      // never dressed up as a fresh live pull (freshlyPulled gates that). Only
      // fills the initial gap: a later cache re-paint (currency toggle, blob swap)
      // keeps the real network coverage rather than overwriting it from cache.
      this.lastCoverageFacts = buildCoverageFacts(
        quoteLoad.report,
        quoteLoad.quotes,
        this.lastNavSymbols,
        {
          now: new Date(),
          marketOpen: isUsMarketOpen(),
          freshlyPulled: this.recentlyPulled(),
          fx: fxDisplaySource,
          fxMarketClosed: !isForexMarketOpen(),
          liveStalenessMs: this.state.config.updateMinutes * 60 * 1000,
        },
      );
      this.lastCoverage = summarizeCoverage(this.lastCoverageFacts);
    }
    model.overview.liveCoverage = this.lastCoverage;
    // Surface how much of the daily free-tier budget we've spent so far.
    model.overview.dailyCreditsUsed = Math.max(
      0,
      model.overview.dailyCreditLimit - quoteLoad.report.dayRemaining,
    );
    // Surface the Tiingo fallback's own hourly/daily usage, mirroring the Twelve
    // Data line, and append a discreet note when any price came via Tiingo. Read
    // the budget *live* from the credit log (not the snapshot taken when the
    // quote fallback last ran) so the 1D/1W graph-bar and FX-history pulls — which
    // spend the same Tiingo budget — are counted here too.
    const liveTiingoBudget = tiingoBudgetView(Date.now());
    if (this.lastTiingoBudget || liveTiingoBudget.dayUsed > 0 || liveTiingoBudget.hourUsed > 0) {
      model.overview.tiingoHourUsed = liveTiingoBudget.hourUsed;
      model.overview.tiingoHourLimit = liveTiingoBudget.hourLimit;
      model.overview.tiingoDayUsed = liveTiingoBudget.dayUsed;
      model.overview.tiingoDayLimit = liveTiingoBudget.dayLimit;
    }
    if (this.lastFallbackSymbols.length > 0) {
      const note = `${this.lastFallbackSymbols.length} price${this.lastFallbackSymbols.length === 1 ? "" : "s"} via fallback`;
      model.overview.liveCoverage = model.overview.liveCoverage
        ? `${model.overview.liveCoverage} · ${note}`
        : note;
    }
    // Prefer the live EUR→USD rate; fall back to the export meta rate.
    setEurUsdRate(fx.rates.USD ?? model.overview.fxRateEurUsd);
    // Record today's whole-book close, prune anything a fresh blob now covers,
    // and preload the persisted daily history so the value chart can rebuild the
    // gap a stale blob leaves between its last point and today. Best-effort: a
    // store failure must never sink the paint, so it falls back to no backfill.
    model.valueBackfill = await this.syncValueHistory(model).catch(() => []);
    // Update each holding's status signals from this round before the re-render:
    // freshly-pulled symbols flash "Updated ✓" (then settle to "Updated <time>"),
    // and budget-deferred symbols carry the calmer "Updating…" queued state into
    // the next round. Cache-only paints (currency toggle, blob swap) don't pull, so
    // they leave both untouched and simply re-show whatever the last round left.
    if (network) {
      const landedAt = Date.now();
      for (const symbol of quoteLoad.report.fetched) {
        this.holdingUpdatedAt.set(symbol, landedAt);
      }
      this.holdingQueued = new Set(quoteLoad.report.deferred);
    }
    this.renderDashboard(model);
    return quoteLoad.report;
  }

  /**
   * The Settings "Update all data now" escape hatch: throw away every cached
   * price and re-pull the lot from scratch. Quotes can otherwise linger behind
   * their (deliberately long) NAV / closed-market freshness windows, so if a
   * value ever looks stuck — a NAV that published late, a provider hiccup, a bug
   * in the staleness logic — this guarantees a clean re-fetch with one tap.
   *
   * It clears the quote/FX/EUR-USD caches **and the persisted intraday store**
   * (the bars/tips behind the live 1D/1W graphs), drops the in-memory blob
   * version stamp, and forces an **unconditional** re-download of the encrypted
   * export — withholding the HTTP validators so the server can never answer
   * `304 Not Modified` and hand back the cached copy, however new the remote
   * blob is. It then returns to the dashboard and runs a forced full refresh.
   * Only the soft "conserve the last credits" gate is bypassed — the hard
   * free-tier per-minute/day budget in {@link loadQuotes} still applies, so a
   * from-scratch pull can never blow the daily allowance (any overflow simply
   * defers and back-fills on later ticks).
   */
  private updateAllFromScratch(): void {
    // Forget every cached price so nothing is served from a stale window.
    clearPriceCaches();
    // A from-scratch reset must also drop any armed time-series backoff so every
    // graph symbol is re-pulled, not parked on a stale cooldown.
    clearAllSeriesBackoff();
    this.pollLog(
      "note",
      "Hard reset (Settings) — cleared price caches and wiping the 1D/1W graph store, then re-pulling everything from scratch.",
    );
    // Drop the in-memory version stamp too. The forced re-download below already
    // pulls unconditionally, but clearing it keeps the post-reset state honest
    // (the next routine probe re-establishes the stamp from the fresh blob).
    this.metaVersion = null;
    // Back to the dashboard immediately so the reset feels responsive, then
    // wipe the persisted intraday store and re-pull (see below — the wipe must
    // finish before the refresh runs).
    this.exitSettings();
    this.toast("Re-pulling all prices from scratch…");
    void this.wipeGraphStoreThenRefresh();
  }

  /**
   * Wipe the persisted intraday bars/tips and **only then** kick off the
   * from-scratch refresh.
   *
   * The live 1D/1W graphs are rebuilt from this IndexedDB store, so a price-only
   * wipe would leave a stale or malformed curve on screen (the exact thing a
   * user resets the cache to fix). Crucially the clear must *complete* before
   * the refresh starts: the rebuild reads this store (smart backfill) and
   * re-persists the live-tip breadcrumbs / bars, so a fire-and-forget wipe races
   * the refresh and the old "in-between" values survive the reset — the bug this
   * ordering fixes. Best-effort: a store failure must not block the re-pull.
   */
  private async wipeGraphStoreThenRefresh(): Promise<void> {
    try {
      await this.ensureTimeSeriesStore().clear();
    } catch {
      /* best-effort: leave the intraday store as-is if the wipe fails. */
    }
    const session = this.sessionId;
    void this.maybeRefreshBlob(session, { force: true });
    if (this.refreshing) return; // a pull is already in flight; it will repaint
    // The store was just wiped, so the 1D/1W graphs are stale: `primeGraphs` makes
    // the forced refresh pull those packages first (their bars double as quotes),
    // so Tiingo isn't spent on both the rapid-fire quote and the 1W graph.
    void this.runScheduledRefresh(session, "reset", { force: true, primeGraphs: true });
  }

  /**
   * The Settings "Force-fetch every price now" escape hatch: re-pull *every*
   * symbol from the provider right now, ignoring the NAV publish schedules and
   * the market-closed skips that normally keep a tap from spending credits on a
   * price that cannot have changed. Use it when you expect *all* holdings to have
   * a fresh value (e.g. just after a known publish) and want to pull them all at
   * once rather than waiting for each symbol's window.
   *
   * Unlike {@link updateAllFromScratch} this keeps the caches intact — it only
   * bypasses the freshness gates for this one pull (see {@link buildQuoteOptions}
   * `forceAll`). The hard free-tier per-minute/day budget in {@link loadQuotes}
   * still applies, so any overflow just defers.
   */
  private forceFetchAllNow(): void {
    // Back to the dashboard, then force a pull of every symbol.
    this.exitSettings();
    this.toast("Pulling every live price now…");
    // A deliberate hard refresh overrides any armed time-series backoff so every
    // graph symbol is re-attempted immediately (the automatic loop keeps it).
    clearAllSeriesBackoff();
    this.pollLog(
      "note",
      "Hard refresh (Settings) — force-fetching every live price now, bypassing the freshness/NAV-schedule gates.",
    );
    const session = this.sessionId;
    if (this.refreshing) return; // a pull is already in flight; it will repaint
    void this.runScheduledRefresh(session, "manual", { force: true, forceAll: true });
  }

  /**
   * The Settings "Try the backup data provider now" escape hatch: route the
   * whole book through the secondary provider (Tiingo) for one pull. It skips the
   * Twelve Data primary fetch entirely and asks Tiingo for every holding whose
   * cached value is *not* already recent (behind the latest settled session / its
   * expected NAV), bypassing the per-symbol "nothing newer" cooldown so all
   * laggards are pulled at once. Use it when the primary looks wrong or stuck and
   * you want a second opinion. Tiingo's own hourly/daily budget still applies, so
   * any overflow simply defers; symbols already on a fresh value are left untouched.
   */
  private refreshViaBackupProvider(): void {
    this.exitSettings();
    this.toast("Trying the backup data provider…");
    // A deliberate hard refresh overrides any armed time-series backoff so every
    // graph symbol is re-attempted immediately on the backup provider.
    clearAllSeriesBackoff();
    this.pollLog(
      "note",
      "Hard refresh (Settings) — routing the whole book through the backup provider (Tiingo) for one pull.",
    );
    const session = this.sessionId;
    if (this.refreshing) return; // a pull is already in flight; it will repaint
    void this.runScheduledRefresh(session, "manual", { viaTiingo: true });
  }

  /**
   * Handle a manual tap of the Refresh button. Always gives immediate feedback
   * the user can actually see: it shows the spinning glyph + "Refreshing prices…"
   * pill for a guaranteed minimum (so a cache-fast refresh doesn't flash by),
   * and — crucially — acknowledges the tap *even when an automatic pull is
   * already in flight*, where the old code silently bailed and the button felt
   * dead. On completion it confirms the outcome with a brief toast.
   *
   * Two credit-savers guard the entry (see {@link manualRefreshDecision}):
   *  - a tiny cooldown swallows an accidental double-tap so it can't fire two
   *    forced pulls back-to-back; and
   *  - a tap that lands while an *automatic* pull is mid-flight promotes that
   *    round to a manual one rather than wasting a second overlapping fetch — the
   *    auto refresh is effectively stopped and its next tick pushed out by the
   *    full configured interval, so the tap takes priority and feels manual.
   */
  private manualRefresh(): void {
    const decision = manualRefreshDecision({
      refreshing: this.refreshing,
      inFlightKind: this.refreshingKind,
      lastManualAt: this.lastManualAt,
      now: Date.now(),
    });
    if (decision === "cooldown") {
      // An accidental double-tap (or a tap while a manual pull is still running):
      // acknowledge it on screen so the button doesn't feel dead, but spend no
      // credits on a second forced pull. Word it for which case it is: a refresh
      // still in flight vs. one that just finished moments ago.
      this.setUpdating(true, "manual");
      this.setUpdating(false, "manual");
      this.toast(
        this.refreshing ? "Refresh already in progress…" : "Just refreshed, showing the latest prices.",
      );
      return;
    }
    if (decision === "promote") {
      // An automatic pull is already running; we can't start a second overlapping
      // refresh, so hand it the manual baton: flash the manual feedback now and
      // let the in-flight round finish as a manual one (manual toast, and the
      // next auto-refresh pushed out by the full interval).
      this.lastManualAt = Date.now();
      this.promoteToManual = true;
      this.setUpdating(true, "manual");
      this.toast("Refreshing prices now…");
      return;
    }
    this.lastManualAt = Date.now();
    // No network link: skip the credit/market-phase logic (and its toasts) and
    // go straight to the offline handler, which repaints last-known values and
    // confirms the lack of connection honestly.
    if (!this.isOnline()) {
      void this.runScheduledRefresh(this.sessionId, "manual", { force: false });
      return;
    }
    // A manual tap means "pull new market values now". What that should fetch
    // depends on the market phase (see {@link currentRefreshPhase}):
    //   - market open   → only live stock prices can have moved (NAV is exempt
    //     anyway, since it cannot strike until the close);
    //   - post-close, pre-NAV → only the awaited NAVs are worth chasing (the
    //     stock closes are already in hand and stay quiet);
    //   - fully settled / pre-market / weekend → re-pull *everything*. The user
    //     only taps refresh outside market hours when unsure the cache is right,
    //     so verify the whole book from scratch rather than trust it.
    // Unless the daily free-tier budget is nearly spent (<10% left), where we
    // fall back to the normal cache-respecting refresh so the reserve isn't
    // burnt in one tap.
    const canForce = this.canForceRefresh();
    if (!canForce) {
      this.toast("Low on credits, showing recent prices.");
      void this.runScheduledRefresh(this.sessionId, "manual", { force: false });
      return;
    }
    const forceAll = this.currentRefreshPhase() === "settled";
    void this.runScheduledRefresh(this.sessionId, "manual", { force: true, forceAll });
  }

  /**
   * Whether enough of the daily free-tier credit budget remains to honour a
   * manual "pull now" with a forced live fetch. Below
   * {@link FORCE_REFRESH_MIN_CREDIT_FRACTION} of the day's budget a tap serves
   * the cache instead, so the last credits aren't spent all at once.
   */
  private canForceRefresh(): boolean {
    const now = Date.now();
    const used = creditsSpentToday(readCreditLog(now, 24 * 60 * 60 * 1000), now);
    const remaining = Math.max(0, FREE_TIER.creditsPerDay - used);
    return remaining >= FREE_TIER.creditsPerDay * FORCE_REFRESH_MIN_CREDIT_FRACTION;
  }

  /**
   * Whether at least one NAV-priced fund is still missing the latest settled
   * session's NAV — i.e. we are demonstrably behind. Judged exactly like the
   * per-symbol manual skip in {@link buildQuoteOptions}: the cached value-date
   * against {@link latestSettledSessionDate}. After the close that settled session
   * is today's just-shut one (whose NAV has not struck yet), so this is true
   * through the post-close "still awaiting tonight's NAVs" window; while the
   * market is open it compares against the prior session, which we already hold.
   */
  private navOutstanding(now: Date = new Date()): boolean {
    const navSymbols = readSymbolPlan()
      .filter((e) => e.priceType !== "market")
      .map((e) => e.symbol);
    if (navSymbols.length === 0) return false;
    const cached = readCachedQuotes();
    const settled = latestSettledSessionDate(now);
    return navSymbols.some((symbol) => {
      const have = cached.get(symbol)?.quote.valueDate ?? null;
      return !(have && have >= settled);
    });
  }

  /**
   * Whether at least one **market** (stock/ETF) symbol is missing the latest
   * already-settled close — either its cached value-date is older than
   * {@link latestSettledSessionDate}, it has no cached price at all, or all we
   * hold is a mid-session intraday print (not yet the official close). Mirrors
   * the per-symbol catch-up in {@link marketCacheTtlMs} via {@link holdsSettledClose}:
   * while the exchange is shut we normally rest, *unless* we don't actually hold
   * that settled close yet (offline across it, or only an intraday capture), in
   * which case it is genuinely outdated and must still be fetched.
   */
  private marketDataOutdated(now: Date = new Date()): boolean {
    const marketSymbols = readSymbolPlan()
      .filter((e) => e.priceType === "market")
      .map((e) => e.symbol);
    if (marketSymbols.length === 0) return false;
    const cached = readCachedQuotes();
    const settled = latestSettledSessionDate(now);
    return marketSymbols.some((symbol) => {
      // Outdated unless we hold the *settled* close — an intraday-only print
      // (captured before the bell) still needs one post-close fetch.
      return !holdsSettledClose(cached.get(symbol)?.quote, settled);
    });
  }

  /**
   * Classify the current refresh situation (see {@link RefreshPhase}) from the
   * live market clock plus {@link navOutstanding}. Both the manual tap and the
   * automatic scheduler key their fetch decisions off this.
   */
  private currentRefreshPhase(now: Date = new Date()): RefreshPhase {
    return classifyRefreshPhase({
      marketOpen: isUsMarketOpen(now),
      navOutstanding: this.navOutstanding(now),
    });
  }

  /**
   * Whether the whole book is genuinely current and there is nothing to fetch:
   * the {@link RefreshPhase} is `settled` (market closed, every NAV in hand)
   * *and* every market close is also in hand ({@link marketDataOutdated} is
   * false). This is the only state in which the automatic scheduler skips its
   * pull — so a closed-market session whose cached close is stale (e.g. the app
   * was offline across the close) still refreshes automatically instead of being
   * stranded on old data.
   */
  private fullyUpToDate(now: Date = new Date()): boolean {
    return this.currentRefreshPhase(now) === "settled" && !this.marketDataOutdated(now);
  }

  /**
   * The "up to date" window in ms: one auto-refresh cycle
   * (`config.updateMinutes`). See the module note above {@link App}.
   */
  private upToDateWindowMs(): number {
    return this.state.config.updateMinutes * 60 * 1000;
  }

  /**
   * Whether the app actually pulled fresh data from the network recently enough
   * to honestly claim holdings are "up to date" (see {@link App.upToDateWindowMs}).
   * Gating the coverage summary on this means a refresh fully served from cache
   * never falsely reports everything current.
   */
  private recentlyPulled(): boolean {
    return this.lastDataPullAt !== null && Date.now() - this.lastDataPullAt < this.upToDateWindowMs();
  }

  /**
   * Whether the device currently believes it has a network link. A `false` from
   * `navigator.onLine` is authoritative ("definitely offline"); a `true` is only
   * a hint (the link may still be dead), so the post-fetch {@link classifyConnectivity}
   * still catches the "online but no price service answered" case.
   */
  private isOnline(): boolean {
    return typeof navigator === "undefined" || navigator.onLine !== false;
  }

  /**
   * Handle a refresh tick fired while the device is offline: repaint the held
   * values behind an honest "No internet connection" banner instead of running a
   * fetch-less round that would read as "up to date". A manual tap also gets a
   * confirming toast. The auto-refresh loop is kept alive so it resumes the
   * moment connectivity returns (also nudged immediately by the `online` listener).
   */
  private handleNoNetwork(session: number, kind: RefreshKind): void {
    this.lastConnectivity = "offline";
    this.pollLog("refresh", `Refresh skipped (${kind}) — device offline. Showing last known prices.`, "warn");
    void this.refreshPrices(session, false, { connectivity: "offline" });
    if (isUserRefresh(kind)) this.toast(connectivityNotice("offline") ?? "No internet connection.");
    this.scheduleNext(session, this.state.config.updateMinutes * 60 * 1000);
  }

  /**
   * The delay (ms) until the **oldest still-fresh** market quote/FX reaches the
   * auto-update interval — the "jumpstart" cadence. When a round pulls nothing
   * because everything is still within its window, the next automatic refresh
   * should land exactly when the oldest held value *first* goes stale, not a full
   * interval after this tick. Example: interval 15 min, oldest quote 12 min old on
   * login ⇒ this returns ~3 min, so the schedule jumps then (and every 15 min
   * thereafter) instead of waiting 15 min from login.
   *
   * Only market-priced symbols and FX ride the minute-level interval, so NAV funds
   * (a market-day window) are excluded. Returns `null` when the cadence can't be
   * anchored (no data, a missing quote, or stale FX) — those cases want the normal
   * scheduler, which will pull rather than wait.
   */
  private msUntilOldestFreshExpires(now: Date): number | null {
    const data = this.state.data;
    if (!data) return null;
    const intervalMs = this.state.config.updateMinutes * 60 * 1000;
    const nowMs = now.getTime();
    const plan = buildFetchPlan(data, FETCHABLE_NAV_CLASSES);
    const cached = readCachedQuotes();
    let oldestAt: number | null = null;
    for (const entry of plan) {
      // NAV funds ride a market-day window, not the minute cadence — skip them.
      if (entry.priceType !== "market") continue;
      const at = cached.get(entry.symbol)?.quote?.at ?? null;
      if (at === null) return null; // a missing quote isn't "fresh" — let the scheduler pull.
      if (oldestAt === null || at < oldestAt) oldestAt = at;
    }
    const fxCached = readCachedEurUsd();
    if (!fxCached || fxCached.now === null) return null;
    if (oldestAt === null || fxCached.at < oldestAt) oldestAt = fxCached.at;
    return Math.max(0, oldestAt + intervalMs - nowMs);
  }

  /**
   * One auto-refresh tick: do a live refresh and schedule the next one. On
   * startup, while symbols are still being filled in (deferred to stay within
   * the free-tier per-minute budget), it bursts roughly once a minute so every
   * holding reaches its latest price as fast as the rate limit allows; once
   * nothing is deferred it relaxes to the configured steady-state cadence. Paused
   * while the tab is hidden (resumed by the visibility listener).
   */
  private async runScheduledRefresh(
    session: number,
    kind: RefreshKind = "auto",
    opts: { force?: boolean; forceAll?: boolean; viaTiingo?: boolean; tiingoReserve?: number; startup?: boolean; kickoff?: boolean; primeGraphs?: boolean } = {},
  ): Promise<void> {
    // A manual tap (and the post-unlock kickoff) refreshes even when the tab is
    // technically "hidden" (e.g. mid-transition right after a fingerprint
    // unlock); only an ordinary automatic tick skips a hidden tab. Crucially a
    // hidden skip still re-arms the next tick — otherwise a single dropped tick
    // would silently kill the whole auto-refresh loop and no price update would
    // ever fire until a manual tap (see {@link refreshTickAction}).
    const action = refreshTickAction({
      sessionMatches: session === this.sessionId,
      kind,
      hidden: typeof document !== "undefined" && document.hidden,
      kickoff: opts.kickoff ?? false,
    });
    if (action === "stop") return;
    if (action === "defer") {
      this.scheduleNext(session, this.state.config.updateMinutes * 60 * 1000);
      return;
    }
    if (this.refreshing) return;
    // No *automatic* price pull once the book is fully up to date — the market is
    // closed and every settled close *and* today's NAV is already in hand. There
    // is nothing new to fetch, so spending credits (and re-polling FX) would be
    // pure waste. Keep only the near-free new-data probe and a slow heartbeat
    // that notices the next session open / NAV publish. Crucially this skips
    // *only* when the data is genuinely current: a closed market whose cached
    // close is stale (offline across the close) still refreshes here. A manual
    // tap is never skipped — it forces a full verification re-pull.
    if ((kind === "auto" || kind === "start") && this.fullyUpToDate()) {
      if (this.blobCheckDue()) void this.maybeRefreshBlob(session);
      this.scheduleNext(session, SETTLED_HEARTBEAT_MS);
      this.pollLog(
        "refresh",
        "Auto tick skipped — book fully up to date (market closed, all closes + NAVs held). Heartbeat only.",
        "warn",
      );
      return;
    }
    // No network link at all: don't pretend to "update". Skipping the network
    // pass entirely is the honest signal — a cache-fresh book would otherwise
    // sail through a fetch-less round and read as "up to date", hiding that we
    // are offline. Repaint the held values behind a clear "No internet
    // connection" banner, confirm it on a manual tap, and keep the loop alive
    // (the `online` listener pulls fresh prices the instant the link returns).
    if (!this.isOnline()) {
      this.handleNoNetwork(session, kind);
      return;
    }
    this.refreshing = true;
    this.refreshingKind = kind;
    // A fresh round clears any stale promotion request from a prior round; a tap
    // landing *during* this round will re-set it below.
    if (kind === "manual") this.promoteToManual = false;
    // Coalesce the login warm-up with this kickoff: if the warm-up is still
    // priming the shared caches, let it finish *before* we start the network
    // pass. Otherwise the two race the same per-minute budget — both pulling FX
    // and quotes independently — splitting the minute awkwardly and double-pulling
    // symbols the warm-up was about to cache. Awaiting it means this kickoff reads
    // the warm cache (FX already in line first) instead. Only the kickoff waits;
    // ordinary auto ticks see an already-settled promise (a no-op).
    if ((opts.kickoff ?? false) && this.prefetchPromise) {
      await this.prefetchPromise.catch(() => undefined);
      if (session !== this.sessionId) {
        this.refreshing = false;
        this.refreshingKind = null;
        return;
      }
      // Pillar 2 (WS5) — the **post-decrypt reconcile**. Step 1 (the prefetch) ran
      // against the *predicted* (last-known) holdings; now the decrypted blob has
      // revealed the truth. Diff the real book — the symbols (and FX) the freshness
      // ledger still considers stale ({@link staleFetchSymbols} / {@link isFxStale})
      // — against what Step 1 booked, so the diff names only what is genuinely still
      // needed (e.g. a newly-bought symbol the prediction never knew) and never a
      // symbol the prefetch already paid for. Logged whether or not there is work,
      // so a re-login no-op is visible too. The kickoff refresh below executes that
      // same ledger (its per-symbol cache TTL skips the booked-and-fresh symbols),
      // so the diff is the decision of record, not a misleading log.
      if (this.prefetchBooked !== null) {
        const reconcileNow = new Date();
        const diff = reconcileHandshake(this.prefetchBooked, {
          staleSymbols: this.staleFetchSymbols(isUsMarketOpen(reconcileNow), reconcileNow),
          fxStale: this.isFxStale(reconcileNow),
          currencyMismatches: this.currencyMismatchSymbols(),
        });
        // The reconcile is a round-orchestration decision (Pillar 2 / WS5), the
        // sibling of the "Round decision" log below — keep it in the orchestrator
        // category so the trail groups every single-brain verdict together rather
        // than scattering one of them under session-lifecycle "login".
        this.pollLog("orchestrator", diff.reason);
        // C6: a wrongly-denominated primed quote must be re-pulled — queue the
        // mismatch symbols so the round below genuinely refetches them.
        if (diff.currencyMismatches.length > 0) {
          this.enqueueDeferred(diff.currencyMismatches, "currency mismatch vs. pre-decrypt plan");
        }
        this.prefetchBooked = null;
      }
    }
    // C9 / freshness-plan §3 — drain the deferred work-queue: clear entries a fresh
    // cached/blob value already satisfies (logged, no re-fetch) and surface the
    // genuinely-still-missing ones (their cache is stale). These are threaded into
    // this round's fetch set below as an explicit force, so a parked-but-stale
    // symbol is re-pulled now rather than relying on its cache TTL alone. Never
    // lets a deferral vanish unlogged.
    const drainedStale = this.drainDeferredQueue(new Date());
    // Smart Tiingo gate — run on **any** network round, not just one explicitly
    // flagged Tiingo-leaning: any force/auto refresh can quietly fall back to
    // Tiingo for the symbols Twelve Data defers, so the dedup must fire whenever a
    // round *might* lean on Tiingo (docs/tiingo_polling_storm_cleanup_plan.md item
    // 5a). Pull any *stale* 1D/1W graph package first — each bar's newest point
    // doubles as the quote, so priming the holdings' quote cache from those bars
    // makes the quote pull below skip them, so Tiingo is never spent on both the
    // rapid-fire quote *and* the 1D/1W graph for one symbol.
    //
    // Pillar 1/4 (WS-part-2): this is **no longer a standing pre-step that fires
    // every round** — it is dissolved into the orchestrator's freshness decision.
    // Pillar 1 — compute the **one** orchestrator plan for this whole round, keyed
    // on the real freshness ledger (incl. the runtime-active best-available
    // `blobDaysOld` from blob metadata + the post-decrypt re-engage overlay). The
    // single plan governs *both* the 1D/1W bar gate (below) and the quote / NAV / FX
    // legs (in {@link refreshPrices}), so bars are never decided — or pulled — twice
    // and the two gates can never disagree.
    // C4 — on the login kickoff, await the cheap blob-meta probe so the round's
    // `blobDaysOld` reflects the *remote* recency before the heavy spend decision.
    // A fresh remote blob that already covers the gap then stops the kickoff
    // re-pulling market credits. Time-boxed, render-free, kickoff-only (ordinary
    // ticks must not pay a probe latency every cadence).
    if (opts.kickoff ?? false) {
      await this.refreshBlobMeta(session);
      if (session !== this.sessionId) {
        this.refreshing = false;
        this.refreshingKind = null;
        return;
      }
    }
    const now = new Date();
    const roundPlan = this.planRoundPull(kind, opts, now);
    this.pollLog("orchestrator", `Round decision (${kind}): ${describePlan(roundPlan)}`);
    // During market hours the clock-hour bar gate ({@link graphPrimeDecision},
    // reading this same plan) is the sole 1D-bar authority, so the prime runs at
    // most once per `:00` instead of self-perpetuating each tick; a reset/force-all
    // still primes in full, and a closed-market round still self-gates on staleness
    // inside the prime.
    {
      const decision = this.graphPrimeDecision(kind, opts, roundPlan, now);
      this.pollLog("graph", `Graph-prime decision (${kind}): ${decision.reason}`);
      if (decision.due) {
        const stored = await this.primeStaleGraphPackages().catch(() => undefined);
        if (session !== this.sessionId) {
          this.refreshing = false;
          this.refreshingKind = null;
          return;
        }
        // Stamp the clock-hour gate only when a market-hours prime actually pulled
        // bars, so the next bar is held until the next `:00` (breadcrumbs bridge).
        if (decision.market === "open" && typeof stored === "number" && stored > 0) {
          this.lastBarPrimeMs = Date.now();
          this.pollLog("graph", `Graph-prime pulled ${stored} series; next 1D bar held until the next clock hour.`);
        }
      }
    }
    // Describe what kicked off this round for the downloadable polling log: the
    // trigger (manual tap / auto tick / startup burst / post-unlock kickoff) and
    // any escape-hatch flags in play, so the trail explains *why* a pull ran.
    const triggers = [
      opts.kickoff ? "kickoff" : null,
      opts.startup ? "startup-burst" : null,
      opts.viaTiingo ? "via-backup" : null,
      opts.forceAll ? "force-all" : null,
      opts.force && !opts.forceAll ? "force" : null,
    ].filter((t): t is string => t !== null);
    this.pollLog(
      "refresh",
      `Refresh started: ${kind}${triggers.length ? ` (${triggers.join(", ")})` : ""}.`,
    );
    // The Refresh glyph spins for any genuinely in-flight fetch (see
    // {@link applyUpdating}), so a startup round that actually pulls data is
    // visible on its own. We deliberately *don't* force a guaranteed-visible
    // manual-style spin on startup any more: that made the button spin at every
    // login even when the prefetch had already made the book as fresh as
    // possible, so the spin meant nothing. The honest login signal now lives in
    // {@link maybeSignalPrefetchSpin}, which spins once only when the prefetch
    // actually fetched something newer.
    const feedbackKind: RefreshKind = kind;
    this.setUpdating(true, feedbackKind);
    let report: QuoteLoadReport | null = null;
    try {
      report = await this.refreshPrices(session, true, {
        force: opts.force ?? false,
        forceAll: opts.forceAll ?? false,
        viaTiingo: opts.viaTiingo ?? false,
        tiingoReserve: opts.tiingoReserve ?? 0,
        plan: roundPlan,
        forceSymbols: drainedStale,
      });
    } finally {
      this.refreshing = false;
      this.refreshingKind = null;
    }
    if (session !== this.sessionId || report === null) {
      this.promoteToManual = false;
      this.setUpdating(false, feedbackKind);
      return;
    }
    // A manual tap that landed while this (automatic) round was in flight promotes
    // it to a manual refresh: from here on it gets the manual completion toast and
    // pushes the next auto-refresh out by the full configured interval, so the
    // user's tap takes priority and the automatic schedule is effectively reset —
    // all without a second overlapping pull draining more credits.
    const promoted = this.promoteToManual;
    this.promoteToManual = false;
    const effectiveKind: RefreshKind = promoted ? "manual" : kind;
    // The live refresh for this round is done: take the status pill down. While
    // a >per-minute-cap portfolio is still filling in we used to keep the pill
    // (with a live "N of M" count) up *between* burst rounds, but that left it
    // hovering on screen for seconds at a time — too much. The Refresh glyph
    // still spins during each actual fetch, and the per-row "as of" chips show
    // which holdings are still on last-known values, so the staged fill stays
    // visible without a persistent floating banner.
    this.setUpdating(false, effectiveKind);
    // Confirm the outcome of a manual tap so the user understands what happened
    // (fresh prices pulled, already up to date, or some deferred by the budget).
    if (isUserRefresh(effectiveKind)) {
      const connectivityToast = connectivityNotice(this.lastConnectivity);
      // No service answered (offline, or every provider failed): say so plainly
      // rather than a coverage summary that would read like a successful pull.
      if (connectivityToast) {
        this.toast(connectivityToast);
      } else if (this.lastTiingoError) {
        // A failed backup is the most actionable thing to say on a manual tap —
        // especially the "Try the backup data provider now" button — so lead with
        // it when the Tiingo backup couldn't be reached this round.
        this.toast(describeTiingoError(this.lastTiingoError));
      } else {
        this.toast(
          this.lastCoverageFacts
            ? manualRefreshSummary(this.lastCoverageFacts)
            : `Couldn't reach live prices, ${SHOWING_LAST_KNOWN}.`,
        );
      }
    }
    // "Prices all live" confirmation: when a portfolio is too big to price in a
    // single round it fills in over several burst rounds (the free-tier
    // per-minute cap). The moment the *last* still-deferred holding catches up —
    // i.e. we go from "some deferred" to "all live" — pop a brief confirmation
    // so the staged fill ends with a clear "you're fully up to date" signal
    // instead of silently stopping. Tracked across rounds so a portfolio that
    // was live all along stays quiet, and it only fires on the transition.
    // Suppressed when no service actually answered, so a cache-served round is
    // never mis-announced as a fresh "all prices live".
    const nowAllLive = allPricesLive(report) && this.lastConnectivity === "online";
    // Only the automatic scheduler pops this — a manual tap already gets the
    // descriptive manualRefreshSummary toast above (e.g. "All 18 holdings up to
    // date"), so firing both would double up.
    if (nowAllLive && !this.pricesAllLive && !isUserRefresh(effectiveKind)) {
      this.toast("All prices live, every holding is now on a fresh price.");
    }
    this.pricesAllLive = nowAllLive;
    // C9 — track this round's budget-deferred symbols on the work-queue so the
    // next round explicitly drains them (or clears them once the blob/cache covers
    // them), rather than silently relying on each symbol's cache TTL to re-pull.
    if (report.deferred.length > 0) this.enqueueDeferred(report.deferred, `${effectiveKind} round over budget`);
    let delayMs = nextRefreshDelayMs({
      deferred: report.deferred,
      // Pace auto-refresh out as the rolling daily free-tier budget runs low.
      dayRemaining: report.dayRemaining,
      dayLimit: FREE_TIER.creditsPerDay,
    }, {
      // The steady-state cadence is user-configurable. After an off-cycle manual
      // tap this is also the gap before the next automatic refresh, so a manual
      // pull cleanly pushes the auto schedule out by the configured interval.
      slowIntervalMs: this.state.config.updateMinutes * 60 * 1000,
    });
    // A tap that took over an in-flight auto pull (promotion) must push the next
    // *automatic* refresh out by the full configured interval — never a ~1-minute
    // burst — so the manual refresh genuinely supersedes the auto schedule instead
    // of letting it resume seconds later.
    if (promoted) {
      delayMs = Math.max(delayMs, this.state.config.updateMinutes * 60 * 1000);
    }
    // Jumpstart: when this round settled with nothing deferred — typically a login
    // round that pulled nothing because everything was still fresh — don't wait a
    // full interval. Land the next automatic refresh when the *oldest* still-fresh
    // value first reaches the auto-update window, so a 12-min-old book on a 15-min
    // interval refreshes in ~3 min, then every 15 min after. A full pull leaves the
    // oldest value ≈now, so this naturally equals the steady interval (no change).
    if (report.deferred.length === 0 && !promoted) {
      const jumpMs = this.msUntilOldestFreshExpires(new Date());
      if (jumpMs !== null) delayMs = Math.min(delayMs, jumpMs);
    }
    // Idea A — near-free freshness polling: piggy-back the cheap meta/304 blob
    // check so a fresh desktop publish is picked up automatically within a few
    // minutes, without the user reopening the app. A *manual* tap always checks
    // (the user is asking "is there anything new?"), and an automatic round
    // checks once it has settled into the slow cadence (nothing deferred) so it
    // doesn't compete with the startup burst. To keep the automatic check alive
    // for portfolios whose prices never fully stop deferring (more symbols than
    // the budget), it also runs on a slow wall-clock cadence regardless.
    if (isUserRefresh(effectiveKind) || report.deferred.length === 0 || this.blobCheckDue()) {
      void this.maybeRefreshBlob(session);
    }
    this.scheduleNext(session, delayMs);
    // The round's closing verdict — the single line that answers, at a glance,
    // "what settled, what failed, did we back off, and how much budget is left?".
    // The renderer lifts this into each round's footer banner, so it doubles as
    // the human summary of the whole pull. Keep the "Round complete" prefix and
    // the "Budget left N/min · M/day" shape stable: the log formatter keys its
    // round-grouping and macro budget read-out off them.
    const tiingo = tiingoBudgetView(Date.now());
    const settledParts = [
      `${report.fetched.length} live`,
      `${report.servedFresh.length} cached`,
      `${report.deferred.length} deferred`,
      `${report.failed.length} failed`,
    ];
    // A round with suspect (non-positive) prices is as much "wrong data" as an
    // outright failure, so call it out in the verdict and colour the line red.
    const suspectCount = this.lastSuspectSymbols.length;
    if (suspectCount > 0) settledParts.push(`${suspectCount} suspect`);
    const tiingoTail =
      tiingo.dayUsed > 0 || tiingo.hourUsed > 0
        ? `; backup ${tiingo.hourUsed}/${tiingo.hourLimit} this hour · ${tiingo.dayUsed}/${tiingo.dayLimit} today`
        : "";
    const finishLevel: PollLogLevel =
      report.failed.length > 0 || suspectCount > 0 ? "error" : report.deferred.length > 0 ? "warn" : "good";
    this.pollLog(
      "schedule",
      `Round complete (${effectiveKind}${promoted ? ", promoted from auto" : ""}): ${settledParts.join(", ")}. ` +
        `Budget left ${report.minuteRemaining}/min · ${report.dayRemaining}/day${tiingoTail}. ` +
        `Next auto-refresh in ~${Math.round(delayMs / 1000)}s` +
        `${report.deferred.length > 0 && !promoted ? " (burst to catch up)" : ""}.`,
      finishLevel,
    );
  }

  /**
   * Whether enough wall-clock time has passed since the last background blob
   * check to run another automatic one. The cadence is the user's configured
   * **auto-update interval** — that setting is the single knob for "how often do
   * you look for new data", covering both live prices *and* a fresh desktop
   * export — floored by {@link BLOB_CHECK_MIN_INTERVAL_MS} so a very low interval
   * can't spam the blob host every tick. A manual refresh bypasses this entirely
   * (it always checks; see {@link runScheduledRefresh}).
   */
  private blobCheckDue(): boolean {
    const intervalMs = Math.max(
      BLOB_CHECK_MIN_INTERVAL_MS,
      this.state.config.updateMinutes * 60 * 1000,
    );
    return Date.now() - this.lastBlobCheckAt >= intervalMs;
  }

  /** Arm the next auto-refresh tick, replacing any pending one. */
  private scheduleNext(session: number, delayMs: number): void {
    this.clearRefreshTimer();
    this.refreshTimer = setTimeout(() => void this.runScheduledRefresh(session), delayMs);
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Pause auto-refresh while the tab is hidden (no wasted credits in the
   * background) and do an immediate, cache-cheap refresh when it returns to the
   * foreground — exactly when the user wants the freshest data.
   */
  private installVisibilityRefresh(session: number): void {
    this.removeVisibilityRefresh();
    if (typeof document === "undefined") return;
    const handler = (): void => {
      if (session !== this.sessionId) return;
      if (document.hidden) this.clearRefreshTimer();
      else void this.runScheduledRefresh(session);
    };
    document.addEventListener("visibilitychange", handler);
    this.visibilityHandler = handler;
    // Belt-and-braces: a `pageshow` (incl. a bfcache restore) also resumes the
    // refresh. On some mobile browsers reopening a backgrounded PWA — or coming
    // back from the platform fingerprint sheet — doesn't fire a dependable
    // `visibilitychange`, which used to leave the dashboard sitting on stale
    // prices with no update. `runScheduledRefresh` guards against overlap, so a
    // duplicate trigger is harmless.
    if (typeof window !== "undefined") {
      const onShow = (): void => {
        if (session !== this.sessionId) return;
        if (typeof document !== "undefined" && document.hidden) return;
        void this.runScheduledRefresh(session);
      };
      window.addEventListener("pageshow", onShow);
      this.pageShowHandler = onShow;
      // The instant the device regains a network link, pull fresh prices rather
      // than waiting out the slow cadence — a dashboard parked on "No internet
      // connection" then updates the moment connectivity is back. Pillar 6 routes
      // `online` (like `visibilitychange`/`pageshow`) through the **`auto`**
      // mechanism — one funnel, fully gated by the freshness ledger — rather than
      // masquerading as a user `manual` tap (which would force-pull and surface
      // manual-only toasts for an event the user never triggered).
      const onOnline = (): void => {
        if (session !== this.sessionId) return;
        if (typeof document !== "undefined" && document.hidden) return;
        this.pollLog("refresh", "Network link returned → auto refresh (online listener).");
        void this.runScheduledRefresh(session, "auto");
      };
      window.addEventListener("online", onOnline);
      this.onlineHandler = onOnline;
    }
  }

  private removeVisibilityRefresh(): void {
    if (this.visibilityHandler && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
    }
    this.visibilityHandler = null;
    if (this.pageShowHandler && typeof window !== "undefined") {
      window.removeEventListener("pageshow", this.pageShowHandler);
    }
    this.pageShowHandler = null;
    if (this.onlineHandler && typeof window !== "undefined") {
      window.removeEventListener("online", this.onlineHandler);
    }
    this.onlineHandler = null;
  }

  /**
   * Toggle a small status pill while a live refresh runs, distinguishing a
   * manual tap of the Refresh button from an automatic background pull so the
   * user can see *both* that their tap registered and that the auto-refresh
   * keeps working on its own. A manual refresh additionally spins the Refresh
   * button's glyph for immediate, in-place feedback at the point of the tap.
   *
   * For manual refreshes the feedback is held on screen for at least
   * {@link MANUAL_REFRESH_MIN_FEEDBACK_MS}: a refresh fully served from cache
   * completes in a few milliseconds, so without this floor the pill + spinner
   * would appear and vanish within a single frame and a phone tap would look
   * like nothing happened at all.
   */
  private setUpdating(on: boolean, kind: RefreshKind = "auto", detail: string | null = null): void {
    if (typeof document === "undefined") return;
    if (isUserRefresh(kind)) {
      if (on) {
        // (Re)start the minimum-visible window and cancel any pending teardown
        // so a fresh tap can't be torn down by a previous refresh's timer.
        this.manualFeedbackUntil = Date.now() + MANUAL_REFRESH_MIN_FEEDBACK_MS;
        this.clearManualFeedbackTimer();
      } else {
        const remaining = this.manualFeedbackUntil - Date.now();
        if (remaining > 0) {
          // Too soon to be seen — defer the teardown until the floor elapses.
          if (this.manualFeedbackTimer === null) {
            this.manualFeedbackTimer = setTimeout(() => {
              this.manualFeedbackTimer = null;
              this.applyUpdating(false, "manual");
            }, remaining);
          }
          return;
        }
      }
    }
    this.applyUpdating(on, kind, detail);
  }

  private clearManualFeedbackTimer(): void {
    if (this.manualFeedbackTimer !== null) {
      clearTimeout(this.manualFeedbackTimer);
      this.manualFeedbackTimer = null;
    }
  }

  /** Actually add/remove the pill and toggle the glyph spin in the DOM. */
  private applyUpdating(on: boolean, kind: RefreshKind = "auto", detail: string | null = null): void {
    if (typeof document === "undefined") return;
    const glyph = document.querySelector('[data-action="refresh"] .icon-btn-glyph');
    // Spin the Refresh glyph for *any* in-flight update — automatic pulls too,
    // not just a manual tap — so the button visibly rotates while data loads
    // instead of the update being a silent, motionless pop-up.
    glyph?.classList.toggle("is-spinning", on);
    const id = "updating-pill";
    const existing = document.getElementById(id);
    if (on) {
      const base = isUserRefresh(kind) ? "Refreshing…" : "Auto-updating…";
      // Append a live "N of M" fill count when supplied, so a portfolio larger
      // than the per-minute budget shows visible progress across burst rounds.
      const label = detail ? `${base} ${detail}` : base;
      if (existing) {
        existing.classList.toggle("is-auto", !isUserRefresh(kind));
        const text = existing.querySelector(".updating-pill-text");
        if (text) text.textContent = label;
        return;
      }
      const pill = h(
        "div",
        { id, class: !isUserRefresh(kind) ? "updating-pill is-auto" : "updating-pill", role: "status", "aria-live": "polite" },
        [
          h("span", { class: "updating-pill-spinner", "aria-hidden": "true" }, []),
          h("span", { class: "updating-pill-text" }, [label]),
        ],
      );
      document.body.append(pill);
    } else {
      existing?.remove();
    }
  }

  /**
   * Record one line in the downloadable data-polling log (Settings → "Download
   * data polling log"). Best-effort and never throws into the refresh path — a
   * logging failure must not break a price pull. An optional `level` marks the
   * line's severity (a failure, a deliberate back-off, a clean success) so the
   * rendered trail can flag it; when omitted the renderer infers one from the
   * wording. See {@link appendPollLog}.
   */
  private pollLog(category: PollLogCategory, message: string, level?: PollLogLevel): void {
    try {
      appendPollLog(category, message, { level });
    } catch {
      /* logging is best-effort */
    }
  }

  /**
   * On boot, note in the polling log whenever the running app version differs
   * from the one this device last recorded — so a reader of a downloaded log can
   * see which build produced a given window, and spot the exact tick a new
   * deploy took effect (docs/tiingo_polling_storm_cleanup_plan.md item 6).
   * Best-effort: a missing/blocked localStorage simply skips the note.
   */
  private logVersionUpdate(): void {
    try {
      if (typeof localStorage === "undefined") return;
      const previous = localStorage.getItem(APP_VERSION_KEY);
      if (previous !== APP_VERSION) {
        this.pollLog(
          "note",
          previous
            ? `App updated — version ${previous} → ${APP_VERSION} on this device.`
            : `App version ${APP_VERSION} — first run recorded on this device.`,
        );
        localStorage.setItem(APP_VERSION_KEY, APP_VERSION);
      }
    } catch {
      /* version-stamping is best-effort */
    }
  }

  /**
   * Export the recorded data-polling log to a downloadable text file. Gives the
   * user a detailed, timestamped trail of exactly what every refresh did — which
   * symbols were served from cache, fetched live, or filled from the fallback,
   * the budgets at each step, the blob checks — for transparency and debugging.
   */
  private downloadPollLog(): void {
    try {
      const text = formatPollLog(readPollLog(), { version: APP_VERSION });
      const blob = new Blob([text], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = h("a", { href: url, download: "investment-overview-polling-log.txt" }) as HTMLAnchorElement;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      this.toast("Polling log downloaded.");
    } catch {
      this.toast("Couldn't export the polling log on this device.");
    }
  }

  /** Clear the recorded data-polling log (Settings → "Clear polling log"). */
  private clearPollLogNow(): void {
    clearPollLog();
    this.pollLog("note", "Polling log cleared by the user.");
    this.toast("Polling log cleared.");
  }

  /** A brief, auto-dismissing status message (e.g. biometric enrolment result). */
  private toast(message: string): void {
    if (typeof document === "undefined") return;
    const node = h("div", { class: "app-toast", role: "status", "aria-live": "polite" }, [message]);
    document.body.append(node);
    setTimeout(() => node.remove(), TOAST_DURATION_MS);
  }

  /**
   * A login confirmation banner pinned to the *top* of the page. Unlike the
   * ordinary {@link toast} (which sits at the bottom, where the refreshing pill
   * and coverage toasts also live), this sits up top so it never hides an
   * incoming "refreshing prices…" / coverage message — the two can be on screen
   * at once. Its sole job is to make a successful unlock unmistakably visible so
   * the user can see the app detected their login and is about to pull data.
   */
  private welcomeBanner(message: string): void {
    if (typeof document === "undefined") return;
    const id = "welcome-banner";
    document.getElementById(id)?.remove();
    const node = h("div", { id, class: "app-toast is-welcome", role: "status", "aria-live": "polite" }, [message]);
    document.body.append(node);
    setTimeout(() => node.remove(), WELCOME_BANNER_DURATION_MS);
  }

  /**
   * The symbols the primary genuinely *failed* to price this round and the Tiingo
   * backup didn't fill either — i.e. still stuck on a last-known value. Drives the
   * honest "couldn't get a live price for X" degradation clause. Budget-deferred
   * symbols are excluded (they were never attempted, just waiting their turn).
   */
  private unresolvedFailedSymbols(report: QuoteLoadReport): string[] {
    if (report.failed.length === 0) return [];
    const filled = new Set(this.lastTiingoSymbols);
    return report.failed.filter((symbol) => !filled.has(symbol));
  }

  /**
   * Fold a Twelve Data safety-net re-pull (the reverse Tiingo→TD fallback) back
   * into the round's primary quote result and report. Freshly-priced symbols are
   * merged into the quote map and moved from `deferred` into `fetched`; symbols
   * Twelve Data attempted but still couldn't price move from `deferred` into
   * `failed` (genuinely stuck on both providers). The budget counters are taken
   * from the safety-net pass (the most recent spend). Returns the symbols the
   * safety net actually filled, for the polling log. Mutates `quoteLoad`.
   */
  private absorbSafetyNet(
    quoteLoad: { quotes: Map<string, Quote>; report: QuoteLoadReport },
    tdNet: { quotes: Map<string, Quote>; report: QuoteLoadReport },
  ): string[] {
    const filled: string[] = [];
    const deferred = new Set(quoteLoad.report.deferred);
    for (const symbol of tdNet.report.fetched) {
      const quote = tdNet.quotes.get(symbol);
      if (!quote) continue;
      quoteLoad.quotes.set(symbol, quote);
      quoteLoad.report.fetched.push(symbol);
      deferred.delete(symbol);
      filled.push(symbol);
    }
    for (const symbol of tdNet.report.failed) {
      if (deferred.delete(symbol)) quoteLoad.report.failed.push(symbol);
    }
    quoteLoad.report.deferred = [...deferred];
    quoteLoad.report.minuteRemaining = tdNet.report.minuteRemaining;
    quoteLoad.report.dayRemaining = tdNet.report.dayRemaining;
    return filled;
  }

  /**
   * Summarise any live-data gaps for a non-blocking banner, framed around the
   * free-tier budget. Returns null when everything was fresh and within budget.
   */
  private describeDegradation(
    quote: QuoteLoadReport,
    fx: { cached: boolean; error: PriceError | null },
    tiingoError: PriceError | null = null,
    eurUsd: { eurUsdError: PriceError | null; eurUsdSource: EurUsdSource } = {
      eurUsdError: null,
      eurUsdSource: "none",
    },
    failedSymbols: readonly string[] = [],
    connectivity: ConnectivityState = "online",
  ): string | null {
    const reasons: string[] = [];

    // Lead with the honest connectivity headline when the round reached no price
    // service at all — the device is offline, or every provider failed to
    // respond (a dead link `navigator.onLine` failed to notice). This replaces
    // the generic "didn't refresh just now" clause below so the banner says
    // plainly *why* nothing moved, while the finer FX / backup / budget detail
    // still appends underneath.
    const notice = connectivityNotice(connectivity);
    if (notice) reasons.push(notice);

    // Daily free-tier budget: a distinct, useful signal — warn as it runs low
    // and clearly when it's gone, so the user understands why live updates are
    // spacing out or paused.
    if (quote.dayRemaining <= 0) {
      reasons.push(
        `Daily free-tier budget (${FREE_TIER.creditsPerDay}/day) used up; updates pause until it resets.`,
      );
    } else if (quote.dayRemaining <= dailyBudgetWarnCredits()) {
      reasons.push(
        `Close to today's free-tier limit (${quote.dayRemaining} of ${FREE_TIER.creditsPerDay} left); ` +
          `updates are spacing out to last the day.`,
      );
    }

    // A live-fetch gap. A rate limit (HTTP 429) and the *ordinary* staged fill
    // of a portfolio larger than the per-minute cap are the **same** underlying
    // situation — describe it once, not as two overlapping clauses. A genuine
    // staged fill isn't an error at all (the spinning glyph + "N of M" pill show
    // it as progress), so it raises no banner. The coverage note above already
    // states what we're showing, so these clauses give only the *reason* and
    // never repeat the "last known" tail.
    const rateLimited = quote.error?.status === 429;
    const stagedFill = quote.dayRemaining > 0 && quote.error === null;
    const deferredByMinute = quote.deferred.length > 0 && !stagedFill;
    if (quote.error && !rateLimited && notice === null) {
      // A real, non-rate-limit fetch problem (network blip, 404, 5xx). Skipped
      // when the connectivity headline already said no service was reachable.
      reasons.push("Didn't refresh just now.");
    } else if (rateLimited || deferredByMinute) {
      reasons.push("Waiting on the free-tier limit.");
    }

    // Only surface FX when it's genuinely unavailable; a cached rate within its
    // (12h) freshness window is normal and not worth nagging about. Two
    // independent failure paths feed this: the keyless ECB daily rate (`fx`)
    // and the live EUR/USD spot (`eurUsd`, including the Tiingo backup). The
    // live spot is degraded only when its fetch actually failed *and* we ended
    // up on a flat end-of-day rate or no rate at all (a fresh live/backup spot,
    // or a still-fresh cached one, is fine and stays silent). The coverage note
    // already carries an FX-freshness tail, so we only add a warn clause when FX
    // is genuinely *unavailable* — never restating a state the tail covers.
    const liveFxFailed =
      eurUsd.eurUsdError !== null &&
      (eurUsd.eurUsdSource === "eod" || eurUsd.eurUsdSource === "none");
    if (fx.error && !fx.cached) {
      // The keyless ECB daily rate itself failed with nothing cached: no FX at all.
      reasons.push("FX rates temporarily unavailable.");
    } else if (liveFxFailed) {
      reasons.push(
        eurUsd.eurUsdSource === "none"
          ? "FX rates temporarily unavailable; values may be incomplete."
          : "Live FX rate unavailable; using the last known rate.",
      );
    }

    // The Tiingo backup was needed this round but couldn't deliver. The shared
    // {@link describeTiingoError} keeps the banner and the manual toast in step.
    if (tiingoError) {
      reasons.push(describeTiingoError(tiingoError));
    }

    // Name the holdings the providers *tried* to price this round but couldn't —
    // a fund the primary returns no bar for (the FSKAX case) that the backup also
    // didn't fill. Only when the call otherwise succeeded (`quote.error === null`):
    // a whole-batch transient failure is already covered by the broad "didn't
    // refresh just now" clause above, so this stays specific to per-symbol
    // failures instead of repeating it. Without this, such a holding would sit on
    // a stale value with no explanation, looking like it is merely "awaiting".
    if (quote.error === null && failedSymbols.length > 0) {
      reasons.push(`No live price for ${failedSymbols.join(", ")}.`);
    }

    return reasons.length === 0 ? null : reasons.join(" ");
  }

  private renderDashboard(model: DashboardModel): void {
    this.model = model;
    // Mirror the configured regular investment amount into the render-layer store
    // so the USD investing-power panel can read it without threading config through.
    setInvestmentAmountEur(this.state.config.investmentAmountEur);
    this.mount(
      renderDashboard(
        model,
        () => this.manualRefresh(),
        () => this.lock(),
        () => this.reRenderCurrentModel(),
        () => this.showSettings(),
        "Lock",
        this.buildLiveGraphHooks(model),
        { holdingStatus: this.holdingStatusModel() },
      ),
    );
  }

  /**
   * The current per-holding update-status signals, threaded into the holdings
   * render so each card paints its place in the price-pull cycle: a quiet
   * "Updated <time>" stamp, the "Updating…" queued state, or the brief
   * "Updated ✓" success flash for symbols pulled within the last flash window.
   * Stale entries (older than the flash window) are pruned so the map stays small.
   */
  private holdingStatusModel(): HoldingStatusModel {
    const status = emptyHoldingStatusModel();
    const cutoff = Date.now() - HOLDING_UPDATED_FLASH_MS;
    for (const [symbol, at] of this.holdingUpdatedAt) {
      if (at < cutoff) this.holdingUpdatedAt.delete(symbol);
      else status.updatedAt.set(symbol, at);
    }
    for (const symbol of this.holdingQueued) {
      status.phases.set(symbol, "queued" satisfies HoldingLivePhase);
    }
    return status;
  }

  /**
   * Assemble the value chart's live 1D/1W builders from the current model +
   * config. Each hook lazily builds its whole-book curve via the already-shipped
   * {@link buildLiveSessionCurve}/{@link buildLiveWeekCurve} orchestration; the
   * bars are device-cached, so a re-open does not re-backfill.
   */
  private buildLiveGraphHooks(model: DashboardModel): LiveGraphHooks | undefined {
    const config = this.state.config;
    const o = model.overview;
    const baseFx = o.fxRateEurUsd;
    // The settled cash sleeve in both currencies (USD derived from the day's FX).
    const cashEur = o.cashValueEur;
    const cashUsd = baseFx !== null ? cashEur.times(baseFx) : cashEur;
    // Freeze the live 1D/1W graphs' EUR view to the session-close FX while the
    // market is shut, so their market-day trajectory does not slide with
    // overnight FX. While open, `frozenFx` is null and everything uses the live
    // rate exactly as before. The longer history graphs are built elsewhere
    // (renderValueChart) and deliberately keep the live after-hours rate.
    const marketClosed = !isUsMarketOpen();
    const sessionDay = lastSessionDate(new Date());
    const store = this.ensureTimeSeriesStore();
    // One shared procedure for BOTH the 1D and 1W graphs: read the session's FX
    // close straight from the EUR→USD bars the curves are reconstructed from, so
    // both freeze to the *same* authoritative close — and still have one when the
    // app was not live at 16:00 ET (the bars are backfilled regardless). Falls
    // back to the live-captured close, then the settled previous close, then the
    // live rate, so the curve always has a rate to anchor to. Memoised so the two
    // hooks resolve it once per render.
    let frozenFxMemo: Decimal | null | undefined;
    const resolveFrozenFx = async (): Promise<Decimal | null> => {
      if (!marketClosed) return null;
      if (frozenFxMemo !== undefined) return frozenFxMemo;
      const barsClose = await this.barsSessionCloseFx(sessionDay);
      frozenFxMemo = graphAnchorFx({
        marketOpen: false,
        liveFx: baseFx,
        // The FX bars are the ground truth the curve is drawn from; prefer them
        // so the frozen tip is continuous with the curve body, then the live
        // capture, then the settled previous close (a stable weekend/cold-start
        // proxy), then the live rate as a last resort.
        sessionCloseFx: barsClose ?? o.fxRateEurUsdSessionClose,
        settledPrevFx: o.fxRateEurUsdPrev,
      });
      return frozenFxMemo;
    };
    // The live tip drawn at the session close once shut: its USD leg is FX-free,
    // but its EUR leg is re-marked at the frozen close rate so the 1D/1W curve
    // ends on the market-day value, not the overnight-drifted one.
    const makeLiveTip = (frozenFx: Decimal | null): { valueEur: Decimal; valueUsd: Decimal } | null =>
      o.totalValueIsComplete
        ? ((): { valueEur: Decimal; valueUsd: Decimal } => {
            const valueUsd =
              o.totalValueUsd ?? (baseFx !== null ? o.totalValueEur.times(baseFx) : o.totalValueEur);
            const valueEur =
              frozenFx !== null && frozenFx.greaterThan(0) ? valueUsd.dividedBy(frozenFx) : o.totalValueEur;
            return { valueEur, valueUsd };
          })()
        : null;
    const reservation = ledgerReservation();
    const providers: LiveGraphProviders = {
      apiKey: config.apiKey,
      priceProxyUrl: resolvePriceProxyUrl(config),
      // Every metered graph request — bars, overflow, spill and both FX legs —
      // passes through the single reservation authority (audit Rec 4): it
      // atomically reserves each leg's credits against the live shared budgets
      // (Twelve Data per-minute/day + 429 freeze, Tiingo hourly/daily + freeze)
      // before the call fires, so Twelve Data fills first up to its budget, the
      // overflow goes to Tiingo only up to *its* scarce budget, and nothing ever
      // fires over a cap or while a provider is frozen.
      reservation,
    };
    const exported = this.state.data?.live_graphs ?? undefined;
    const anchor = (frozenFx: Decimal | null): ReturnType<typeof buildModelAnchor> =>
      buildModelAnchor(model.holdings, cashEur, cashUsd, baseFx, { graphFx: frozenFx });
    // The 1W anchor folds NAV funds into the sleeve (re-marked from their daily
    // NAV bars) rather than the flat base, so the week's NAV drift shows on the
    // curve for a NAV-heavy book (docs/tiingo_polling_storm_cleanup_plan.md item 7).
    const weekAnchor = (frozenFx: Decimal | null): ReturnType<typeof buildModelAnchor> =>
      buildModelAnchor(model.holdings, cashEur, cashUsd, baseFx, {
        navInSleeve: true,
        graphFx: frozenFx,
      });
    // Feed a graph's freshly fetched bars back into the holdings' quote cache so
    // a big load primes the rows instead of each re-buying the same price.
    const onFreshBars = (bars: Map<string, Bar[]>): void =>
      this.primeQuotesFromGraphBars(bars, model);

    // Providers whose spend recorders also write each graph pull to the Settings
    // data-polling log (and tally a per-build credit counter), so the user can
    // see exactly what each 1D/1W render pulled, from which provider, and when —
    // and, crucially, when a render pulled *nothing* because the bars were reused.
    const loggingProviders = (range: string, spent: { credits: number }): LiveGraphProviders => ({
      ...providers,
      ...instrumentedGraphRecorders({
        range,
        // The reservation authority is the sole booker, so the meters are
        // observation-only: they log/tally and trip the 429 breaker, and a
        // not-billed result releases the reservation rather than the raw ledger.
        bookTwelveData: () => undefined,
        refundTwelveData: (n) => reservation.release("twelvedata", n, Date.now()),
        bookTiingo: () => undefined,
        refundTiingo: (n) => reservation.release("tiingo", n, Date.now()),
        log: (message) => this.pollLog("graph", message),
        spent,
        // Trip/clear the per-provider 429 circuit breaker at the meter (WS4/WS5).
        onTwelveData429: () => recordTwelveData429(Date.now()),
        onTwelveDataSuccess: () => recordTwelveDataSuccess(),
        onTiingo429: () => recordTiingo429(Date.now()),
      }),
    });

    // The structured after-close resolution events (plan C6 + new-requirement FX
    // parity) fold straight into the same round-structured polling log as every
    // other pull: each verdict carries an explicit severity, so a settle shows a
    // `✓`, a still-filling step a `·`, and a both-sources outage a `↩` back-off —
    // and the symbol/instant read in plain language rather than raw epoch ms.
    const onCloseResolve = (event: CloseResolveLog): void =>
      this.pollLog("graph", event.message, event.level);
    // Render a bar instant as a compact `YYYY-MM-DD HH:MM` UTC stamp so the close
    // verdict names exactly which bar settled, without leaking a raw epoch.
    const formatInstant = (t: number): string =>
      new Date(t).toISOString().slice(0, 16).replace("T", " ");

    return {
      session: async (opts) => {
        const regenerateOnly = opts?.regenerateOnly ?? false;
        const frozenFx = await resolveFrozenFx();
        const liveTip = makeLiveTip(frozenFx);
        // Springboard off the exported session first — instant paint, no fetch —
        // and only build live when the export is absent or too stale.
        const sprung = springboardSessionCurve({ exported, liveTip });
        if (sprung) {
          this.pollLog("graph", "1D graph: reused the exported session (no live pull, 0 credits).");
          // Persist the sprung session's dense points as today's breadcrumb trail
          // so the *live* 1W path (when the week blob is too stale to springboard)
          // still has dense current-day detail to splice — otherwise a 1D that
          // springboarded off the blob would leave the store empty for today.
          await this.persistSprungSessionDetail(exported, store).catch(() => undefined);
          // The exported session is the desktop's settled whole-book curve, so it
          // is complete by construction — no coverage caption.
          return { points: sprung };
        }
        const spent = { credits: 0 };
        try {
          const curve = await buildLiveSessionCurve(
            { anchor: anchor(frozenFx), store, liveTip, onFreshBars, regenerateOnly, onCloseResolve, formatInstant },
            loggingProviders("1D", spent),
          );
          if (spent.credits === 0) {
            this.pollLog("graph", "1D graph: reused stored session bars (no live pull, 0 credits).");
          }
          if (curve.points.length < 2) return null;
          // Only surface the coverage caption once the market has shut: a full day
          // is expected by then, so a flat-for-want-of-bars holding is genuinely
          // worth flagging (scenario C). While open — and especially warming up —
          // partial coverage is normal and accrues tick-by-tick, so stay quiet.
          const coverage = curve.marketOpen ? undefined : curve.coverage;
          return { points: curve.points, coverage };
        } catch {
          this.pollLog("graph", "1D graph: live build failed — no curve drawn.", "warn");
          return null;
        }
      },
      week: async (opts) => {
        const regenerateOnly = opts?.regenerateOnly ?? false;
        const frozenFx = await resolveFrozenFx();
        const liveTip = makeLiveTip(frozenFx);
        // The current day's slice of the week must be the same dense 1D session the
        // 1D graph shows, not the coarse `week.points` tail. Build it once, network-
        // free (springboard off the blob, else reconstruct from stored bars), and
        // hand it to the springboard week builder so "1D fills 1W" holds on the fast
        // path too. The live `buildLiveWeekCurve` already enriches today from the
        // store, so it only needs this slice on the springboard branch.
        const todaySlice =
          springboardSessionCurve({ exported, liveTip }) ??
          (await buildLiveSessionCurve(
            { anchor: anchor(frozenFx), store, liveTip, regenerateOnly: true },
            loggingProviders("1D", { credits: 0 }),
          )
            .then((c) => (c.points.length >= 1 ? c.points : null))
            .catch(() => {
              // A store-only reconstruction should never throw, but if it does the
              // week still draws from its settled days + live tip — log so the
              // missing today detail can be diagnosed rather than swallowed silently.
              this.pollLog("graph", "1W graph: could not build today's 1D slice — using the live tip for today.");
              return null;
            }));
        const sprung = springboardWeekCurve({ exported, liveTip, todayCurve: todaySlice });
        if (sprung) {
          this.pollLog("graph", "1W graph: reused the exported week sleeve (no live pull, 0 credits).");
          return this.harvestWeekCloses(this.enrichWeekWithBlobSleeve(sprung, exported, baseFx));
        }
        const spent = { credits: 0 };
        try {
          const curve = await buildLiveWeekCurve(
            {
              anchor: weekAnchor(frozenFx),
              store,
              liveTip,
              onFreshBars,
              regenerateOnly,
              // Item 7b: only genuine, NAV-fetchable moving funds are eligible for
              // the daily-NAV gap-fill; money-market / pinned-$1 funds are absent
              // from `lastNavSymbols`, so they stay flat and are never fetched.
              navBackfillSymbols: [...this.lastNavSymbols],
              onNavBackfill: (symbols) =>
                this.pollLog(
                  "graph",
                  `1W graph: gap-filled NAV history for ${symbols.length} fund(s): ${symbols.join(", ")}.`,
                ),
              onCloseResolve,
              formatInstant,
            },
            loggingProviders("1W", spent),
          );
          if (spent.credits === 0) {
            this.pollLog("graph", "1W graph: reused stored week bars (no live pull, 0 credits).");
          }
          if (curve.points.length < 2) return null;
          return this.harvestWeekCloses(this.enrichWeekWithBlobSleeve(curve.points, exported, baseFx));
        } catch {
          this.pollLog("graph", "1W graph: live build failed — no curve drawn.", "warn");
          return null;
        }
      },
    };
  }

  /**
   * Persist the **springboarded** 1D session's dense points as today's breadcrumb
   * trail so the *live* 1W path has current-day detail to splice.
   *
   * When the 1D graph springboards straight off the blob it never fetches bars, so
   * the per-day store stays empty for today — and if the 1W blob is too stale to
   * springboard, `buildLiveWeekCurve`'s per-day enrichment would then find nothing
   * dense for the current day. Recording the exported session as today's
   * display-only breadcrumbs (the same trail mechanism the 1D/1W curves already
   * splice) closes that gap for nothing: each point is a value the desktop already
   * computed. Only ever writes today's session and never bumps `updatedAt`, so it
   * cannot fool the bar-refetch throttle. Best-effort: a store failure is swallowed.
   */
  private async persistSprungSessionDetail(
    exported: MobileExport["live_graphs"] | undefined,
    store: TimeSeriesStore,
  ): Promise<void> {
    const day = exported?.day;
    const sessionDate = day?.session_date;
    if (!day || !sessionDate || sessionDate !== lastSessionDate(new Date())) return;
    // Clamp to the session window before persisting: a blob can over-reach into
    // the prior trading day, and these breadcrumbs are spliced into a later live
    // build (mergeBreadcrumbs) — on a cold store the reconstruction is empty, so
    // an unclamped pre-open crumb would surface as yesterday's data on today's 1D
    // curve. Mirrors the springboard's own left-edge clamp.
    const openMs = sessionOpenMs(sessionDate);
    const points = parseExportedPoints(day.points).filter((p) => p.t >= openMs);
    if (points.length < 1) return;
    const existing =
      (await store.loadSession(sessionDate)) ??
      { day: sessionDate, bars: {}, fx: [], tips: [], updatedAt: 0 };
    // Don't clobber a richer live build: if the store already holds real bars or a
    // breadcrumb trail at least as dense as the export, leave it untouched.
    const hasBars = Object.values(existing.bars).some((b) => b.length > 0);
    if (hasBars || (existing.tips?.length ?? 0) >= points.length) return;
    const tips: Breadcrumb[] = points.map((p) => ({
      t: p.t,
      valueEur: p.valueEur,
      valueUsd: p.valueUsd,
    }));
    await store.saveSession({
      day: sessionDate,
      bars: existing.bars,
      fx: existing.fx,
      tips,
      // Breadcrumbs are not a bar fetch — leave the refetch throttle's stamp alone.
      updatedAt: existing.updatedAt,
    });
  }

  /**
   * WS7 — merge the web's reconstructed 1W curve with the blob's **v3 aggregate
   * market-sleeve backbone** (Pillar 3). Both sides speak the same FX-free sleeve
   * value over time, so they reconcile per grid slot: agreeing slots thicken the
   * line, a slot that disagrees beyond τ keeps the desktop-authoritative blob and
   * raises a **reconciliation flag** — surfaced verbatim in the polling log so the
   * owner can deep-dive *why* the two apps diverge instead of seeing a silently
   * averaged lie (the cross-app scenario this merge exists for).
   *
   * Degrades gracefully: a v1/v2 blob carries no `market_series`, so the web curve
   * is returned unchanged. The whole-book base is **auto-calibrated** from a real
   * web↔blob time overlap (so the constant cash + NAV base never has to be guessed
   * or double-counted), and the merged curve is only rendered when it is strictly
   * richer than the web curve and its live tip stays sane — otherwise the trusted
   * web curve is kept. Either way the reconciliation is fully logged.
   */
  private enrichWeekWithBlobSleeve(
    webCurve: CurvePoint[],
    exported: MobileExport["live_graphs"] | undefined,
    fallbackFx: Decimal | null,
  ): CurvePoint[] {
    if (!hasMarketSleeve(exported) || webCurve.length < 2) return webCurve;
    const blobSleeve = parseMarketSeries(exported?.market_series);
    if (blobSleeve.length < 2) return webCurve;

    // Auto-calibrate the constant whole-book base (cash + NAV) from the closest
    // web↔blob time overlap: base = webValue − blobSleeveValue at that instant. By
    // reading the base off the actual rendered web curve we sidestep the
    // NAV-in-sleeve vs NAV-in-base ambiguity entirely and align the two series.
    const overlap = this.calibrateSleeveBase(webCurve, blobSleeve);
    if (!overlap) {
      this.pollLog("graph", "1W merge: no web↔blob time overlap to calibrate the base — kept the web curve.");
      return webCurve;
    }
    const { baseUsd, baseEur } = overlap;
    const webSleeve: SleevePoint[] = webCurve.map((p) => {
      const valueNativeUsd = p.valueUsd.minus(baseUsd);
      const valueNativeEur = p.valueEur.minus(baseEur);
      // The sleeve's true per-instant FX (USD/EUR) is the ratio of the *sleeve-only*
      // values — after the calibrated whole-book base is removed from both currencies.
      // Using the whole-book ratio would fold the constant cash + NAV base into the
      // rate and skew the EUR line wherever a web point survives the merge.
      return {
        t: p.t,
        valueNativeUsd,
        fxEurUsd: valueNativeEur.gt(0) ? valueNativeUsd.div(valueNativeEur) : fallbackFx,
      };
    });

    const gridMs = exported?.grid === "15m" ? 15 * 60 * 1000 : 30 * 60 * 1000;
    const merge = mergeSleeveSeries(webSleeve, blobSleeve, { gridMs });
    this.pollLog("graph", `1W merge: ${describeMerge(merge)}.`);
    for (const flag of merge.flags) {
      this.pollLog("graph", `1W reconciliation: ${describeFlag(flag)}.`);
    }

    // Render the merged curve only when it is genuinely richer (more points) than
    // the web curve — never coarsen the carefully-built week line (Pillar 3 + the
    // WS8 regression guard). Reapply the calibrated base + per-instant FX.
    if (merge.points.length <= webCurve.length) {
      this.pollLog("graph", "1W merge: web curve already as dense — kept it (no coarsening).");
      return webCurve;
    }
    const merged = rebaseSleeveToWholeBook(merge.points, { baseUsd, baseEur }, fallbackFx);
    this.pollLog("graph", `1W merge: rendered the richer merged curve (${merged.length} points, was ${webCurve.length}).`);
    return merged;
  }

  /**
   * Calibrate the constant whole-book base from the nearest web↔blob time overlap
   * (within one hour): `baseUsd = webValueUsd − blobSleeveUsd`, `baseEur` likewise
   * with the blob's per-instant FX. Returns `null` when the two series never come
   * within an hour of each other (no trustworthy calibration point).
   */
  private calibrateSleeveBase(
    webCurve: CurvePoint[],
    blobSleeve: SleevePoint[],
  ): { baseUsd: Decimal; baseEur: Decimal } | null {
    const MAX_GAP_MS = 60 * 60 * 1000;
    let best: { web: CurvePoint; blob: SleevePoint; gap: number } | null = null;
    for (const w of webCurve) {
      for (const b of blobSleeve) {
        const gap = Math.abs(w.t - b.t);
        if (best === null || gap < best.gap) best = { web: w, blob: b, gap };
      }
    }
    if (!best || best.gap > MAX_GAP_MS) return null;
    const baseUsd = best.web.valueUsd.minus(best.blob.valueNativeUsd);
    const fx = best.blob.fxEurUsd;
    const blobSleeveEur = fx && fx.gt(0) ? best.blob.valueNativeUsd.div(fx) : best.blob.valueNativeUsd;
    const baseEur = best.web.valueEur.minus(blobSleeveEur);
    return { baseUsd, baseEur };
  }

  /** Lazily create (once) the IndexedDB-backed live-graph bar store. */
  private ensureTimeSeriesStore(): TimeSeriesStore {
    if (this.timeSeriesStore === null) this.timeSeriesStore = new TimeSeriesStore();
    return this.timeSeriesStore;
  }

  /**
   * The session's settled EUR→USD close read straight from the stored 1D FX bars
   * for `sessionDay` — the authoritative source both the live graphs' freeze
   * ({@link graphAnchorFx}) and the hero's currency-effect split share, so they
   * never disagree on what "the close" is. Returns `null` when no FX bars are on
   * the device yet (cold first paint) or on any store error, leaving the caller
   * to fall back to the live-captured running close.
   */
  private async barsSessionCloseFx(sessionDay: string): Promise<Decimal | null> {
    try {
      const session = await this.ensureTimeSeriesStore().loadSession(sessionDay);
      if (session && session.fx.length > 0) {
        return sessionCloseFxFromBars(session.fx, sessionCloseMs(sessionDay));
      }
    } catch {
      // Best-effort: a store failure simply falls back to the live capture.
    }
    return null;
  }

  /**
   * The **prior** session's settled EUR→USD close — the baseline the FX KPI's
   * "today" move is measured from — recovered from the on-device 1D FX bars when
   * the live provider hands back no `previous_close` (a cache / Tiingo / end-of-
   * day reading, or a cold start). Without this the KPI sticks on "—" and cannot
   * recover from that empty state, however much FX history the device holds.
   *
   * Reads the close at `sessionCloseMs(prevDay)` from two places, newest-first:
   * the prior session's own stored 1D session (present when the app ran that day),
   * then the current session's track — which {@link sessionFxHistoryWindow} now
   * fetches one session wider, so it carries the prior close even on a device that
   * was never open during the prior session. Returns `null` when neither track has
   * reached that close yet (a genuinely empty device) or on any store error.
   */
  private async barsPrevSessionCloseFx(sessionDay: string): Promise<Decimal | null> {
    const prevDay = previousTradingSession(sessionDay);
    const prevCloseMs = sessionCloseMs(prevDay);
    try {
      const store = this.ensureTimeSeriesStore();
      for (const key of [prevDay, sessionDay]) {
        const session = await store.loadSession(key);
        if (session && session.fx.length > 0) {
          const close = sessionCloseFxFromBars(session.fx, prevCloseMs);
          if (close !== null) return close;
        }
      }
    } catch {
      // Best-effort: a store failure simply leaves the KPI baseline unrecovered.
    }
    return null;
  }

  /**
   * The session's EUR→USD rate at the **open**, read from the same persisted FX
   * bars {@link barsSessionCloseFx} reads the close from — the live market-hours
   * anchor the hero's currency-effect split measures from while the session runs.
   * Returns `null` when no FX bars are on the device yet (cold first paint), no
   * positive bar has printed since 09:30 ET, or on any store error.
   */
  private async barsSessionOpenFx(sessionDay: string): Promise<Decimal | null> {
    try {
      const session = await this.ensureTimeSeriesStore().loadSession(sessionDay);
      if (session && session.fx.length > 0) {
        return sessionOpenFxFromBars(session.fx, sessionOpenMs(sessionDay));
      }
    } catch {
      // Best-effort: a store failure simply hides the live/last split.
    }
    return null;
  }

  /**
   * Prime the quote cache from a graph build's freshly fetched price bars so the
   * holding rows reuse the current price the graph already paid for, rather than
   * re-requesting it. Native currency is sourced per symbol from the model so a
   * not-yet-cached symbol can still be denominated; {@link primeQuotesFromBars}
   * only ever extends freshness, never overwriting a newer genuine quote.
   *
   * C5 — NAV funds in the model are flagged so their bar tip is stamped as a
   * **settled** daily close (value-date = bar day, not "live"); without that
   * {@link priceForHolding} rejects a bar-primed NAV as stale and the headline
   * falls back to the exported value, so the 1W gap-fill bars would never serve as
   * the headline NAV. This is what makes NAV genuinely bars-first.
   */
  private primeQuotesFromGraphBars(barsBySymbol: Map<string, Bar[]>, model: DashboardModel): void {
    if (barsBySymbol.size === 0) return;
    const currencyBySymbol = new Map<string, string | null>();
    const navSymbols = new Set<string>();
    for (const h of model.holdings) {
      const symbol = h.priceSymbol ?? h.symbol;
      if (!symbol) continue;
      currencyBySymbol.set(symbol, h.nativeCurrency ?? null);
      if (h.priceType === "nav") navSymbols.add(symbol);
    }
    primeQuotesFromBars(barsBySymbol, currencyBySymbol, Date.now(), undefined, navSymbols);
  }

  /**
   * Persist each fund's freshly-settled NAV as a daily bar in the 1W store
   * (`navBarsFromQuotes`, item 7a.1). The NAV was already pulled for the headline
   * total, so accumulating it here costs no extra credit and lets the week curve
   * re-mark NAV funds from their authentic per-day drift. Fire-and-forget and
   * fully best-effort — a store failure must never disturb the price paint.
   */
  private persistFundNavBars(quotes: Map<string, Quote>): void {
    const navSymbols = this.lastNavSymbols;
    if (navSymbols.size === 0) return;
    const bars = navBarsFromQuotes(quotes.values(), navSymbols);
    if (Object.keys(bars).length === 0) return;
    void this.ensureTimeSeriesStore()
      .mergeSession(WEEK_STORE_KEY, { bars }, Date.now())
      .catch(() => undefined);
  }

  /** Re-render the current model in place (e.g. after a currency toggle). */
  private reRenderCurrentModel(): void {
    if (this.model) this.renderDashboard(this.model);
  }

  /**
   * Maintain the device's whole-book **daily-close history** and return it for the
   * value chart's long-range backfill (`value-history.ts`).
   *
   * Three things happen, all best-effort:
   *   1. **Record** today's whole-book close — but only when the live total is
   *      complete (every holding priced + FX known); a partial total would store a
   *      false dip. Re-recording the same day just refines it (instant-deduped).
   *   2. **Prune** everything a fresh blob now covers: closes on/before the blob's
   *      last exported day are redundant, so we drop them — yet always keep the
   *      trailing week the 1W graph reconstructs from. The cutoff is therefore the
   *      earlier of the week's start and the day after the blob's last export, so a
   *      stale blob keeps the gap-filling days while an up-to-date one shrinks the
   *      store to just the week.
   *   3. **Load** the (now-updated) history so {@link renderValueChart} can splice
   *      it into the gap between the blob's last point and today.
   */
  private async syncValueHistory(model: DashboardModel): Promise<DailyClose[]> {
    const store = this.ensureTimeSeriesStore();
    const o = model.overview;
    const now = new Date();
    if (o.totalValueIsComplete) {
      await recordDailyClose(
        store,
        { date: o.asOf, valueEur: o.totalValueEur, valueUsd: o.totalValueUsd },
        now.getTime(),
      );
    }
    // Prune redundant pre-export closes once a blob is in hand, never touching the
    // trailing week the 1W graph needs.
    const exportedCurve = model.analytics?.curve ?? [];
    const lastExport = exportedCurve.length > 0 ? exportedCurve[exportedCurve.length - 1].date : null;
    const weekStart = recentTradingSessions(DEFAULT_WEEK_SESSIONS, now)[0] ?? o.asOf;
    if (lastExport !== null) {
      const afterExport = isoPlusDays(lastExport, 1);
      const cutoff = afterExport < weekStart ? afterExport : weekStart;
      await pruneValueHistory(store, cutoff);
    }
    return loadValueHistory(store);
  }

  /**
   * Seed the whole-book daily-close history from a freshly built 1W curve, then
   * return the curve unchanged so the caller can pass it straight on. The 1W curve
   * carries each of the last few sessions' settled closes, so harvesting them
   * back-fills the long-range graph's gap from the same data the week graph drew —
   * the "backfill also from the 1W history" path. Fire-and-forget and fully
   * best-effort: a store failure must never disturb the week curve it returns.
   */
  private harvestWeekCloses(points: CurvePoint[]): CurvePoint[] {
    if (points.length > 0) {
      void harvestDailyCloses(this.ensureTimeSeriesStore(), points, Date.now()).catch(() => undefined);
    }
    return points;
  }


  private renderLoadError(message: string): void {
    const panel = h("div", { class: "panel status" }, [
      h("h1", {}, ["Couldn't load live data"]),
      h("p", { class: "note err" }, [message]),
      h("div", { class: "row" }, [
        h("button", { class: "btn", type: "button", "data-action": "retry" }, ["Try again"]),
        h("button", { class: "btn ghost", type: "button", "data-action": "settings" }, ["Settings"]),
      ]),
    ]);
    panel
      .querySelector('[data-action="retry"]')
      ?.addEventListener("click", () => this.manualRefresh());
    panel.querySelector('[data-action="settings"]')?.addEventListener("click", () => this.showSetup());
    this.mount(h("div", { class: "screen" }, [panel]));
  }

  private lock(): void {
    // Snapshot what we hold *before* tearing down, so the next login's pre-flight
    // can reason about the delta (the "good saving when logging off" half).
    void this.saveSessionStatus();
    // Invalidate any in-flight background work and tear down the auto-refresh.
    this.sessionId += 1;
    this.clearRefreshTimer();
    this.removeVisibilityRefresh();
    this.removeAutoLock();
    // An explicit lock (manual or idle) must not be resumable on the next reload:
    // drop the tab-scoped resume token so a lock genuinely means "re-authenticate".
    clearResumeToken();
    this.resumedFromRefresh = false;
    this.clearManualFeedbackTimer();
    this.manualFeedbackUntil = 0;
    this.setUpdating(false);
    this.refreshing = false;
    this.refreshingKind = null;
    this.promoteToManual = false;
    this.state.passphrase = null;
    this.state.data = null;
    // Drop the prefetch warm-up state so its status never lingers on the unlock
    // screen after a lock; the next unlock interaction re-warms the caches afresh.
    this.prefetchStatus = null;
    this.prefetchShownOnLogin = false;
    this.prefetchPromise = null;
    this.prefetchFetchedSomething = false;
    this.showUnlock();
  }
}

/**
 * Live-fill progress for the auto-refresh indicator: how many of the priceable
 * symbols are now up to date (freshly fetched or still cache-fresh) versus the
 * total requested this round. A portfolio with more market symbols than the
 * free-tier per-minute cap can only be filled over several burst rounds, so
 * showing "N of M" turns that unavoidable staging into visible, satisfying
 * progress instead of an update that can never complete in one go.
 */
export function liveRefreshProgress(report: QuoteLoadReport): { live: number; total: number } {
  // Both deferred (skipped for budget) and failed (attempted, couldn't price)
  // symbols count toward the total but are *not* live — so a failed holding keeps
  // the round from reporting "all live" just as a deferred one does.
  const notLive = report.deferred.length + report.failed.length;
  const total = report.fetched.length + report.servedFresh.length + notLive;
  const live = total - notLive;
  return { live, total };
}

/**
 * Whether a network refresh round leaves *every* priceable holding up to date:
 * there is at least one such holding, nothing is still deferred for a later
 * round, and the round didn't fail. Used to detect the moment a multi-round
 * staged fill finally completes so the app can pop a one-off "prices all live"
 * confirmation.
 */
export function allPricesLive(report: QuoteLoadReport): boolean {
  const { live, total } = liveRefreshProgress(report);
  return report.error === null && total > 0 && live === total;
}

/**
 * Structured, honest facts about what is actually live versus awaited right now,
 * split the way the user thinks about it: continuously-traded **market**
 * holdings (stocks/ETFs) versus once-a-day **NAV** funds. The summary text is
 * built from these so it never dresses an unpublished NAV up as "live" — it says
 * plainly what we hold and what is still expected (see {@link summarizeCoverage}).
 */
export interface CoverageFacts {
  /** NYSE regular session open right now. */
  marketOpen: boolean;
  /** Market (stock/ETF) holdings requested this round. */
  marketTotal: number;
  /**
   * Market holdings that hold a usable price right now — *freshly pulled or from
   * cache*. Crucially this counts cached values too, so a budget-deferred holding
   * that still has a perfectly good cached close is never reported as "missing"
   * (the "0/12 recent when all are actually held" bug).
   */
  marketHeld: number;
  /** Market holdings whose price was *freshly fetched this round* (a subset of {@link marketHeld}). */
  marketFresh: number;
  /**
   * Market holdings that hold a usable cached price but were *budget-deferred this
   * round* (parked by the free-tier per-minute cap) and are not yet live — i.e.
   * still waiting their turn in the burst cadence. A subset of {@link marketHeld},
   * disjoint from {@link marketFresh}. Surfaced as its own honest "updating…"
   * bucket so a still-draining holding is shown as actively catching up rather
   * than folded silently into "cached" and read as a stall (freshness-plan §4.2).
   */
  marketUpdating: number;
  /**
   * Market holdings that hold the latest *settled close* (see `holdsSettledClose`)
   * — i.e. the freshest value that exists while the exchange is shut. Drives the
   * "market closed · at closing prices, no need to update" messaging.
   */
  marketAtClose: number;
  /** NAV-priced funds requested this round. */
  navTotal: number;
  /**
   * NAV funds that hold the latest settled session's NAV but whose *tonight's*
   * NAV (for today's in-progress session) is still to strike — the "expected
   * tonight" count while the market is open. Zero while the market is closed.
   */
  navExpectedTonight: number;
  /**
   * NAV funds whose latest settled session's NAV we don't yet hold — the
   * "awaiting" count. While the market is closed this is the after-close window
   * until tonight's NAV lands; zero over a weekend/holiday once the latest
   * published NAV is in hand.
   */
  navAwaiting: number;
  /** Whether fresh data actually landed recently (else: "showing recent prices"). */
  freshlyPulled: boolean;
  /** A hard fetch error occurred this round (on last-known values). */
  error: boolean;
  /**
   * Where the EUR→USD spot that values the whole book came from this round, so
   * the coverage line can report FX freshness alongside the price coverage:
   *   - `live`  — a fresh live spot was pulled;
   *   - `eod`   — the forex market is shut; on the last end-of-day close;
   *   - `cache` — served from a recent cached spot (no fresh pull this round);
   *   - `none`  — no rate at all (awaiting FX; book values may be incomplete).
   */
  fx: EurUsdSource;
  /**
   * Whether the spot-FX (forex) market is *shut* right now (the weekend close,
   * see {@link isForexMarketOpen}). When true the EUR/USD rate is frozen at
   * Friday's close, so the FX clause says "FX market closed" rather than dressing
   * the auto-dated weekend quote up as live/recent.
   */
  fxMarketClosed: boolean;
}

/**
 * Choose the FX source label to *display* on the coverage line. A spot served
 * from cache (`"cache"`) but observed within `maxStalenessMs` (the user-set
 * auto-refresh interval, falling back to {@link LIVE_PRICE_MAX_STALENESS_MS}) is,
 * to the user, just as live as the market prices it values — so promote it to
 * `"live"` and let it read "FX live" rather than "FX recent". Every other source
 * (and a genuinely aged cache) passes through unchanged.
 */
export function displayFxSource(
  source: EurUsdSource,
  observedAtMs: number | null,
  nowMs: number,
  maxStalenessMs: number = LIVE_PRICE_MAX_STALENESS_MS,
): EurUsdSource {
  const window = maxStalenessMs > 0 ? maxStalenessMs : LIVE_PRICE_MAX_STALENESS_MS;
  if (source === "cache" && observedAtMs !== null && nowMs - observedAtMs <= window) {
    return "live";
  }
  return source;
}

/** Human FX-freshness clause for the coverage line (see {@link CoverageFacts.fx}). */
function fxClause(fx: EurUsdSource, fxMarketClosed = false): string {
  // Weekend forex close: the rate is frozen at Friday's close, so say so plainly
  // rather than implying a live/recent pull of an auto-dated quote.
  if (fxMarketClosed) return "FX market closed";
  switch (fx) {
    case "live":
      return "FX live";
    case "tiingo":
      return "FX live (backup)";
    case "eod":
      return "FX end of day";
    case "cache":
      return "FX recent";
    default:
      return "awaiting FX";
  }
}

/** Capitalise the first character of a status line (NAV/FX acronyms stay intact). */
function capitalizeFirst(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

/**
 * Classify this refresh round into {@link CoverageFacts}: split the requested
 * symbols into market vs NAV, count how many market holdings are live, and judge
 * each NAV fund against the latest *settled* US trading session.
 *
 * The NAV rule is deliberately simple — no attempt to predict *when* a fund
 * publishes, just "after the close, await it until it arrives":
 *   - **market open**: today's session is still mid-flight, so its NAV strikes
 *     tonight — count the fund as "expected tonight" (we hold the prior settled
 *     session's NAV in the meantime). A fund that is behind even that prior
 *     settled NAV is genuinely missing it, so it counts as "awaiting".
 *   - **market closed**: we should hold the latest settled session's NAV. Until
 *     it lands — the whole after-close, pre-NAV window — the fund is "awaiting";
 *     once it is in hand the book is up to date.
 */
export function buildCoverageFacts(
  report: QuoteLoadReport,
  quotes: ReadonlyMap<
    string,
    { valueDate?: string | null; marketOpen?: boolean | null; priceTime?: number | null; at?: number | null; price?: unknown }
  >,
  navSymbols: ReadonlySet<string>,
  ctx: {
    now?: Date;
    marketOpen: boolean;
    freshlyPulled?: boolean;
    fx?: EurUsdSource;
    fxMarketClosed?: boolean;
    /**
     * The live-freshness window (ms, the user-set auto-refresh interval). A market
     * holding served from cache but *observed* within this window is, to the user,
     * just as live as one freshly pulled this round — so it is counted as "live",
     * not "cached", mirroring {@link displayFxSource}. Falls back to
     * {@link LIVE_PRICE_MAX_STALENESS_MS}.
     */
    liveStalenessMs?: number;
  },
): CoverageFacts {
  const now = ctx.now ?? new Date();
  const nowMs = now.getTime();
  const fetched = new Set(report.fetched);
  // Symbols parked this round by the free-tier per-minute cap — held from cache but
  // still draining. Surfaced as their own "updating…" bucket (freshness-plan §4.2).
  const deferred = new Set(report.deferred);
  const liveWindowMs =
    ctx.liveStalenessMs !== undefined && ctx.liveStalenessMs > 0
      ? ctx.liveStalenessMs
      : LIVE_PRICE_MAX_STALENESS_MS;
  // The latest US session whose 16:00 close has happened. Its NAV is the freshest
  // a fund should hold; after the close that is today's just-shut session.
  const settled = latestSettledSessionDate(now);
  // The most recent NYSE session that has *started* (today once its open passes,
  // else the prior session). A held NAV older than this while the market is open
  // means today's session is still mid-flight, so its NAV is yet to strike tonight.
  const startedSession = lastSessionDate(now);
  let marketTotal = 0;
  let marketHeld = 0;
  let marketFresh = 0;
  let marketUpdating = 0;
  let marketAtClose = 0;
  let navTotal = 0;
  let navExpectedTonight = 0;
  let navAwaiting = 0;
  for (const symbol of [...report.fetched, ...report.servedFresh, ...report.deferred, ...report.failed]) {
    if (navSymbols.has(symbol)) {
      navTotal += 1;
      const held = quotes.get(symbol)?.valueDate ?? null;
      // Behind the latest settled session's NAV → genuinely missing it. After the
      // close this is the normal "awaiting tonight's NAV" window; while open it
      // only fires for a fund behind even the prior settled session (an outage).
      const behindSettled = held === null || held < settled;
      if (behindSettled) {
        navAwaiting += 1;
      } else if (ctx.marketOpen && held < startedSession) {
        // Holding the latest settled NAV, but today's session is under way and its
        // NAV strikes tonight. "Expected", not missing.
        navExpectedTonight += 1;
      }
    } else {
      marketTotal += 1;
      const q = quotes.get(symbol);
      // "Held" = we have an actual price to show (fresh or cached), so a deferred
      // symbol that still has a usable cached value counts as held — never missing.
      if (q?.price != null) marketHeld += 1;
      // "Live" is a freshly-pulled quote *or* a cached one whose observation is
      // still within the live window — a spot confirmed two minutes ago is, to the
      // user, just as live as one re-pulled this round, so it must not read as
      // "cached" (mirrors {@link displayFxSource}). Only promote while the session
      // is open, where "live" is a meaningful claim.
      // `>= 0` rejects a future-stamped observation (clock skew) from reading as
      // live, mirroring the headline badge's `liveFeedAge >= 0` guard in compute.ts.
      const observedAt = q?.at ?? null;
      const cacheStillLive =
        ctx.marketOpen &&
        q?.price != null &&
        observedAt !== null &&
        nowMs - observedAt >= 0 &&
        nowMs - observedAt <= liveWindowMs;
      const isFresh = fetched.has(symbol) || cacheStillLive;
      if (isFresh) marketFresh += 1;
      // A held holding that was budget-deferred this round and isn't otherwise live
      // is actively "updating" (waiting its turn in the burst cadence) — its own
      // honest bucket rather than being folded into "cached" and read as stalled.
      else if (q?.price != null && deferred.has(symbol)) marketUpdating += 1;
      if (holdsSettledClose(q, settled)) marketAtClose += 1;
    }
  }
  return {
    marketOpen: ctx.marketOpen,
    marketTotal,
    marketHeld,
    marketFresh,
    marketUpdating,
    marketAtClose,
    navTotal,
    navExpectedTonight,
    navAwaiting,
    freshlyPulled: ctx.freshlyPulled ?? true,
    error: report.error !== null,
    fx: ctx.fx ?? "none",
    fxMarketClosed: ctx.fxMarketClosed ?? false,
  };
}

/** Pluralise "NAV"/"NAVs". */
function navWord(n: number): string {
  return n === 1 ? "NAV" : "NAVs";
}

/**
 * The NAV portion of a coverage line, honest about how many funds have actually
 * struck. While the market is open, undue NAVs are "expected tonight"; once due
 * and missing they are "awaiting"; when every due NAV is in hand they are "in".
 * Returns `[]` when there are no NAV holdings this round.
 */
function navCoverageClause(f: CoverageFacts): string[] {
  if (f.navTotal === 0) return [];
  if (f.marketOpen && f.navExpectedTonight > 0) {
    return [`${f.navExpectedTonight} ${navWord(f.navExpectedTonight)} expected tonight`];
  }
  if (f.navAwaiting > 0) {
    return [`awaiting ${f.navAwaiting}/${f.navTotal} ${navWord(f.navAwaiting)}`];
  }
  return [`${f.navTotal}/${f.navTotal} ${navWord(f.navTotal)} in`];
}

/**
 * Render a set of labelled count "buckets" into an honest fragment, **never**
 * emitting a `0/N` (the "0/12 recent" confusion): zero buckets are dropped, a
 * single bucket that accounts for the whole total reads as `N/N label`, and a
 * genuine split reads as `a label, b other` so cache-vs-live (or
 * closing-price-vs-still-chasing) is visible at a glance.
 */
function joinBuckets(buckets: { n: number; label: string }[], total: number): string {
  const nz = buckets.filter((b) => b.n > 0);
  if (nz.length === 0) return "";
  if (nz.length === 1 && nz[0].n === total) return `${total}/${total} ${nz[0].label}`;
  return nz.map((b) => `${b.n} ${b.label}`).join(", ");
}

/**
 * Turn {@link CoverageFacts} into a calm, *honest* one-liner. The point is to be
 * transparent about exactly what we hold and what we don't — never counting an
 * unpublished NAV as "live", never reporting `0/N` while values are actually
 * held, and splitting freshly-pulled ("live") from cached values so the reader
 * can see the difference. Every line is sentence-cased and always ends with an
 * FX-freshness clause. E.g.:
 *   - market open:   "13/13 live, 5 NAVs expected tonight · FX live"
 *   - split fill:    "8 live, 5 cached, 5 NAVs expected tonight · FX live"
 *   - market closed: "Market closed, up to date · FX end of day"
 *   - closed split:  "Market closed, 11 at last close, 2 awaiting, awaiting 3/5 NAVs · FX live"
 */
export function summarizeCoverage(f: CoverageFacts): string {
  const total = f.marketTotal + f.navTotal;
  const fx = fxClause(f.fx, f.fxMarketClosed);
  // Compose the price-coverage clause with the FX clause, then sentence-case the
  // whole line so it never reads as a lowercase fragment.
  const withFx = (priceText: string): string => capitalizeFirst(`${priceText} · ${fx}`);

  if (total === 0) return withFx("no live-priced holdings");
  if (f.error) return withFx(SHOWING_LAST_KNOWN);

  // Carve the budget-deferred "updating…" holdings out of the cached remainder so
  // a still-draining holding reads as actively catching up, not silently stalled.
  const updating = Math.max(0, Math.min(f.marketUpdating, f.marketHeld - f.marketFresh));
  const cached = Math.max(0, f.marketHeld - f.marketFresh - updating);
  const missing = Math.max(0, f.marketTotal - f.marketHeld);

  if (f.marketOpen) {
    // Session live: split freshly-pulled ("live") from still-draining ("updating…")
    // and genuinely idle cached holdings, and flag any holding we have no value for
    // at all as "awaiting".
    const parts: string[] = [];
    if (f.marketTotal > 0) {
      parts.push(
        joinBuckets(
          [
            { n: f.marketFresh, label: "live" },
            { n: updating, label: "updating…" },
            { n: cached, label: "cached" },
            { n: missing, label: "awaiting prices" },
          ],
          f.marketTotal,
        ),
      );
    }
    parts.push(...navCoverageClause(f));
    return withFx(parts.filter(Boolean).join(", "));
  }

  // Market closed. The freshest data that exists is the settled close, so report
  // against it: how many holdings are *at the closing price* versus still being
  // chased, and never dress a held value up as missing.
  const atClose = f.marketAtClose;
  const heldOther = Math.max(0, f.marketHeld - f.marketAtClose);
  const allAtClose = f.marketTotal > 0 && atClose === f.marketTotal;

  // Best case: every market close is in hand (or there are no market holdings)
  // and no NAV is overdue → the cached figures are the latest there are. Whether
  // the book is all-market or all-NAV is a distinction the reader doesn't care
  // about, so both collapse to one calm "up to date" line.
  if ((f.marketTotal === 0 || allAtClose) && f.navAwaiting === 0) {
    return withFx("market closed, up to date");
  }

  const parts: string[] = [];
  if (f.marketTotal > 0) {
    const market = joinBuckets(
      [
        { n: atClose, label: "at last close" },
        { n: heldOther, label: "recent" },
        { n: missing, label: "awaiting prices" },
      ],
      f.marketTotal,
    );
    parts.push(`market closed, ${market}`);
  } else {
    parts.push("market closed");
  }
  parts.push(...navCoverageClause(f));
  return withFx(parts.filter(Boolean).join(", "));
}

/**
 * A short, human summary of a manual refresh outcome for the confirmation toast,
 * so a tap always ends with a clear statement of what happened. Leads with the
 * transparent coverage line; only a genuine fetch failure overrides it.
 */
export function manualRefreshSummary(facts: CoverageFacts): string {
  if (facts.error) return `Couldn't reach live prices, ${SHOWING_LAST_KNOWN}.`;
  return summarizeCoverage(facts);
}

/**
 * Verdict on whether a refresh round actually reached a price service:
 *   - `offline`     — the device reports no network link at all;
 *   - `unreachable` — online, but no pricing service responded (every provider
 *                     errored and nothing landed — a dead link `navigator.onLine`
 *                     never noticed, or all providers are down);
 *   - `online`      — at least one service answered (a quote or live FX landed),
 *                     or there was simply nothing newer to fetch.
 */
export type ConnectivityState = "offline" | "unreachable" | "online";

/**
 * Decide the {@link ConnectivityState} of a network refresh round from what it
 * actually achieved on the wire. The honest guard against the app claiming to be
 * "updating" when nothing could be fetched: a device-reported offline flag wins
 * outright, otherwise a round that landed *nothing* while a provider failed
 * transiently is treated as unreachable (even when `navigator.onLine` wrongly
 * says we are connected). A clean round with nothing newer to fetch — or any
 * round where a quote / live FX did land — is `online`. A fatal (config) error
 * is handled elsewhere (it routes to Settings), so it does not mark unreachable.
 */
export function classifyConnectivity(input: {
  /** `navigator.onLine` — `false` means the device knows it has no link. */
  online: boolean;
  /** Count of symbols freshly fetched this round (0 = nothing new landed). */
  fetched: number;
  /** Whether a fresh (non-cached) FX / EUR-USD spot landed this round. */
  fxFetched: boolean;
  /** Primary (Twelve Data) quote error this round, if any. */
  quoteError: PriceError | null;
  /** Backup (Tiingo) error this round, if the backup was needed. */
  tiingoError: PriceError | null;
}): ConnectivityState {
  if (!input.online) return "offline";
  // Something genuinely landed ⇒ a service answered.
  if (input.fetched > 0 || input.fxFetched) return "online";
  // Nothing landed. If a provider actually failed transiently (and none
  // succeeded), no price service was reachable this round. A fatal config error
  // is excluded — that is a key problem, not a connectivity one.
  const primaryFailed = input.quoteError !== null && !input.quoteError.fatal;
  const backupFailed = input.tiingoError !== null && !input.tiingoError.fatal;
  if (primaryFailed || backupFailed) return "unreachable";
  // Nothing fetched and no errors: simply nothing newer to pull — up to date.
  return "online";
}

/**
 * The user-facing banner / toast line for a {@link ConnectivityState}, or null
 * when a service answered (no notice needed). Kept deliberately plain so the
 * dashboard is honest that it is showing last-known — never "live" — values.
 */
export function connectivityNotice(state: ConnectivityState): string | null {
  switch (state) {
    case "offline":
      return `No internet connection, ${SHOWING_LAST_KNOWN}.`;
    case "unreachable":
      return `Couldn't reach any price service, ${SHOWING_LAST_KNOWN}.`;
    default:
      return null;
  }
}

/**
 * The single canonical "we're on cached data" tail. The noun (prices/values) is
 * implied by context, so every status line that needs to say it falls back to
 * the same three words and the wording can never drift apart again.
 */
const SHOWING_LAST_KNOWN = "showing last known";

/**
 * One description of a failed Tiingo backup round, shared by the degradation
 * banner and the manual-refresh toast so the two never drift in wording. A 429
 * means the backup's own API quota is spent; anything else means the proxy
 * Worker is unreachable or misconfigured.
 */
export function describeTiingoError(error: PriceError): string {
  return error.status === 429
    ? "Backup (Tiingo) rate-limited; its credits look used up."
    : "Backup (Tiingo) unreachable; check the price proxy Worker.";
}

/**
 * An honest one-liner for the unlock ("Welcome back") screen describing the
 * login-time prefetch, so the warming of live prices is visible while the user
 * authenticates. Strictly truthful: it reports what the prefetch actually did
 * and when prices were last pulled — never claims a value is "live" that isn't.
 *
 *   - in flight:                "Warming live prices… · last pulled 3 min ago"
 *   - pulled fresh data:        "Prefetched 12/14 live · FX live · last pulled just now"
 *   - everything already fresh: "Already up to date · last pulled 2 min ago"
 *   - first ever run (no plan): "Warming live prices…" → "Live prices ready"
 */
export function describePrefetch(input: {
  /** Whether the prefetch is still running. */
  inFlight: boolean;
  /** Whether a cached priority plan existed to warm (false on a first ever run). */
  hasPlan: boolean;
  /** Quotes freshly fetched this prefetch. */
  quoteFetched: number;
  /** Quotes requested this prefetch. */
  quoteTotal: number;
  /** Whether the EUR/USD FX rate was freshly pulled (not served from cache). */
  fxLive: boolean;
  /** Graph price-series freshly backfilled this prefetch (1D/1W bars). */
  graphFetched?: number;
  /** When live data was last genuinely pulled, for the "last pulled" clause. */
  lastPullAt: number | null;
  /** Injectable clock for the "last pulled" formatting (tests). */
  now?: number;
}): string {
  const pulled =
    input.lastPullAt !== null
      ? `last pulled ${formatLastPull(input.lastPullAt, input.now !== undefined ? new Date(input.now) : undefined)}`
      : null;
  if (input.inFlight) {
    return pulled ? `Warming live prices… · ${pulled}` : "Warming live prices…";
  }
  const graphFetched = input.graphFetched ?? 0;
  const parts: string[] = [];
  if (!input.hasPlan) {
    // First ever run: nothing to compare against, just confirm we warmed up.
    parts.push("Live prices ready");
  } else if (input.quoteFetched > 0 || input.fxLive || graphFetched > 0) {
    const bits: string[] = [];
    if (input.quoteFetched > 0) bits.push(`${input.quoteFetched}/${input.quoteTotal} live`);
    if (graphFetched > 0) bits.push(`${graphFetched} graph`);
    if (input.fxLive) bits.push("FX live");
    parts.push(`Prefetched ${bits.join(" · ")}`);
  } else {
    parts.push("Already up to date");
  }
  if (pulled) parts.push(pulled);
  return parts.join(" · ");
}

/**
 * Interaction events that count as "activity" and reset the idle auto-lock
 * countdown. Kept passive and broad enough that the lock only ever bites on a
 * genuinely unattended session: presses *and movement* (pointer/mouse/touch),
 * wheel and scroll, keyboard and typing, clicks, and tab re-focus. The
 * high-frequency movement events are throttled where they are handled.
 */
const AUTO_LOCK_ACTIVITY_EVENTS = [
  "pointerdown",
  "pointermove",
  "mousemove",
  "wheel",
  "keydown",
  "scroll",
  "touchstart",
  "touchmove",
  "click",
  "input",
  "focus",
] as const;

function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  const children: Array<Node | string> = [h("span", { class: "field-label" }, [label]), input];
  if (hint) children.push(h("span", { class: "field-hint" }, [hint]));
  return h("label", { class: "field" }, children);
}

/**
 * A labelled on/off switch row (checkbox styled as a slider). The passed
 * `input` is the underlying checkbox — read `.checked` and listen for `change`
 * on it. `role="switch"` should be set by the caller for assistive tech.
 */
function switchField(label: string, input: HTMLInputElement, hint?: string): HTMLElement {
  const slider = h("span", { class: "slider", "aria-hidden": "true" });
  const sw = h("span", { class: "switch" }, [input, slider]);
  const head = h("div", { class: "toggle-head" }, [h("span", { class: "field-label" }, [label]), sw]);
  const children: Array<Node | string> = [head];
  if (hint) children.push(h("span", { class: "field-hint" }, [hint]));
  return h("label", { class: "field toggle" }, children);
}

/**
 * Line-art fingerprint glyph (paths from Lucide "fingerprint", MIT). Built with
 * the DOM API (no `innerHTML`) so it inherits `currentColor` for a clean,
 * broker-style unlock CTA.
 */
const FINGERPRINT_PATHS = [
  "M2 12C2 6.5 6.5 2 12 2a10 10 0 0 1 8 4",
  "M5 19.5C5.5 18 6 15 6 12c0-.7.12-1.37.34-2",
  "M17.29 21.02c.12-.6.43-2.3.5-3.02",
  "M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4",
  "M8.65 22c.21-.66.45-1.32.57-2",
  "M14 13.12c0 2.38 0 6.38-1 8.88",
  "M2 16h.01",
  "M21.8 16c.2-2 .131-5.354 0-6",
  "M9 6.8a6 6 0 0 1 9 5.2c0 .47 0 1.17-.02 2",
];

const SVG_NS = "http://www.w3.org/2000/svg";

/** A standalone fingerprint icon element for the unlock CTA. */
function fingerprintIcon(): HTMLElement {
  const span = h("span", { class: "bio-icon" });
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "22");
  svg.setAttribute("height", "22");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of FINGERPRINT_PATHS) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  span.appendChild(svg);
  return span;
}
