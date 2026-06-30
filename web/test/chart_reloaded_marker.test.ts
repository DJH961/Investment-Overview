/**
 * Tests for the per-chart "the user reloaded this window" marker
 * (`markGraphReloaded` / `isGraphReloaded`). Once a live 1D/1W window has been
 * reloaded, every later network-free re-select prefers the freshly-pulled stored
 * bars over the cached export springboard — so the reload genuinely sticks rather
 * than snapping back to the cached graph. The marker is persisted so it survives
 * the full re-render a refresh / currency toggle triggers as well as a page
 * reload. Pure persistence logic, exercised against a mocked localStorage.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isGraphReloaded, markGraphReloaded } from "../src/ui";

let previous: Storage | undefined;

beforeEach(() => {
  const map = new Map<string, string>();
  previous = Reflect.get(globalThis, "localStorage") as Storage | undefined;
  Reflect.set(globalThis, "localStorage", {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  });
});

afterEach(() => {
  if (previous === undefined) Reflect.deleteProperty(globalThis, "localStorage");
  else Reflect.set(globalThis, "localStorage", previous);
});

describe("graph reloaded marker", () => {
  it("defaults to not-reloaded for an untouched window", () => {
    expect(isGraphReloaded("overview-value", "1D")).toBe(false);
    expect(isGraphReloaded("overview-value", "1W")).toBe(false);
  });

  it("remembers a reload and reads it back for the same chart + range", () => {
    markGraphReloaded("overview-value", "1D");
    expect(isGraphReloaded("overview-value", "1D")).toBe(true);
  });

  it("keys the marker per range so reloading 1D does not affect 1W", () => {
    markGraphReloaded("overview-value", "1D");
    expect(isGraphReloaded("overview-value", "1D")).toBe(true);
    expect(isGraphReloaded("overview-value", "1W")).toBe(false);
  });

  it("keys the marker per chart so two charts never cross-contaminate", () => {
    markGraphReloaded("overview-value", "1D");
    expect(isGraphReloaded("equity-curve", "1D")).toBe(false);
  });

  it("is a no-op without a persist key (an unkeyed chart cannot persist)", () => {
    markGraphReloaded(null, "1D");
    markGraphReloaded(undefined, "1D");
    expect(isGraphReloaded(null, "1D")).toBe(false);
    expect(isGraphReloaded(undefined, "1D")).toBe(false);
  });
});
