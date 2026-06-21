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
import { fetchEnvelope } from "./blob";
import { buildDashboard, type DashboardModel } from "./compute";
import { decryptEnvelopeToJson, type Envelope } from "./crypto";
import { buildDemoModel } from "./demo";
import {
  isValidRepo,
  loadConfig,
  resolveBlobUrl,
  saveConfig,
  DEFAULT_QUOTE_CACHE_MINUTES,
  type AppConfig,
} from "./config";
import { PriceError, type FxRates } from "./prices";
import {
  readCachedEnvelope,
  readCachedFx,
  readNavPublishStats,
  recordNavPublish,
  writeCachedEnvelope,
} from "./cache";
import {
  DEFAULT_NAV_CACHE_TTL_MS,
  FREE_TIER,
  loadFxRates,
  loadQuotes,
  navCacheTtlMs,
  navPublishWindow,
  type LoadQuotesOptions,
  type QuoteLoadReport,
} from "./quotes";
import { nextRefreshDelayMs } from "./refresh-policy";
import {
  enrolBiometric,
  hasBiometricEnrolment,
  isBiometricSupported,
  unlockWithBiometric,
} from "./webauthn";
import { setEurUsdRate } from "./currency";
import type { MobileExport } from "./types";
import { h, renderDashboard } from "./ui";

/**
 * Skip the background re-download of the encrypted blob if the copy we have was
 * fetched within this window. Re-opening the app seconds after closing it can't
 * have a newer export, so there's nothing to fetch — go straight to the data.
 */
const BLOB_REFETCH_MIN_INTERVAL_MS = 2 * 60 * 1000;

