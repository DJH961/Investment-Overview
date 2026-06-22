/**
 * The companion's build version, kept in lock-step with the main app's version
 * by CI. `__APP_VERSION__` is a compile-time constant injected by Vite/Vitest
 * from `package.json` (see vite.config.ts / vitest.config.ts); the `"dev"`
 * fallback only applies when the define is somehow absent (e.g. a bare `tsc`).
 */
declare const __APP_VERSION__: string;

export const APP_VERSION: string =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
