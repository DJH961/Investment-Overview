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
import { buildDashboard, buildFetchPlan, type DashboardModel } from "./compute";
import { decryptEnvelopeToJson, type Envelope } from "./crypto";
import { buildDemoModel } from "./demo";
import {
  defaultConfig,
  isValidRepo,
  loadConfig,
  parseAutoLockMinutes,
  parseAutoRefreshMinutes,
  resolveBlobUrl,
  resolveMetaUrl,
  saveConfig,
  DEFAULT_QUOTE_CACHE_MINUTES,
  DEFAULT_AUTO_LOCK_MINUTES,
  DEFAULT_AUTO_REFRESH_MINUTES,
  MAX_AUTO_LOCK_MINUTES,
  MAX_AUTO_REFRESH_MINUTES,
  type AppConfig,
} from "./config";
import { PriceError, type FxRates } from "./prices";
import type { Decimal } from "./decimal-config";
import {
  readCachedEnvelope,
  readCachedEurUsd,
  readCachedFx,
  readCreditLog,
  creditsSpentWithin,
  readLastPull,
  readNavPublishStats,
  readSymbolPlan,
  recordNavPublish,
  writeCachedEnvelope,
  writeLastPull,
  writeSymbolPlan,
} from "./cache";
import {
  DEFAULT_NAV_CACHE_TTL_MS,
  FREE_TIER,
  NAV_PUBLISH_HOUR,
  latestExpectedNavDate,
  loadEurUsd,
  loadFxRates,
  loadQuotes,
  marketCacheTtlMs,
  navCacheTtlMs,
  navPublishWindow,
  type EurUsdSource,
  type LoadQuotesOptions,
  type QuoteLoadReport,
} from "./quotes";
import { nextRefreshDelayMs } from "./refresh-policy";
import { isUsMarketOpen, latestSettledSessionDate } from "./market-hours";
import {
  clearBiometricEnrolment,
  enrolBiometric,
  hasBiometricEnrolment,
  isBiometricSupported,
  unlockWithBiometric,
} from "./webauthn";
import { setEurUsdRate } from "./currency";
import type { MobileExport } from "./types";
import { h, renderDashboard, renderThemeToggle, renderTimeFormatToggle } from "./ui";

/** How long an auto-dismissing status toast stays on screen. */
const TOAST_DURATION_MS = 4500;

/**
 * Minimum time the manual "Refreshing prices…" feedback stays on screen after
 * a tap. A live refresh that is fully served from cache (every quote/FX rate
 * still inside its window) resolves in a few milliseconds, so without a floor
 * the spinner + pill would flash for less than a frame and a phone tap would
 * look completely inert — exactly the "nothing happens" the user reported.
 */
const MANUAL_REFRESH_MIN_FEEDBACK_MS = 650;

/**
 * Minimum wall-clock gap between *automatic* background blob checks while prices
 * are still deferring. Matches the slow steady-state refresh cadence so an
 * always-deferred portfolio (more symbols than the free-tier budget) still polls
 * for a newer desktop export every few minutes instead of never, while the first
 * minute or two of startup burst — which checked the blob once on unlock — isn't
 * spammed with redundant probes.
 */
const BLOB_CHECK_MIN_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Daily free-tier credits remaining at or below which the UI warns the user it
 * is close to the limit (and starts spacing refreshes out). Two per-minute
 * windows' worth of headroom — enough warning to be useful without nagging.
 */
const DAILY_BUDGET_WARN_CREDITS = 2 * FREE_TIER.creditsPerMinute;

/**
 * How recently the app must have actually pulled fresh data from the network for
 * the coverage summary to claim holdings are "up to date". Beyond this the
 * prices on screen are old enough that a confident "up to date" would be
 * misleading, so the summary names them as last-pulled instead.
 */
