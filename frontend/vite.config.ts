/// <reference types="vitest/config" />
import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The build's own version: an open tab compares it with the server's
// (`lib/appVersion.ts`) and reloads itself after a deploy.
const APP_VERSION = (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string })
  .version;

// Dev proxy: the FastAPI backend serves /api (including the /api/stream SSE
// endpoint). SSE needs an unbuffered, long-lived connection, so no timeouts.
// VITE_API_PROXY points it at another backend (e.g. a second checkout's).
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    // Fixture mode (fake data, no backend) is switched on by `--mode fixtures`
    // itself, not by an env file: `.env.*` files are never committed (public repo),
    // so CI would build the real app without it.
    ...(mode === "fixtures" ? { "import.meta.env.VITE_FIXTURES": JSON.stringify("1") } : {}),
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY ?? "http://127.0.0.1:8000",
        changeOrigin: false,
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    include: ["src/**/*.test.{ts,tsx}"],
  },
}));
