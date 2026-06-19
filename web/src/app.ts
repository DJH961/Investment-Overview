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
import {
  isValidRepo,
  loadConfig,
  resolveBlobUrl,
  saveConfig,
  type AppConfig,
} from "./config";
import { fetchFxRates, fetchQuotes } from "./prices";
import type { MobileExport } from "./types";
import { h, renderDashboard } from "./ui";

interface SessionState {
  config: AppConfig;
  passphrase: string | null;
  data: MobileExport | null;
}

export class App {
  private readonly root: HTMLElement;
  private readonly state: SessionState;

  constructor(root: HTMLElement) {
    this.root = root;
    this.state = { config: loadConfig(), passphrase: null, data: null };
  }

  start(): void {
    if (!this.isConfigured()) this.showSetup();
    else this.showUnlock();
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

    const form = h("form", { class: "panel", novalidate: "novalidate" }, [
      h("h1", {}, ["Set up the companion"]),
      h("p", { class: "muted" }, [
        "These stay on this device. The API key powers live quotes; the repository tells the app where to find your encrypted data.",
      ]),
      field("Price API key", apiKey, "Free key from twelvedata.com — never leaves this device."),
      field("Data repository", repo, "The repo that hosts your published portfolio.enc release asset."),
      field("Release tag", tag, "Defaults to live-data."),
      field("Blob URL override", blobUrl, "Advanced: use a direct URL instead of the release asset."),
      error ? h("p", { class: "note err" }, [error]) : document.createTextNode(""),
      h("button", { class: "btn", type: "submit" }, ["Save & continue"]),
    ]);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const next: AppConfig = {
        apiKey: (apiKey as HTMLInputElement).value.trim(),
        repo: (repo as HTMLInputElement).value.trim(),
        releaseTag: (tag as HTMLInputElement).value.trim() || "live-data",
        blobUrl: (blobUrl as HTMLInputElement).value.trim(),
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
    try {
      const symbols = data.holdings
        .filter((holding) => holding.price_type === "market")
        .map((holding) => holding.price_symbol);
      const [quotes, fx] = await Promise.all([
        symbols.length > 0 ? fetchQuotes(symbols, config.apiKey) : Promise.resolve(new Map()),
        fetchFxRates("EUR"),
      ]);
      const model = buildDashboard(data, quotes, fx);
      this.renderDashboard(model);
    } catch (err) {
      this.renderLoadError((err as Error).message);
    }
    return undefined;
  }

  private renderDashboard(model: DashboardModel): void {
    this.mount(
      renderDashboard(
        model,
        () => void this.refresh(),
        () => this.lock(),
      ),
    );
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
