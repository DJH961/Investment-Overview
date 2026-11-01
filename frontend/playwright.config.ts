import { defineConfig, devices } from "@playwright/test";

// Ports are overridable so a local run does not collide with a dev server.
const API_PORT = process.env.E2E_API_PORT ?? "8000";
const WEB_PORT = process.env.E2E_WEB_PORT ?? "5173";
// Optional vite config override (its /api proxy must target E2E_API_PORT).
const VITE_CONFIG = process.env.E2E_VITE_CONFIG ? ` --config ${process.env.E2E_VITE_CONFIG}` : "";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://127.0.0.1:${WEB_PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node e2e/start-backend.mjs",
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      timeout: 180_000,
      reuseExistingServer: false,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: `npx vite${VITE_CONFIG} --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