const UP_TO_DATE_WINDOW_MS = 60 * 1000;

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
type RefreshKind = "manual" | "auto";

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
  /** The decrypted-from envelope and when it was downloaded (for re-download skip). */
  private envelope: Envelope | null = null;
  private envelopeAt: number | null = null;
  /** Last `portfolio.meta.json` version stamp seen, for the cheap freshness probe. */
  private metaVersion: string | null = null;
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
   * Monotonic session token. Bumped on every unlock and on lock so that
   * in-flight background work (timers, fetches) from a previous session is
   * recognised as stale and discarded.
   */
  private sessionId = 0;
  /** Pending auto-refresh timer, if any. */
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** Installed visibility listener, kept so it can be removed on lock. */
  private visibilityHandler: (() => void) | null = null;
  /** Guards against overlapping price refreshes. */
  private refreshing = false;
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
   * When the manual refresh feedback (pill + spinning glyph) may be torn down.
   * A cache-served refresh finishes almost instantly, so we hold the feedback
   * until at least this time for it to be perceptible. Paired with
   * {@link manualFeedbackTimer}, the pending deferred-teardown timer.
   */
  private manualFeedbackUntil = 0;
  private manualFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
  /** Pending idle auto-lock timer, if any. */
  private autoLockTimer: ReturnType<typeof setTimeout> | null = null;
  /** Installed activity listeners that reset the idle auto-lock timer. */
  private activityHandler: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.state = { config: defaultConfig(), passphrase: null, data: null };
  }

  async start(): Promise<void> {
    this.state.config = await loadConfig();
    if (this.demoRequested()) this.showDemo();
    else if (!this.isConfigured()) {
      this.showSetup();
    } else {
      // Warm live quotes for the symbols we already know about *before* the user
      // finishes unlocking, so the first post-login paint is live rather than
      // starting the per-minute clock from zero. Fire-and-forget; honours the
      // shared credit budget so it can't double-spend with the later refresh.
      void this.prefetchLiveData();
      // First unlock of the session: auto-prompt the fingerprint sheet when the
      // device is enrolled, so a returning user can unlock with a single touch
      // and no extra tap.
      this.showUnlock(undefined, { autoPrompt: true });
    }
  }

  /**
   * Login-time prefetch (idea B): using the cached priority plan from the last
   * session, start filling the quote + FX caches while the passphrase is typed
   * and the blob decrypts. No decrypted data is needed — the plan is just
   * tickers + coarse sizes — and {@link loadQuotes}/{@link loadFxRates} write
   * straight into the same caches the real refresh reads, so the work is shared,
   * never duplicated. Best-effort: any failure is swallowed.
   */
  private async prefetchLiveData(): Promise<void> {
    const { config } = this.state;
    if (!config.apiKey) return;
    const plan = readSymbolPlan();
    if (plan.length === 0) {
      // No plan yet (first ever run): we can still warm FX cheaply.
      void loadFxRates().catch(() => undefined);
      return;
    }
    const symbols = plan.map((e) => e.symbol);
    const navFetchSymbols = new Set(plan.filter((e) => e.priceType !== "market").map((e) => e.symbol));
    const options = this.buildQuoteOptions(navFetchSymbols, config);
    // Currency first: warm the FX cache before the tickers so the rate that
    // values the whole book always wins the per-minute budget, then prime quotes.
    await loadFxRates().catch(() => undefined);
    await Promise.allSettled([loadQuotes(symbols, config.apiKey, options)]);
  }

  /** Demo mode is opt-in via a `?demo` (or `?preview`) query flag in the URL. */
  private demoRequested(): boolean {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.has("demo") || params.has("preview");
    } catch {
      return false;
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
    const settingsMode = mode === "settings";
    const { config } = this.state;
    const apiKey = h("input", {
      type: "password",
      id: "f-apikey",
      autocomplete: "off",
      placeholder: "Twelve Data API key",
      value: config.apiKey,
    });
    const repo = h("input", {
      type: "text",
      id: "f-repo",
      autocomplete: "off",
      placeholder: "owner/repository",
      value: config.repo,
    });
    const tag = h("input", {
      type: "text",
      id: "f-tag",
      autocomplete: "off",
      placeholder: "live-data",
      value: config.releaseTag,
    });
    const blobUrl = h("input", {
      type: "url",
      id: "f-bloburl",
      autocomplete: "off",
      placeholder: "(optional) direct blob URL override",
      value: config.blobUrl,
    });
    const metaUrl = h("input", {
      type: "url",
      id: "f-metaurl",
      autocomplete: "off",
      placeholder: "(optional) version-file URL override",
      value: config.metaUrl,
    });
    const cacheMinutes = h("input", {
      type: "number",
      id: "f-cache",
      min: "1",
      max: "240",
      step: "1",
      autocomplete: "off",
      placeholder: String(DEFAULT_QUOTE_CACHE_MINUTES),
      value: String(config.quoteCacheMinutes),
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
    const autoRefresh = h("input", {
      type: "number",
      id: "f-autorefresh",
      min: "1",
      max: String(MAX_AUTO_REFRESH_MINUTES),
      step: "1",
      autocomplete: "off",
      placeholder: String(DEFAULT_AUTO_REFRESH_MINUTES),
      value: String(config.autoRefreshMinutes),
    });

    const actions: Array<Node | string> = [
      h("button", { class: "btn", type: "submit" }, [settingsMode ? "Save & reload" : "Save & continue"]),
    ];
    if (settingsMode) {
      actions.push(h("button", { class: "btn ghost", type: "button", "data-action": "back" }, ["Back"]));
    } else {
      actions.push(
        h("button", { class: "btn ghost", type: "button", "data-action": "demo" }, [
          "Preview the dashboard with sample data",
        ]),
      );
    }

    const intro = settingsMode
      ? "Update where the companion looks for your data and how it behaves. Changes stay on this device."
      : "These stay on this device. The API key powers live quotes; the repository tells the app where to find your encrypted data.";

    const formChildren: Array<Node | string> = [
      h("h1", {}, [settingsMode ? "Settings" : "Set up the companion"]),
      h("p", { class: "muted" }, [intro]),
    ];
    // Preferences (appearance, security) come first in Settings so the most
    // commonly-touched controls — starting with dark mode — are right at the top,
    // above the rarely-changed data-source plumbing.
    if (settingsMode) {
      formChildren.push(
        h("h2", { class: "settings-section" }, ["Appearance"]),
        field("Theme", renderThemeToggle(), "Switch between system, light and dark themes."),
        field("Clock format", renderTimeFormatToggle(), "Show times as 12-hour (AM/PM) or 24-hour. Auto follows your device locale."),
        h("h2", { class: "settings-section" }, ["Security"]),
        field(
          "Auto-lock (minutes)",
          autoLock,
          `Lock the dashboard after this many minutes of inactivity. Set 0 to never auto-lock. Default is ${DEFAULT_AUTO_LOCK_MINUTES}.`,
        ),
      );
      // Fingerprint unlock toggle — only meaningful while unlocked (we need the
      // in-memory passphrase to enrol) and on a device with a platform
      // authenticator, so it's revealed asynchronously below.
      if (this.state.passphrase) {
        const fingerprintSlot = h("div", { class: "settings-slot", hidden: "hidden" });
        formChildren.push(fingerprintSlot);
        void this.addFingerprintSetting(fingerprintSlot);
      }
      formChildren.push(h("h2", { class: "settings-section" }, ["Data source"]));
    }
    formChildren.push(
      field("Price API key", apiKey, "Free key from twelvedata.com — never leaves this device."),
      field("Data repository", repo, "The repo that hosts your published portfolio.enc release asset."),
      field("Release tag", tag, "Defaults to live-data."),
      field("Blob URL override", blobUrl, "Advanced: a direct, CORS-enabled URL (e.g. your web/proxy Worker) to fetch the encrypted blob from, instead of the release asset."),
      field("Version-file URL override", metaUrl, "Advanced: where to read the tiny portfolio.meta.json version stamp. Leave blank to derive it from the blob URL — set it only if the sidecar lives elsewhere."),
      field("Quote cache (minutes)", cacheMinutes, "Free tier is 8 credits/min, 800/day (1 per symbol). A longer cache means fewer refetches and fewer credits spent."),
      field("Auto-refresh (minutes)", autoRefresh, `Steady-state gap between automatic live refreshes once everything is fresh. A manual Refresh also pushes the next auto-refresh out by this long. Default is ${DEFAULT_AUTO_REFRESH_MINUTES}.`),
    );
    formChildren.push(
      error ? h("p", { class: "note err" }, [error]) : document.createTextNode(""),
      h("div", { class: "row" }, actions),
    );

    const form = h("form", { class: "panel", novalidate: "novalidate" }, formChildren);

    form.querySelector('[data-action="demo"]')?.addEventListener("click", () => this.showDemo());
    form.querySelector('[data-action="back"]')?.addEventListener("click", () => this.exitSettings());

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const next: AppConfig = {
        apiKey: (apiKey as HTMLInputElement).value.trim(),
        repo: (repo as HTMLInputElement).value.trim(),
        releaseTag: (tag as HTMLInputElement).value.trim() || "live-data",
        blobUrl: (blobUrl as HTMLInputElement).value.trim(),
        metaUrl: (metaUrl as HTMLInputElement).value.trim(),
        quoteCacheMinutes: clampCacheMinutes((cacheMinutes as HTMLInputElement).value),
        autoLockMinutes: parseAutoLockMinutes((autoLock as HTMLInputElement).value),
        autoRefreshMinutes: parseAutoRefreshMinutes((autoRefresh as HTMLInputElement).value),
      };
      if (!next.apiKey) return this.showSetup("Enter your price API key.", mode);
      const hasSource = next.blobUrl.length > 0 || isValidRepo(next.repo);
      if (!hasSource) return this.showSetup("Enter a valid owner/repository or a direct blob URL.", mode);
      this.state.config = next;
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

  /** Leave Settings without saving: back to the dashboard, or the unlock screen. */
  private exitSettings(): void {
    if (this.state.data && this.model) this.renderDashboard(this.model);
    else this.showUnlock();
  }

  // --- Unlock screen ----------------------------------------------------------

  private showUnlock(error?: string, options: { autoPrompt?: boolean } = {}): void {
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

    const form = h("form", { class: "panel unlock", novalidate: "novalidate" }, formChildren);
    form.querySelector('[data-action="settings"]')?.addEventListener("click", () => this.showSetup());
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

  /**
   * Render the dashboard from baked-in sample data — no key, passphrase, or
   * network. Lets anyone explore the UI; "Exit demo" returns to the setup.
   */
  private showDemo(): void {
    const model = buildDemoModel();
    // Seed the EUR→USD rate from the sample export so the currency toggle works.
    setEurUsdRate(model.overview.fxRateEurUsd);
    this.model = model;
    const banner = h("div", { class: "demo-banner" }, [
      h("strong", {}, ["Demo mode"]),
      " — sample data, no real portfolio. Figures are illustrative.",
    ]);
    const dashboard = renderDashboard(
      model,
      () => this.showDemo(),
      () => {
        // Leave the preview for the real app, regardless of a `?demo` URL flag.
        void (async () => {
          this.state.config = await loadConfig();
          if (this.isConfigured()) this.showUnlock();
          else this.showSetup();
        })().catch(() => this.showSetup());
      },
      () => this.showDemo(),
      () => this.showSettings(),
      "Exit demo",
    );
    this.mount(h("div", { class: "demo-shell" }, [banner, dashboard]));
  }

  // --- Load pipeline ----------------------------------------------------------

  /**
   * Unlock the dashboard. To make a quick re-open feel instant, we decrypt the
   * encrypted blob we already cached *first* and render from cached prices, then
   * re-download the blob and refresh prices in the background. Only when there is
   * no usable cached blob do we block on a fresh download.
   */
  private async unlock(passphrase: string, enrolRequested = false): Promise<void> {
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
    void this.runScheduledRefresh(session);
    // 5. Arm the idle auto-lock so an unattended session locks itself.
    this.installAutoLock();
  }

  // --- Idle auto-lock ---------------------------------------------------------

  /**
   * Arm an inactivity timer that locks the session after
   * {@link AppConfig.autoLockMinutes} minutes without interaction. Pointer, key,
   * touch and scroll activity (plus tab re-focus) reset the countdown. A value of
   * `0` disables the feature. Safe to call repeatedly — it tears down any prior
   * wiring first, so a Settings change re-arms with the new timeout.
   */
  private installAutoLock(): void {
    this.removeAutoLock();
    const minutes = this.state.config.autoLockMinutes;
    if (minutes <= 0) return;
    const timeoutMs = minutes * 60_000;
    const reset = (): void => {
      if (this.autoLockTimer) clearTimeout(this.autoLockTimer);
      // Only keep counting while a session is actually unlocked.
      if (!this.state.passphrase) return;
      this.autoLockTimer = setTimeout(() => {
        if (this.state.passphrase) this.lock();
      }, timeoutMs);
    };
    this.activityHandler = reset;
    for (const event of AUTO_LOCK_ACTIVITY_EVENTS) {
      window.addEventListener(event, reset, { passive: true });
    }
    reset();
  }

  /** Tear down the idle auto-lock timer and its activity listeners. */
  private removeAutoLock(): void {
    if (this.autoLockTimer) {
      clearTimeout(this.autoLockTimer);
      this.autoLockTimer = null;
    }
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
  private async maybeRefreshBlob(session: number): Promise<void> {
    const { config, passphrase } = this.state;
    if (!passphrase) return;
    const url = resolveBlobUrl(config);
    if (!url) return;
    // Stamp the attempt up front so the slow-cadence throttle (blobCheckDue)
    // measures from when we last *tried*, regardless of the outcome below.
    this.lastBlobCheckAt = Date.now();
    try {
      // 1. Lightweight version probe. A matching stamp means "no newer export".
      const metaUrl = resolveMetaUrl(config);
      const meta = metaUrl ? await fetchBlobMeta(metaUrl) : null;
      if (session !== this.sessionId) return;
      if (meta && this.metaVersion !== null && meta.version === this.metaVersion) return;

      // 2. Conditional download: an unchanged blob comes back as 304.
      const cached = readCachedEnvelope();
      const result = await fetchEnvelopeConditional(url, {
        etag: cached?.etag,
        lastModified: cached?.lastModified,
      });
      if (session !== this.sessionId) return;

      if (result.status === "not-modified") {
        // Nothing changed on the wire; just remember the latest meta version so
        // the next probe can short-circuit on step 1.
        if (meta) this.persistEnvelope(this.envelope, { metaVersion: meta.version, etag: cached?.etag, lastModified: cached?.lastModified });
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
      // so matching both fields means the decrypted portfolio is unchanged.
      if (this.envelope && envelope.ciphertext === this.envelope.ciphertext && envelope.nonce === this.envelope.nonce) {
        return;
      }
      // A genuinely new export is on the wire — and it's worth telling the user:
      // a new blob means the desktop published a larger update (new holdings,
      // transactions, fresh history), so a bigger refresh is about to land. The
      // *checking* stays silent (no toast on a 304 / unchanged version); only an
      // actual new-data load pops up.
      const hadData = this.envelope !== null;
      if (hadData) this.toast("New data found — loading the latest portfolio…");
      const data = await decryptEnvelopeToJson<MobileExport>(envelope, passphrase);
      if (session !== this.sessionId) return;
      this.envelope = envelope;
      this.state.data = data;
      // Re-render the (possibly new) holdings from cache instantly; the running
      // price scheduler will fetch anything freshly added on its next tick.
      await this.refreshPrices(session, false);
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
    })));

    return { symbols, options: this.buildQuoteOptions(navFetchSymbols, config, force) };
  }

  /**
   * Build the (NAV-aware) {@link loadQuotes} options for a set of symbols. Shared
   * by the live refresh and the login-time prefetch so both honour the same
   * per-symbol cache windows and publish-time learning. `force` forces market
   * symbols to re-fetch (the "pull now" path behind a manual Refresh tap); NAV
   * symbols stay on their once-a-day adaptive window regardless.
   */
  private buildQuoteOptions(
    navFetchSymbols: Set<string>,
    config: AppConfig,
    force = false,
  ): LoadQuotesOptions {
    const cacheTtlMs = config.quoteCacheMinutes * 60 * 1000;
    // Per-symbol learned publish windows: when each fund's NAV has historically
    // landed, so we poll within that tight band instead of a fixed evening guess.
    const navStats = readNavPublishStats();
    // Learned publish hour for a NAV symbol (when its once-a-day NAV is expected).
    const publishHourFor = (symbol: string): number =>
      navPublishWindow(navStats.get(symbol)?.hours).publishHour;
    return {
      cacheTtlMs,
      navSymbols: navFetchSymbols,
      forceMarketFetch: force,
      cacheTtlMsForSymbol: (symbol, cached) => {
        if (navFetchSymbols.has(symbol)) {
          // NAV fund: relax once today's NAV is in hand, else poll like a normal
          // symbol until it lands (no upper catch-up cap — catches a late NAV).
          return navCacheTtlMs(cached?.quote, {
            shortTtlMs: cacheTtlMs,
            longTtlMs: DEFAULT_NAV_CACHE_TTL_MS,
            publishHour: publishHourFor(symbol),
          });
        }
        // Market symbol: while the exchange is shut and we already hold the latest
        // settled close there is nothing new to fetch — rest until it reopens.
        const now = new Date();
        return marketCacheTtlMs(cached?.quote, {
          shortTtlMs: cacheTtlMs,
          marketOpen: isUsMarketOpen(now),
          latestSettledDate: latestSettledSessionDate(now),
        });
      },
      // A manual "pull now" may re-fetch a NAV fund only when it is *behind* its
      // latest expected value (we are demonstrably missing a published NAV);
      // otherwise NAV symbols stay exempt so a tap never chases an unchanged NAV.
      forceFetch: force
        ? (symbol, cached) => {
            if (!navFetchSymbols.has(symbol)) return false; // market: forceMarketFetch
            const have = cached?.quote.valueDate ?? null;
            return !(have && have >= latestExpectedNavDate(new Date(), publishHourFor(symbol)));
          }
        : undefined,
      // Learn each fund's real publish time from when its value-date advances.
      onValueDateAdvance: (symbol, valueDate, at) => {
        if (navFetchSymbols.has(symbol)) recordNavPublish(symbol, valueDate, at);
      },
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
   */
  private async refreshPrices(
    session: number,
    network: boolean,
    opts: { force?: boolean } = {},
  ): Promise<QuoteLoadReport | null> {
    const { data, config } = this.state;
    if (!data) return null;

    const { symbols, options } = this.quoteRequest(data, config, network && (opts.force ?? false));
    // Remember which symbols are NAV-priced funds so the coverage summary can
    // split the live market count from the once-a-day NAVs that are still
    // expected/awaited (see {@link summarizeCoverage}) rather than a bare count.
    this.lastNavSymbols = options.navSymbols ?? new Set();
    const apiKey = network ? config.apiKey : "";

    // Pull the live currency (FX + EUR/USD spot) FIRST — before any stock, ETF or
    // fund quote — so the per-minute free-tier budget always funds the rate that
    // values the whole book, never spending it all on tickers and leaving FX last.
    let fx: FxRates;
    let fxReport: { cached: boolean; error: PriceError | null };
    let eurUsdNow: Decimal | null = null;
    let eurUsdPrev: Decimal | null = null;
    let eurUsdSource: EurUsdSource = "none";
    if (network) {
      const fxLoad = await loadFxRates();
      fx = fxLoad.fx;
      fxReport = fxLoad;
      // Live EUR/USD (current + prior close) for an FX-aware today's move.
      // The conversion rate is the one thing we *always* re-poll on a network
      // refresh (ttlMs: 0): the forex market trades ~24/5, so the most recent
      // live spot is always the right rate for valuing the book. It still
      // degrades gracefully — when the pair can't be fetched (no budget/key, a
      // transient failure, or the weekend FX close) loadEurUsd falls back to
      // today's cached spot, then the ECB end-of-day rate.
      const eurUsd = await loadEurUsd(apiKey, { eodFallback: fx.rates.USD ?? null, ttlMs: 0 });
      eurUsdNow = eurUsd.now;
      eurUsdPrev = eurUsd.previousClose;
      eurUsdSource = eurUsd.source;
    } else {
      // Cache-only paint: don't touch the network for FX either.
      const cachedFx = readCachedFx();
      fx = cachedFx?.fx ?? { base: "EUR", rates: {} };
      fxReport = { cached: cachedFx !== null, error: null };
      const cachedEurUsd = readCachedEurUsd();
      if (cachedEurUsd) {
        eurUsdNow = cachedEurUsd.now;
        eurUsdPrev = cachedEurUsd.previousClose;
        eurUsdSource = "cache";
      }
    }
    // Prefer the live EUR/USD spot (more current than the ECB daily rate) for
    // all current marks, so value and today's move share one consistent rate.
    if (eurUsdNow !== null && eurUsdNow.greaterThan(0)) {
      fx = { base: fx.base, rates: { ...fx.rates, USD: eurUsdNow } };
    }

    // Now fetch the stock / ETF / fund quotes with whatever budget remains.
    const quotePromise = loadQuotes(symbols, apiKey, options);

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

    const degradedReason = network ? this.describeDegradation(quoteLoad.report, fxReport) : null;
    // Record when fresh market data actually landed: a live quote fetch, or a
    // live (non-cached) FX pull. This is "when we last pulled", independent of
    // how old the prices themselves are — so even over a closed-market weekend
    // it reflects today's pull. Persisted so it survives reload / re-open.
    if (network && (quoteLoad.report.fetched.length > 0 || !fxReport.cached)) {
      this.lastDataPullAt = Date.now();
      writeLastPull(this.lastDataPullAt);
    }
    const model = buildDashboard(data, quoteLoad.quotes, fx, new Date(), degradedReason, {
      fxPrevEurUsd: eurUsdPrev,
      fxEurUsdSource: eurUsdSource,
    });
    model.overview.lastDataPullAt = this.lastDataPullAt;
    // Refresh the live-coverage summary on a network pull; keep the last one on a
    // cache-only re-paint so a currency toggle / blob swap doesn't blank it.
    if (network) {
      const navStats = readNavPublishStats();
      this.lastCoverageFacts = buildCoverageFacts(
        quoteLoad.report,
        quoteLoad.quotes,
        this.lastNavSymbols,
        {
          now: new Date(),
          marketOpen: isUsMarketOpen(),
          publishHourFor: (symbol) => navPublishWindow(navStats.get(symbol)?.hours).publishHour,
          freshlyPulled: this.recentlyPulled(),
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
    // Prefer the live EUR→USD rate; fall back to the export meta rate.
    setEurUsdRate(fx.rates.USD ?? model.overview.fxRateEurUsd);
    this.renderDashboard(model);
    return quoteLoad.report;
  }

  /**
   * Handle a manual tap of the Refresh button. Always gives immediate feedback
   * the user can actually see: it shows the spinning glyph + "Refreshing prices…"
   * pill for a guaranteed minimum (so a cache-fast refresh doesn't flash by),
   * and — crucially — acknowledges the tap *even when an automatic pull is
   * already in flight*, where the old code silently bailed and the button felt
   * dead. On completion it confirms the outcome with a brief toast.
   */
  private manualRefresh(): void {
    if (this.refreshing) {
      // An automatic pull is already running and will paint fresh prices; we
      // can't start a second overlapping refresh, but the tap must not feel
      // ignored, so flash the manual feedback and let it clear on its minimum.
      this.setUpdating(true, "manual");
      this.setUpdating(false, "manual");
      this.toast("Already refreshing prices…");
      return;
    }
    // A manual tap means "pull new market values now": force a fresh fetch of
    // the tradeable holdings, bypassing the quote cache window — unless the daily
    // free-tier budget is nearly spent (<10% left), where we fall back to the
    // normal cache-respecting refresh so the reserve isn't burnt in one tap.
    const canForce = this.canForceRefresh();
    if (!canForce) this.toast("Low on data credits — showing recent cached prices.");
    void this.runScheduledRefresh(this.sessionId, "manual", { force: canForce });
  }

  /**
   * Whether enough of the daily free-tier credit budget remains to honour a
   * manual "pull now" with a forced live fetch. Below
   * {@link FORCE_REFRESH_MIN_CREDIT_FRACTION} of the day's budget a tap serves
   * the cache instead, so the last credits aren't spent all at once.
   */
  private canForceRefresh(): boolean {
    const now = Date.now();
    const used = creditsSpentWithin(readCreditLog(now), now, 24 * 60 * 60 * 1000);
    const remaining = Math.max(0, FREE_TIER.creditsPerDay - used);
    return remaining >= FREE_TIER.creditsPerDay * FORCE_REFRESH_MIN_CREDIT_FRACTION;
  }

  /**
   * Whether the app actually pulled fresh data from the network recently enough
   * to honestly claim holdings are "up to date" (see {@link UP_TO_DATE_WINDOW_MS}).
   * Gating the coverage summary on this means a refresh fully served from cache
   * never falsely reports everything current.
   */
  private recentlyPulled(): boolean {
    return this.lastDataPullAt !== null && Date.now() - this.lastDataPullAt < UP_TO_DATE_WINDOW_MS;
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
    opts: { force?: boolean } = {},
  ): Promise<void> {
    if (session !== this.sessionId) return;
    // A manual tap should refresh even when the tab is technically "hidden"
    // (e.g. mid-transition); only the automatic scheduler skips hidden tabs.
    if (kind === "auto" && typeof document !== "undefined" && document.hidden) return;
    if (this.refreshing) return;
    this.refreshing = true;
    this.setUpdating(true, kind);
    let report: QuoteLoadReport | null = null;
    try {
      report = await this.refreshPrices(session, true, { force: opts.force ?? false });
    } finally {
      this.refreshing = false;
    }
    if (session !== this.sessionId || report === null) {
      this.setUpdating(false, kind);
      return;
    }
    // The live refresh for this round is done: take the status pill down. While
    // a >per-minute-cap portfolio is still filling in we used to keep the pill
    // (with a live "N of M" count) up *between* burst rounds, but that left it
    // hovering on screen for seconds at a time — too much. The Refresh glyph
    // still spins during each actual fetch, and the per-row "as of" chips show
    // which holdings are still on last-known values, so the staged fill stays
    // visible without a persistent floating banner.
    this.setUpdating(false, kind);
    // Confirm the outcome of a manual tap so the user understands what happened
    // (fresh prices pulled, already up to date, or some deferred by the budget).
    if (kind === "manual") {
      this.toast(
        this.lastCoverageFacts
          ? manualRefreshSummary(this.lastCoverageFacts)
          : "Couldn't reach live prices — showing last known values",
      );
    }
    // "Prices all live" confirmation: when a portfolio is too big to price in a
    // single round it fills in over several burst rounds (the free-tier
    // per-minute cap). The moment the *last* still-deferred holding catches up —
    // i.e. we go from "some deferred" to "all live" — pop a brief confirmation
    // so the staged fill ends with a clear "you're fully up to date" signal
    // instead of silently stopping. Tracked across rounds so a portfolio that
    // was live all along stays quiet, and it only fires on the transition.
    const nowAllLive = allPricesLive(report);
    // Only the automatic scheduler pops this — a manual tap already gets the
    // descriptive manualRefreshSummary toast above (e.g. "All 18 holdings up to
    // date"), so firing both would double up.
    if (nowAllLive && !this.pricesAllLive && kind !== "manual") {
      this.toast("All prices live — every holding is now on a fresh price.");
    }
    this.pricesAllLive = nowAllLive;
    const delayMs = nextRefreshDelayMs({
      deferred: report.deferred,
      // Pace auto-refresh out as the rolling daily free-tier budget runs low.
      dayRemaining: report.dayRemaining,
      dayLimit: FREE_TIER.creditsPerDay,
    }, {
      // The steady-state cadence is user-configurable. After an off-cycle manual
      // tap this is also the gap before the next automatic refresh, so a manual
      // pull cleanly pushes the auto schedule out by the configured interval.
      slowIntervalMs: this.state.config.autoRefreshMinutes * 60 * 1000,
    });
    // Idea A — near-free freshness polling: piggy-back the cheap meta/304 blob
    // check so a fresh desktop publish is picked up automatically within a few
    // minutes, without the user reopening the app. A *manual* tap always checks
    // (the user is asking "is there anything new?"), and an automatic round
    // checks once it has settled into the slow cadence (nothing deferred) so it
    // doesn't compete with the startup burst. To keep the automatic check alive
    // for portfolios whose prices never fully stop deferring (more symbols than
    // the budget), it also runs on a slow wall-clock cadence regardless.
    if (kind === "manual" || report.deferred.length === 0 || this.blobCheckDue()) {
      void this.maybeRefreshBlob(session);
    }
    this.scheduleNext(session, delayMs);
  }

  /**
   * Whether enough wall-clock time has passed since the last background blob
   * check to run another one even while prices are still deferring. Ensures the
   * automatic new-data probe keeps firing for always-deferred portfolios instead
   * of being starved by a perpetual startup burst.
   */
  private blobCheckDue(): boolean {
    return Date.now() - this.lastBlobCheckAt >= BLOB_CHECK_MIN_INTERVAL_MS;
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
  }

  private removeVisibilityRefresh(): void {
    if (this.visibilityHandler && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
    }
    this.visibilityHandler = null;
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
    if (kind === "manual") {
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
      const base = kind === "manual" ? "Refreshing prices…" : "Auto-updating prices…";
      // Append a live "N of M" fill count when supplied, so a portfolio larger
      // than the per-minute budget shows visible progress across burst rounds.
      const label = detail ? `${base} ${detail}` : base;
      if (existing) {
        existing.classList.toggle("is-auto", kind === "auto");
        const text = existing.querySelector(".updating-pill-text");
        if (text) text.textContent = label;
        return;
      }
      const pill = h(
        "div",
        { id, class: kind === "auto" ? "updating-pill is-auto" : "updating-pill", role: "status", "aria-live": "polite" },
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

  /** A brief, auto-dismissing status message (e.g. biometric enrolment result). */
  private toast(message: string): void {
    if (typeof document === "undefined") return;
    const node = h("div", { class: "app-toast", role: "status", "aria-live": "polite" }, [message]);
    document.body.append(node);
    setTimeout(() => node.remove(), TOAST_DURATION_MS);
  }

  /**
   * Summarise any live-data gaps for a non-blocking banner, framed around the
   * free-tier budget. Returns null when everything was fresh and within budget.
   */
  private describeDegradation(
    quote: QuoteLoadReport,
    fx: { cached: boolean; error: PriceError | null },
  ): string | null {
    const reasons: string[] = [];

    // Daily free-tier budget: a distinct, useful signal — warn as it runs low
    // and clearly when it's gone, so the user understands why live updates are
    // spacing out or paused.
    if (quote.dayRemaining <= 0) {
      reasons.push(
        `Today's free-tier data budget (${FREE_TIER.creditsPerDay}/day) is used up — ` +
          `live updates pause until it resets.`,
      );
    } else if (quote.dayRemaining <= DAILY_BUDGET_WARN_CREDITS) {
      reasons.push(
        `Close to today's free-tier limit (${quote.dayRemaining} of ${FREE_TIER.creditsPerDay} ` +
          `credits left) — updates are spacing out to last the day.`,
      );
    }

    // A live-fetch gap. A rate limit (HTTP 429) and the *ordinary* staged fill
    // of a portfolio larger than the per-minute cap are the **same** underlying
    // situation — describe it once, not as two overlapping clauses. A genuine
    // staged fill isn't an error at all (the spinning glyph + "N of M" pill show
    // it as progress), so it raises no banner.
    const rateLimited = quote.error?.status === 429;
    const stagedFill = quote.dayRemaining > 0 && quote.error === null;
    const deferredByMinute = quote.deferred.length > 0 && !stagedFill;
    if (quote.error && !rateLimited) {
      // A real, non-rate-limit fetch problem (network blip, 404, 5xx).
      reasons.push("Live prices didn't refresh just now — showing last known values.");
    } else if (rateLimited || deferredByMinute) {
      reasons.push("Live prices are waiting on the free-tier limit — showing last known values for now.");
    }

    // Only surface FX when it's genuinely unavailable; a cached rate within its
    // (12h) freshness window is normal and not worth nagging about.
    if (fx.error && !fx.cached) {
      reasons.push("FX rates are temporarily unavailable.");
    }

    return reasons.length === 0 ? null : reasons.join(" ");
  }

  private renderDashboard(model: DashboardModel): void {
    this.model = model;
    this.mount(
      renderDashboard(
        model,
        () => this.manualRefresh(),
        () => this.lock(),
        () => this.reRenderCurrentModel(),
        () => this.showSettings(),
      ),
    );
  }

  /** Re-render the current model in place (e.g. after a currency toggle). */
  private reRenderCurrentModel(): void {
    if (this.model) this.renderDashboard(this.model);
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
    // Invalidate any in-flight background work and tear down the auto-refresh.
    this.sessionId += 1;
    this.clearRefreshTimer();
    this.removeVisibilityRefresh();
    this.removeAutoLock();
    this.clearManualFeedbackTimer();
    this.manualFeedbackUntil = 0;
    this.setUpdating(false);
    this.refreshing = false;
    this.state.passphrase = null;
    this.state.data = null;
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
  const total = report.fetched.length + report.servedFresh.length + report.deferred.length;
  const live = total - report.deferred.length;
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
  /** Market holdings on a fresh/held price (not deferred by the budget). */
  marketLive: number;
  /** NAV-priced funds requested this round. */
  navTotal: number;
  /**
   * NAV funds that have not yet published *today's* NAV (they strike after the
   * market closes) — the "expected tonight" count while the market is open.
   */
  navExpectedTonight: number;
  /**
   * NAV funds whose latest *due* NAV we don't yet hold (past their learned
   * publish hour and still missing) — the "awaiting" count once due. Zero over a
   * weekend/holiday, when the latest published NAV is genuinely the current one.
   */
  navAwaiting: number;
  /** Whether fresh data actually landed recently (else: "showing recent prices"). */
  freshlyPulled: boolean;
  /** A hard fetch error occurred this round (on last-known values). */
  error: boolean;
}

/** Local `YYYY-MM-DD` for `d` (matches the NAV value-date day boundary). */
function localDateIso(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Classify this refresh round into {@link CoverageFacts}: split the requested
 * symbols into market vs NAV, count how many market holdings are live, and judge
 * each NAV fund against both *today's* date (will it still publish tonight?) and
 * its latest *due* value-date (is it overdue right now?). `publishHourFor` is the
 * fund's learned publish hour (see {@link navPublishWindow}); it defaults to the
 * bootstrap {@link NAV_PUBLISH_HOUR} when nothing has been learned yet.
 */
export function buildCoverageFacts(
  report: QuoteLoadReport,
  quotes: ReadonlyMap<string, { valueDate?: string | null }>,
  navSymbols: ReadonlySet<string>,
  ctx: {
    now?: Date;
    marketOpen: boolean;
    publishHourFor?: (symbol: string) => number;
    freshlyPulled?: boolean;
  },
): CoverageFacts {
  const now = ctx.now ?? new Date();
  const publishHourFor = ctx.publishHourFor ?? (() => NAV_PUBLISH_HOUR);
  const deferred = new Set(report.deferred);
  const todayIso = localDateIso(now);
  let marketTotal = 0;
  let marketLive = 0;
  let navTotal = 0;
  let navExpectedTonight = 0;
  let navAwaiting = 0;
  for (const symbol of [...report.fetched, ...report.servedFresh, ...report.deferred]) {
    if (navSymbols.has(symbol)) {
      navTotal += 1;
      const held = quotes.get(symbol)?.valueDate ?? null;
      // Not yet holding today's NAV → it will publish later tonight.
      if (!held || held < todayIso) navExpectedTonight += 1;
      // Past its learned publish hour and still missing → genuinely overdue.
      if (!held || held < latestExpectedNavDate(now, publishHourFor(symbol))) navAwaiting += 1;
    } else {
      marketTotal += 1;
      if (!deferred.has(symbol)) marketLive += 1;
    }
  }
  return {
    marketOpen: ctx.marketOpen,
    marketTotal,
    marketLive,
    navTotal,
    navExpectedTonight,
    navAwaiting,
    freshlyPulled: ctx.freshlyPulled ?? true,
    error: report.error !== null,
  };
}

/** Pluralise "NAV"/"NAVs". */
function navWord(n: number): string {
  return n === 1 ? "NAV" : "NAVs";
}

/**
 * Turn {@link CoverageFacts} into a calm, *honest* one-liner. The point is to be
 * transparent about exactly what we pull and what we don't — never counting an
 * unpublished NAV as "live". It distinguishes the open- and closed-market
 * framings the user asked for, e.g.:
 *   - market open:   "13/13 live, 5 NAVs expected tonight"
 *   - market closed: "market closed for 13/13, awaiting 5/5 NAVs"
 *   - all current:   "market closed, all prices up to date"
 */
export function summarizeCoverage(f: CoverageFacts): string {
  const total = f.marketTotal + f.navTotal;
  if (total === 0) return "No live-priced holdings";
  if (f.error) return "Showing last known prices";
  // A refresh served entirely from cache (no fresh pull) must not assert things
  // are live/up to date — say plainly that these are recent, not just-fetched.
  if (!f.freshlyPulled) {
    return total === 1 ? "Showing recent prices" : `Showing recent prices (${total} holdings)`;
  }

  const marketHeld = f.marketTotal === 0 || f.marketLive === f.marketTotal;

  if (f.marketOpen) {
    const parts: string[] = [];
    if (f.marketTotal > 0) parts.push(`${f.marketLive}/${f.marketTotal} live`);
    if (f.navTotal > 0) {
      parts.push(
        f.navExpectedTonight > 0
          ? `${f.navExpectedTonight} ${navWord(f.navExpectedTonight)} expected tonight`
          : `${f.navTotal}/${f.navTotal} ${navWord(f.navTotal)} in`,
      );
    }
    return parts.join(", ");
  }

  // Market closed.
  if (marketHeld && f.navAwaiting === 0) return "market closed, all prices up to date";

  const parts: string[] = [];
  if (f.marketTotal > 0) {
    parts.push(
      marketHeld
        ? `market closed for ${f.marketLive}/${f.marketTotal}`
        : `market closed, ${f.marketLive}/${f.marketTotal} up to date`,
    );
  } else {
    parts.push("market closed");
  }
  if (f.navAwaiting > 0) {
    parts.push(`awaiting ${f.navAwaiting}/${f.navTotal} ${navWord(f.navAwaiting)}`);
  } else if (f.navTotal > 0) {
    parts.push(`${f.navTotal}/${f.navTotal} ${navWord(f.navTotal)} in`);
  }
  return parts.join(", ");
}

/**
 * A short, human summary of a manual refresh outcome for the confirmation toast,
 * so a tap always ends with a clear statement of what happened. Leads with the
 * transparent coverage line; only a genuine fetch failure overrides it.
 */
export function manualRefreshSummary(facts: CoverageFacts): string {
  if (facts.error) return "Couldn't reach live prices — showing last known values";
  return summarizeCoverage(facts);
}

/**
 * Interaction events that count as "activity" and reset the idle auto-lock
 * countdown. Kept passive and broad enough to cover touch, mouse and keyboard
 * use without interfering with the page's own handlers.
 */
const AUTO_LOCK_ACTIVITY_EVENTS = [
  "pointerdown",
  "keydown",
  "scroll",
  "touchstart",
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

/** Parse + clamp the quote-cache minutes input to a sane 1–240 range. */
function clampCacheMinutes(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_QUOTE_CACHE_MINUTES;
  return Math.min(240, Math.round(n));
}
