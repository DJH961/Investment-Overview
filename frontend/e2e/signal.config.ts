import { defineConfig, devices } from "@playwright/test";

// The "tab is visible" signal across engines and devices. Needs no backend: the spec
// answers every /api call itself, so only the vite dev server runs.
//   npx playwright install webkit firefox   (once)
//   npx playwright test --config e2e/signal.config.ts
const PORT = process.env.E2E_SIGNAL_PORT ?? "5183";

export default defineConfig({
  testDir: ".",
  testMatch: /visible-signal\.check\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  outputDir: "../test-results/signal",
  use: { baseURL: `http://127.0.0.1:${PORT}`, serviceWorkers: "block" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "iphone-13", use: { ...devices["iPhone 13"] } },
    { name: "pixel-7", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "pipe",
  },
});
