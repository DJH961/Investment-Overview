/**
 * Tests for the PWA registration helper. The service worker itself is plain
 * browser glue (no logic to unit-test in Node); these cover the registration
 * decision tree: unsupported runtimes, success, and swallowed failures.
 */
import { describe, expect, it, vi } from "vitest";

import { registerServiceWorker, serviceWorkerHost, type ServiceWorkerHost } from "../src/pwa";

describe("serviceWorkerHost", () => {
  it("returns null when navigator is unavailable (e.g. Node/SSR)", () => {
    expect(serviceWorkerHost(undefined)).toBeNull();
  });

  it("returns null when the navigator lacks serviceWorker support", () => {
    expect(serviceWorkerHost({} as Navigator)).toBeNull();
  });

  it("returns the serviceWorker container when supported", () => {
    const sw = { register: vi.fn() };
    const nav = { serviceWorker: sw } as unknown as Navigator;
    expect(serviceWorkerHost(nav)).toBe(sw);
  });
});

describe("registerServiceWorker", () => {
  it("does nothing and reports false when unsupported", async () => {
    expect(await registerServiceWorker(null)).toBe(false);
  });

  it("registers sw.js at the app scope and reports true", async () => {
    const register = vi.fn().mockResolvedValue({});
    const host: ServiceWorkerHost = { register };
    expect(await registerServiceWorker(host)).toBe(true);
    expect(register).toHaveBeenCalledWith("./sw.js", { scope: "./" });
  });

  it("swallows registration failures and reports false", async () => {
    const host: ServiceWorkerHost = { register: vi.fn().mockRejectedValue(new Error("boom")) };
    await expect(registerServiceWorker(host)).resolves.toBe(false);
  });
});
