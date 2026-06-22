import { defineConfig } from "vite";
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
export default defineConfig({
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: false,
  },
});
