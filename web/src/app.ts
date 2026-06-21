/**
 * Application controller: a small state machine wiring the screens together.
 *
 *   setup ─▶ unlock ─▶ (fetch blob ▶ decrypt ▶ fetch live data ▶ compute) ─▶ dashboard
 *
 * Secrets handling: the Twelve Data API key is device-local config
 * (`localStorage`); the mobile passphrase is kept in memory only for the active
 * session and dropped on "Lock". Decrypted figures never leave the browser.
 */
import { fetchEnvelope } from "./blob";
import { buildDashboard, type DashboardModel } from "./compute";
import { decryptEnvelopeToJson } from "./crypto";
import { buildDemoModel } from "./demo";
import {
  isValidRepo,
  loadConfig,
  resolveBlobUrl,
  saveConfig,
  DEFAULT_QUOTE_CACHE_MINUTES,
  type AppConfig,
} from "./config";
import { PriceError } from "./prices";
import { readNavPublishStats, recordNavPublish } from "./cache";
import {
  DEFAULT_NAV_CACHE_TTL_MS,
  FREE_TIER,
  loadFxRates,
  loadQuotes,
  navCacheTtlMs,
  navPublishWindow,
  type QuoteLoadReport,
} from "./quotes";
import { setEurUsdRate } from "./currency";
import type { MobileExport } from "./types";
import { h, renderDashboard, renderThemeToggle } from "./ui";

/**
 * NAV-priced asset classes that are real, tickered funds and so can be priced
 * live (their NAV publishes ~once a day). Synthetic `cash`/`savings` rows are
 * deliberately excluded — they have no market ticker.
 */
const FETCHABLE_NAV_CLASSES = new Set(["mutual_fund", "money_market", "money-market"]);

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
      field("Price API key", apiKey, "Free key from twelvedata.com — never leaves this device."),
      field("Data repository", repo, "The repo that hosts your published portfolio.enc release asset."),
      field("Release tag", tag, "Defaults to live-data."),
      field("Blob URL override", blobUrl, "Advanced: a direct, CORS-enabled URL (e.g. your web/proxy Worker) to fetch the encrypted blob from, instead of the release asset."),
      field("Quote cache (minutes)", cacheMinutes, "Free tier is 8 credits/min, 800/day (1 per symbol). A longer cache means fewer refetches and fewer credits spent."),
    ];
    // Appearance (light / dark / system) lives in Settings instead of crowding
    // the dashboard topbar.
    if (settingsMode) {
      formChildren.push(
        field("Appearance", renderThemeToggle(), "Switch between system, light and dark themes."),
      );
    }
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
        quoteCacheMinutes: clampCacheMinutes((cacheMinutes as HTMLInputElement).value),
      };
      if (!next.apiKey) return this.showSetup("Enter your price API key.", mode);
      const hasSource = next.blobUrl.length > 0 || isValidRepo(next.repo);
      if (!hasSource) return this.showSetup("Enter a valid owner/repository or a direct blob URL.", mode);
      this.state.config = next;
      saveConfig(next);
      // In Settings (already unlocked) re-run the load pipeline with the new
      // config; otherwise continue the first-run flow to the unlock screen.
      if (settingsMode && this.state.data) {
        void this.refresh();
        return undefined;
      }
      return this.showUnlock();
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

  private showUnlock(error?: string): void {
    const pass = h("input", {
      type: "password",
      id: "f-pass",
      autocomplete: "off",
      placeholder: "Mobile passphrase",
    });
    const form = h("form", { class: "panel", novalidate: "novalidate" }, [
      h("h1", {}, ["Unlock"]),
      h("p", { class: "muted" }, ["Your passphrase decrypts the data in this browser. It is never stored or sent."]),
      field("Passphrase", pass),
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
      void this.unlock(passphrase);
      return undefined;
    });
    this.mount(h("div", { class: "screen" }, [form]));
    (pass as HTMLInputElement).focus();
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
      () => this.showSettings(),
      "Exit demo",
    );
    this.mount(h("div", { class: "demo-shell" }, [banner, dashboard]));
  }

  // --- Load pipeline ----------------------------------------------------------

  private async unlock(passphrase: string): Promise<void> {
    this.showStatus("Downloading encrypted data…");
    const url = resolveBlobUrl(this.state.config);
    if (!url) return this.showSetup("No data source configured.");
    try {
      const envelope = await fetchEnvelope(url);
      this.showStatus("Decrypting…");
      const data = await decryptEnvelopeToJson<MobileExport>(envelope, passphrase);
      this.state.passphrase = passphrase;
      this.state.data = data;
      await this.refresh();
    } catch (err) {
      this.showUnlock((err as Error).message);
    }
    return undefined;
  }

  private async refresh(): Promise<void> {
    const { data, config } = this.state;
    if (!data) return this.showUnlock();
    this.showStatus("Fetching live prices…");

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

    // Free-tier-aware loaders: quotes economise on Twelve Data credits (cache +
    // per-minute/day budgeting + retry-with-backoff); FX prefers a daily cache.
    // NAV symbols normally sit on a long (daily-ish) freshness window, but
    // within each fund's learned publish window they poll harder until today's
    // fresh NAV lands — then relax again — so updates are caught promptly
    // without burning the credit budget the rest of the day.
    const cacheTtlMs = config.quoteCacheMinutes * 60 * 1000;
    // Per-symbol learned publish windows: when each fund's NAV has historically
    // landed, so we poll within that tight band instead of a fixed evening guess.
    const navStats = readNavPublishStats();
    const [quoteLoad, fxLoad] = await Promise.all([
      loadQuotes(symbols, config.apiKey, {
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
      }),
      loadFxRates(),
    ]);

    // A non-retryable quote failure (e.g. a bad/rejected API key) is a config
    // problem the user must act on, so keep the explicit error screen with a
    // route to Settings.
    if (quoteLoad.report.error && !quoteLoad.report.error.retryable) {
      return this.renderLoadError(quoteLoad.report.error.message);
    }

    const fx = fxLoad.fx;
    const degradedReason = this.describeDegradation(quoteLoad.report, fxLoad);
    const model = buildDashboard(data, quoteLoad.quotes, fx, new Date(), degradedReason);
    // Prefer the live EUR→USD rate; fall back to the export meta rate.
    setEurUsdRate(fx.rates.USD ?? model.overview.fxRateEurUsd);
    this.renderDashboard(model);
    return undefined;
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
        () => void this.refresh(),
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
    panel.querySelector('[data-action="retry"]')?.addEventListener("click", () => void this.refresh());
    panel.querySelector('[data-action="settings"]')?.addEventListener("click", () => this.showSetup());
    this.mount(h("div", { class: "screen" }, [panel]));
  }

  private lock(): void {
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
