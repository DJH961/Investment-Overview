import { defineConfig, devices } from "@playwright/test";

// Overflow detector: the production bundle in fixture mode (fake data, no
// backend, no login), served by `vite preview`. Separate from the smoke config,
// which needs the real backend.
const PORT = process.env.E2E_FIXTURES_PORT ?? "4173";

export default defineConfig({
  testDir: ".",
  testMatch: /overflow\.check\.ts/,
  // Every case is independent (own page, own report file): run them side by side.
  // GitHub's Linux runners have 4 cores; the static preview server is cheap.
  fullyParallel: true,
  workers: process.env.CI ? 4 : 3,
  timeout: 15 * 60_000,
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  outputDir: "../test-results/overflow",
  use: { baseURL: `http://127.0.0.1:${PORT}`, serviceWorkers: "block" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run serve:fixtures",
    url: `http://127.0.0.1:${PORT}`,
    timeout: 240_000,
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "pipe",
  },
});
