import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Mirror the Vite build's compile-time version constant so unit tests that
// render the version label resolve `__APP_VERSION__` too.
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as { version: string };

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    // Worker threads with a fresh VM context per file (isolation kept): faster
    // than the default forks pool, which starts a process per file.
    pool: "vmThreads",
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
  },
});
