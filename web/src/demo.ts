/**
 * Demo / preview mode — a self-contained, always-live-looking sample dashboard.
 *
 * Anyone can *see and click through the UI* without an API key, a mobile
 * passphrase, or a published `portfolio.enc` blob: all data is synthetic and
 * generated in the browser (see `demo-data.ts`), so nothing is fetched from the
 * network and no real financial data is involved.
 *
 * It reuses the real `buildDashboard` pipeline so the preview renders with the
 * exact same compute + layout code as the live app — only the inputs are
 * generated. Those inputs describe a live US trading day (see `demo-clock.ts`):
 * today's quotes follow a seeded minute-by-minute session path evaluated at the
 * current (faked) time, so the headline value, today's move, the 1D/1W charts
 * and the freshness chips all tell one consistent story and tick forward as time
 * passes.
 *
 *   1. **Personas** — a small registry of distinct sample portfolios (a global
 *      ETF saver, a US tech-heavy book, an FX-diverging euro investor).
 *      Deep-linkable via `?demo=tech`.
 *   2. **Generated ledger** — each persona replays ~3 years of deposits, buys,
 *      dividends and interest over seeded price/FX paths, so every figure
 *      (holdings, periods, risk, attribution) comes from one simulation.
 *   3. **Deep-linking** — `parseDemoParams` reads `?demo=…&tab=…&tour=…&sim=…`
 *      so a shared link can boot straight into a chosen persona, tab and tour.
 */
import { buildDashboard, type DashboardModel } from "./compute";
import { buildScene, DEMO_SPECS, type DemoScene, type PersonaSpec } from "./demo-data";
import type { LiveGraphHooks } from "./ui";

export interface DemoPersona {
  /** Stable id used in the `?demo=<id>` deep link and the banner switcher. */
  id: string;
  /** Short label for the switcher. */
  label: string;
  /** One-line "story" shown in the banner. */
  tagline: string;
  spec: PersonaSpec;
}

export const DEMO_PERSONAS: readonly DemoPersona[] = DEMO_SPECS.map((spec) => ({
  id: spec.id,
  label: spec.label,
  tagline: spec.tagline,
  spec,
}));

/** The persona shown when `?demo` carries no (recognised) id. */
export const DEFAULT_PERSONA_ID = DEMO_PERSONAS[0].id;

/** Look up a persona by id, falling back to the default when unknown. */
export function getPersona(id: string | null | undefined): DemoPersona {
  return DEMO_PERSONAS.find((p) => p.id === id) ?? DEMO_PERSONAS[0];
}

/** True in the public, demo-only build (`VITE_DEMO_ONLY=1`): no real-data path at all. */
export function isDemoOnly(): boolean {
  return import.meta.env.VITE_DEMO_ONLY === "1";
}

// ---------------------------------------------------------------------------
// Model builder
// ---------------------------------------------------------------------------

export interface BuildDemoOptions {
  /** Persona id (see {@link DEMO_PERSONAS}); defaults to the global saver. */
  persona?: string;
  /** The instant to describe; defaults to the (faked) current time. */
  now?: Date;
}

export interface DemoRender {
  model: DashboardModel;
  scene: DemoScene;
  /** Zero-network 1D/1W builders for the value chart, ending on the headline. */
  hooks: LiveGraphHooks;
}

/**
 * Build a full sample dashboard for `now`: the generated export + live quotes run
 * through the real compute pipeline, then stamped like a healthy live session
 * (last pull, FX session-open anchor, coverage line).
 */
export function buildDemoRender(options: BuildDemoOptions = {}): DemoRender {
  const persona = getPersona(options.persona);
  const now = options.now ?? new Date();
  const scene = buildScene(persona.spec, now);
  const model = buildDashboard(scene.data, scene.quotes, scene.fx, now, null, {
    fxPrevEurUsd: scene.fxPrevEurUsd,
    fxEurUsdSource: "live",
    fxObservedAt: scene.nowMs,
  });
  model.overview.lastDataPullAt = scene.nowMs;
  model.overview.fxRateEurUsdSessionOpen = scene.fxSessionOpen;
  model.overview.liveCoverage = scene.coverage;
  const hooks: LiveGraphHooks = {
    session: async () => ({ points: scene.session() }),
    week: async () => scene.week(),
  };
  return { model, scene, hooks };
}

/** Convenience wrapper: just the dashboard model. */
export function buildDemoModel(options: BuildDemoOptions = {}): DashboardModel {
  return buildDemoRender(options).model;
}

// ---------------------------------------------------------------------------
// Deep-link parsing
// ---------------------------------------------------------------------------

/** Tab ids the demo deep link may target (mirrors the dashboard tab bar). */
export const DEMO_TAB_IDS = ["overview", "periods", "transactions", "analytics", "plan"] as const;
export type DemoTabId = (typeof DEMO_TAB_IDS)[number];

export interface DemoParams {
  /** Whether demo/preview mode was requested at all. */
  requested: boolean;
  /** Resolved persona id (always a valid id when {@link requested}). */
  persona: string;
  /** Tab to open on entry, or null to use the remembered tab. */
  tab: DemoTabId | null;
  /** Whether to auto-start the guided tour. */
  tour: boolean;
  /** Whether to start in live-sim (moving) mode rather than frozen. */
  sim: boolean;
}

function truthyFlag(value: string | null): boolean {
  if (value === null) return false;
  const v = value.toLowerCase();
  return v === "" || v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Parse the demo deep-link from a URL query string (e.g. `?demo=tech&tab=risk`).
 *
 * Recognises `?demo` and the `?preview` alias. `demo`/`preview` may also name a
 * persona directly (`?demo=tech`). `tab` accepts the tab id or the friendly
 * "risk"/"calculator" aliases. `tour`/`sim` are boolean-ish flags. All inputs
 * are validated and clamped to known values so a malformed link can never do
 * anything but fall back to the default persona/overview.
 */
export function parseDemoParams(search: string): DemoParams {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    params = new URLSearchParams();
  }
  const requested = params.has("demo") || params.has("preview");
  const rawPersona = params.get("demo") ?? params.get("preview") ?? "";
  const persona = getPersona(rawPersona).id;

  const rawTab = (params.get("tab") ?? "").toLowerCase();
  const tabAlias =
    rawTab === "risk"
      ? "analytics"
      : rawTab === "calculator"
        ? "plan"
        : rawTab === "activity"
          ? "transactions"
          : rawTab;
  const tab = (DEMO_TAB_IDS as readonly string[]).includes(tabAlias) ? (tabAlias as DemoTabId) : null;

  return {
    requested,
    persona,
    tab,
    tour: truthyFlag(params.get("tour")),
    sim: truthyFlag(params.get("sim")),
  };
}