/** How long an auto-dismissing status toast stays on screen. */
const TOAST_DURATION_MS = 4500;

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

  constructor(root: HTMLElement) {
    this.root = root;
    this.state = { config: loadConfig(), passphrase: null, data: null };
  }

  start(): void {
    if (this.demoRequested()) this.showDemo();
    else if (!this.isConfigured()) this.showSetup();
    else this.showUnlock();
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

  private showSetup(error?: string): void {
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

    const form = h("form", { class: "panel", novalidate: "novalidate" }, [
      h("h1", {}, ["Set up the companion"]),
      h("p", { class: "muted" }, [
        "These stay on this device. The API key powers live quotes; the repository tells the app where to find your encrypted data.",
      ]),
      field("Price API key", apiKey, "Free key from twelvedata.com — never leaves this device."),
      field("Data repository", repo, "The repo that hosts your published portfolio.enc release asset."),
      field("Release tag", tag, "Defaults to live-data."),
      field("Blob URL override", blobUrl, "Advanced: a direct, CORS-enabled URL (e.g. your web/proxy Worker) to fetch the encrypted blob from, instead of the release asset."),
      field("Quote cache (minutes)", cacheMinutes, "Free tier is 8 credits/min, 800/day (1 per symbol). A longer cache means fewer refetches and fewer credits spent."),
      error ? h("p", { class: "note err" }, [error]) : document.createTextNode(""),
      h("button", { class: "btn", type: "submit" }, ["Save & continue"]),
      h("button", { class: "btn ghost", type: "button", "data-action": "demo" }, [
        "Preview the dashboard with sample data",
      ]),
    ]);

    form.querySelector('[data-action="demo"]')?.addEventListener("click", () => this.showDemo());

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const next: AppConfig = {
        apiKey: (apiKey as HTMLInputElement).value.trim(),
        repo: (repo as HTMLInputElement).value.trim(),
        releaseTag: (tag as HTMLInputElement).value.trim() || "live-data",
        blobUrl: (blobUrl as HTMLInputElement).value.trim(),
        quoteCacheMinutes: clampCacheMinutes((cacheMinutes as HTMLInputElement).value),
      };
      if (!next.apiKey) return this.showSetup("Enter your price API key.");
      const hasSource = next.blobUrl.length > 0 || isValidRepo(next.repo);
      if (!hasSource) return this.showSetup("Enter a valid owner/repository or a direct blob URL.");
      this.state.config = next;
      saveConfig(next);
      return this.showUnlock();
    });

    this.mount(h("div", { class: "screen" }, [form]));
  }

  // --- Unlock screen ----------------------------------------------------------

  private showUnlock(error?: string): void {
    const pass = h("input", {
      type: "password",
      id: "f-pass",
      autocomplete: "off",
      placeholder: "Mobile passphrase",
    });
    // Optional "remember with fingerprint" enrolment — revealed only on devices
    // with a platform authenticator (see addBiometricControls).
    const enrol = h("input", { type: "checkbox", id: "f-bio" }) as HTMLInputElement;
    const enrolField = h("label", { class: "field check", hidden: "hidden" }, [
      enrol,
      h("span", {}, ["Enable fingerprint unlock on this device"]),
    ]);
    const form = h("form", { class: "panel", novalidate: "novalidate" }, [
      h("h1", {}, ["Unlock"]),
      h("p", { class: "muted" }, ["Your passphrase decrypts the data in this browser. It is never stored or sent."]),
      field("Passphrase", pass),
      enrolField,
      error ? h("p", { class: "note err" }, [error]) : document.createTextNode(""),
      h("div", { class: "row" }, [
        h("button", { class: "btn", type: "submit" }, ["Unlock"]),
        h("button", { class: "btn ghost", type: "button", "data-action": "settings" }, ["Settings"]),
      ]),
    ]);
    form.querySelector('[data-action="settings"]')?.addEventListener("click", () => this.showSetup());
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const passphrase = (pass as HTMLInputElement).value;
      if (!passphrase) return this.showUnlock("Enter your passphrase.");
      void this.unlock(passphrase, enrol.checked);
      return undefined;
    });
    this.mount(h("div", { class: "screen" }, [form]));
    (pass as HTMLInputElement).focus();
    void this.addBiometricControls(form, enrolField);
  }

  /**
   * Progressively enhance the unlock screen with biometrics: a one-touch
   * "Unlock with fingerprint" button when already enrolled, or the enrolment
   * checkbox when the device has a platform authenticator but isn't set up yet.
   * Done async so an unsupported device just shows the plain passphrase form.
   */
  private async addBiometricControls(form: HTMLElement, enrolField: HTMLElement): Promise<void> {
    if (hasBiometricEnrolment()) {
      const btn = h("button", { class: "btn bio", type: "button" }, [
        h("span", { "aria-hidden": "true" }, ["☝ "]),
        "Unlock with fingerprint",
      ]);
      btn.addEventListener("click", () => void this.unlockBiometric());
      form.querySelector("h1")?.after(btn);
      // Auto-prompt: most users who enrolled want the touch immediately.
      btn.focus();
      return;
    }
    if (await isBiometricSupported()) enrolField.hidden = false;
  }

  /** Attempt a fingerprint unlock, then run the normal decrypt pipeline. */
  private async unlockBiometric(): Promise<void> {
    try {
      const passphrase = await unlockWithBiometric();
      await this.unlock(passphrase, false);
    } catch (err) {
      this.showUnlock((err as Error).message);
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
        this.state.config = loadConfig();
        if (this.isConfigured()) this.showUnlock();
        else this.showSetup();
      },
      () => this.showDemo(),
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
      const envelope = await fetchEnvelope(url);
      this.showStatus("Decrypting…");
      const data = await decryptEnvelopeToJson<MobileExport>(envelope, passphrase);
      this.state.passphrase = passphrase;
      this.state.data = data;
      this.envelope = envelope;
      this.envelopeAt = Date.now();
      writeCachedEnvelope(envelope, this.envelopeAt);
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
  }

  /**
   * Re-download the encrypted blob in the background and, if it actually
   * changed, decrypt and re-render. Skipped when the cached blob is only seconds
   * old (a quick re-open can't have a newer export). Failures are swallowed —
   * the already-rendered cached data stands.
   */
  private async maybeRefreshBlob(session: number): Promise<void> {
    const { config, passphrase } = this.state;
    if (!passphrase) return;
    if (this.envelopeAt !== null && Date.now() - this.envelopeAt < BLOB_REFETCH_MIN_INTERVAL_MS) return;
    const url = resolveBlobUrl(config);
    if (!url) return;
    try {
      const envelope = await fetchEnvelope(url);
      if (session !== this.sessionId) return;
      this.envelopeAt = Date.now();
      writeCachedEnvelope(envelope, this.envelopeAt);
      // Nothing to do if the ciphertext is byte-for-byte what we already have.
      if (this.envelope && envelope.ciphertext === this.envelope.ciphertext && envelope.nonce === this.envelope.nonce) {
        return;
      }
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

  /** The symbols to price live, and the (NAV-aware) loadQuotes options. */
  private quoteRequest(data: MobileExport, config: AppConfig): { symbols: string[]; options: LoadQuotesOptions } {
    // Market holdings always fetch live; NAV holdings that are real funds
    // (mutual / money-market) also fetch, so their once-a-day NAV tracks the
    // latest published value instead of being frozen at the export. Synthetic
    // cash/savings rows have no ticker and are left to their exported value.
    const navFetchSymbols = new Set<string>();
    const symbols = data.holdings
      .filter((holding) => {
        if (holding.price_type === "market") return true;
        if (FETCHABLE_NAV_CLASSES.has(holding.asset_class)) {
          navFetchSymbols.add(holding.price_symbol);
          return true;
        }
        return false;
      })
      .map((holding) => holding.price_symbol);

    const cacheTtlMs = config.quoteCacheMinutes * 60 * 1000;
    // Per-symbol learned publish windows: when each fund's NAV has historically
    // landed, so we poll within that tight band instead of a fixed evening guess.
    const navStats = readNavPublishStats();
    const options: LoadQuotesOptions = {
      cacheTtlMs,
      cacheTtlMsForSymbol: (symbol, cached) => {
        if (!navFetchSymbols.has(symbol)) return cacheTtlMs;
        const { publishHour, catchUpWindowHours } = navPublishWindow(navStats.get(symbol)?.hours);
        return navCacheTtlMs(cached?.quote, {
          shortTtlMs: cacheTtlMs,
          longTtlMs: DEFAULT_NAV_CACHE_TTL_MS,
          publishHour,
          catchUpWindowHours,
        });
      },
      // Learn each fund's real publish time from when its value-date advances.
      onValueDateAdvance: (symbol, valueDate, at) => {
        if (navFetchSymbols.has(symbol)) recordNavPublish(symbol, valueDate, at);
      },
    };
    return { symbols, options };
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
  private async refreshPrices(session: number, network: boolean): Promise<QuoteLoadReport | null> {
    const { data, config } = this.state;
    if (!data) return null;

    const { symbols, options } = this.quoteRequest(data, config);
    const apiKey = network ? config.apiKey : "";
    const quotePromise = loadQuotes(symbols, apiKey, options);

    let fx: FxRates;
    let fxReport: { cached: boolean; error: PriceError | null };
    if (network) {
      const fxLoad = await loadFxRates();
      fx = fxLoad.fx;
      fxReport = fxLoad;
    } else {
      // Cache-only paint: don't touch the network for FX either.
      const cachedFx = readCachedFx();
      fx = cachedFx?.fx ?? { base: "EUR", rates: {} };
      fxReport = { cached: cachedFx !== null, error: null };
    }

    const quoteLoad = await quotePromise;
    // A superseded session (lock, or a newer unlock) must not paint over the UI.
    if (session !== this.sessionId) return quoteLoad.report;

    // A non-retryable quote failure (e.g. a bad/rejected API key) is a config
    // problem the user must act on, so keep the explicit error screen with a
    // route to Settings.
    if (network && quoteLoad.report.error && !quoteLoad.report.error.retryable) {
      this.renderLoadError(quoteLoad.report.error.message);
      return null;
    }

    const degradedReason = network ? this.describeDegradation(quoteLoad.report, fxReport) : null;
    const model = buildDashboard(data, quoteLoad.quotes, fx, new Date(), degradedReason);
    // Prefer the live EUR→USD rate; fall back to the export meta rate.
    setEurUsdRate(fx.rates.USD ?? model.overview.fxRateEurUsd);
    this.renderDashboard(model);
    return quoteLoad.report;
  }

  /**
   * One auto-refresh tick: do a live refresh and schedule the next one. On
   * startup, while symbols are still being filled in (deferred to stay within
   * the free-tier per-minute budget), it bursts roughly once a minute so every
   * holding reaches its latest price as fast as the rate limit allows; once
   * nothing is deferred it relaxes to a slow steady-state cadence. Paused while
   * the tab is hidden (resumed by the visibility listener).
   */
  private async runScheduledRefresh(session: number): Promise<void> {
    if (session !== this.sessionId) return;
    if (typeof document !== "undefined" && document.hidden) return;
    if (this.refreshing) return;
    this.refreshing = true;
    this.setUpdating(true);
    let report: QuoteLoadReport | null = null;
    try {
      report = await this.refreshPrices(session, true);
    } finally {
      this.refreshing = false;
      this.setUpdating(false);
    }
    if (session !== this.sessionId || report === null) return;
    this.scheduleNext(session, nextRefreshDelayMs({ deferred: report.deferred }));
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

  /** Toggle a small, unobtrusive "Updating…" pill while a live refresh runs. */
  private setUpdating(on: boolean): void {
    if (typeof document === "undefined") return;
    const id = "updating-pill";
    const existing = document.getElementById(id);
    if (on) {
      if (existing) return;
      document.body.append(
        h("div", { id, class: "updating-pill", role: "status", "aria-live": "polite" }, ["Updating…"]),
      );
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
    if (quote.error) {
      reasons.push(`live prices hit a snag (${quote.error.message})`);
    }
    if (quote.deferred.length > 0) {
      const n = quote.deferred.length;
      reasons.push(
        `${n} symbol${n === 1 ? "" : "s"} deferred to stay within your free-tier limit ` +
          `(${FREE_TIER.creditsPerMinute}/min) — they'll refresh on the next update`,
      );
    }
    if (fx.error) {
      reasons.push(
        fx.cached ? "FX rates are using the last cached values" : `FX rates unavailable (${fx.error.message})`,
      );
    }
    if (reasons.length === 0) return null;
    return `${reasons.join("; ")}. Showing your last known values where needed.`;
  }

  private renderDashboard(model: DashboardModel): void {
    this.model = model;
    this.mount(
      renderDashboard(
        model,
        () => void this.runScheduledRefresh(this.sessionId),
        () => this.lock(),
        () => this.reRenderCurrentModel(),
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
      ?.addEventListener("click", () => void this.runScheduledRefresh(this.sessionId));
    panel.querySelector('[data-action="settings"]')?.addEventListener("click", () => this.showSetup());
    this.mount(h("div", { class: "screen" }, [panel]));
  }

  private lock(): void {
    // Invalidate any in-flight background work and tear down the auto-refresh.
    this.sessionId += 1;
    this.clearRefreshTimer();
    this.removeVisibilityRefresh();
    this.setUpdating(false);
    this.refreshing = false;
    this.state.passphrase = null;
    this.state.data = null;
    this.showUnlock();
  }
}

function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  const children: Array<Node | string> = [h("span", { class: "field-label" }, [label]), input];
  if (hint) children.push(h("span", { class: "field-hint" }, [hint]));
  return h("label", { class: "field" }, children);
}

/** Parse + clamp the quote-cache minutes input to a sane 1–240 range. */
function clampCacheMinutes(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_QUOTE_CACHE_MINUTES;
  return Math.min(240, Math.round(n));
}
