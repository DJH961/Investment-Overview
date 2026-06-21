/**
 * Entry point. Configures decimal.js precision (via the shared module side
 * effect), bundles the modern Inter typeface (self-hosted — no third-party
 * request), applies the saved colour theme, and boots the app controller
 * against the `#app` root.
 */
import "./decimal-config";
import "@fontsource-variable/inter/index.css";
import { App } from "./app";
import { initTheme } from "./theme";

initTheme();

const root = document.getElementById("app");
if (root) {
  new App(root).start();
}
