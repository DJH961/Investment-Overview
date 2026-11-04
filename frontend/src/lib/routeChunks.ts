/**
 * Lazy page chunks. Overview and Login stay in the main bundle; everything else is
 * split out and preloaded when the browser is idle after first render, so the first
 * tap on a page finds its code already downloaded.
 */
import { lazy, type ComponentType } from "react";

type Loader = () => Promise<{ default: ComponentType }>;

const loaders = {
  Holdings: () => import("../pages/Holdings").then((m) => ({ default: m.Holdings })),
  Periods: () => import("../pages/Periods").then((m) => ({ default: m.Periods })),
  Activity: () => import("../pages/Activity").then((m) => ({ default: m.Activity })),
  Risk: () => import("../pages/Risk").then((m) => ({ default: m.Risk })),
  Projection: () => import("../pages/Projection").then((m) => ({ default: m.Projection })),
  Transactions: () => import("../pages/Transactions").then((m) => ({ default: m.Transactions })),
  Import: () => import("../pages/Import").then((m) => ({ default: m.Import })),
  Instruments: () => import("../pages/Instruments").then((m) => ({ default: m.Instruments })),
  CurrencyConversions: () => import("../pages/CurrencyConversions").then((m) => ({ default: m.CurrencyConversions })),
  Allocations: () => import("../pages/Allocations").then((m) => ({ default: m.Allocations })),
  Diagnostics: () => import("../pages/Diagnostics").then((m) => ({ default: m.Diagnostics })),
  Settings: () => import("../pages/Settings").then((m) => ({ default: m.Settings })),
  Help: () => import("../pages/Help").then((m) => ({ default: m.Help })),
  Onboarding: () => import("../pages/Onboarding").then((m) => ({ default: m.Onboarding })),
  Styleguide: () => import("../pages/Styleguide").then((m) => ({ default: m.Styleguide })),
  NotFound: () => import("../pages/NotFound").then((m) => ({ default: m.NotFound })),
} satisfies Record<string, Loader>;

export type PageName = keyof typeof loaders;

export const Pages = Object.fromEntries(
  (Object.keys(loaders) as PageName[]).map((name) => [name, lazy(loaders[name])]),
) as Record<PageName, ReturnType<typeof lazy>>;

/** Pages the owner opens often, first; the rest follow. */
const PRELOAD_ORDER: PageName[] = [
  "Holdings",
  "Transactions",
  "Periods",
  "Activity",
  "Allocations",
  "Settings",
  "Risk",
  "Projection",
  "Instruments",
  "CurrencyConversions",
  "Import",
  "Diagnostics",
  "Help",
  "Onboarding",
  "NotFound",
];

type IdleScheduler = (cb: () => void) => void;

const defaultIdle: IdleScheduler = (cb) => {
  const w = globalThis as { requestIdleCallback?: (cb: () => void) => number };
  if (typeof w.requestIdleCallback === "function") w.requestIdleCallback(cb);
  else setTimeout(cb, 200);
};

/**
 * Download the page chunks one per idle slot (never in a burst). Failures are ignored:
 * the page simply loads when first opened. Returns a cancel function.
 */
export function preloadPages(
  schedule: IdleScheduler = defaultIdle,
  load: (name: PageName) => Promise<unknown> = (n) => loaders[n](),
): () => void {
  let cancelled = false;
  let i = 0;
  const step = () => {
    if (cancelled || i >= PRELOAD_ORDER.length) return;
    const name = PRELOAD_ORDER[i++]!;
    void Promise.resolve(load(name))
      .catch(() => undefined)
      .then(() => schedule(step));
  };
  schedule(step);
  return () => {
    cancelled = true;
  };
}
