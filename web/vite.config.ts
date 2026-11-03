import { defineConfig, type Plugin } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Single source of truth for the displayed app version: the package.json that
// CI keeps in lock-step with the main app's version. Injected as a compile-time
// constant so the running site can show exactly which build it is.
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as { version: string };

// The companion deploys to GitHub Pages under a project path
// (https://<user>.github.io/<repo>/), so assets must be referenced relatively.
// A relative base keeps the build portable across user/project Pages and local
// `vite preview` without hard-coding the repository name.
// The demo-only Pages build (`VITE_DEMO_ONLY=1`, since 6.0.0) must never reach
// another origin: no ledger blob, no price/FX APIs, no Worker. This CSP is the
// structural backstop — any request the offline demo would make elsewhere is
// refused by the browser. Inline styles stay allowed for the chart/tour layout.
const DEMO_ONLY_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

const demoOnlyHtml: Plugin = {
  name: "demo-only-html",
  apply: "build",
  transformIndexHtml(html) {
    if (process.env.VITE_DEMO_ONLY !== "1") return html;
    return html
      .replace(
        '<meta charset="utf-8" />',
        `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${DEMO_ONLY_CSP}" />`,
      )
      .replace(/<title>[^<]*<\/title>/, "<title>Investment Overview — Demo</title>");
  },
};

export default defineConfig({
  base: "./",
  plugins: [demoOnlyHtml],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: false,
  },
});
