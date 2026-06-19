/**
 * Entry point. Configures decimal.js precision (via the shared module side
 * effect) and boots the app controller against the `#app` root.
 */
import "./decimal-config";
import { App } from "./app";

const root = document.getElementById("app");
if (root) {
  new App(root).start();
}
