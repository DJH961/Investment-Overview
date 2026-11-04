import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_VERSION, noteServerVersion, setReloadForTests } from "./appVersion";

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("stale-tab reload", () => {
  let reload: ReturnType<typeof vi.fn<() => void>>;
  beforeEach(() => {
    reload = vi.fn<() => void>();
    setReloadForTests(reload);
    sessionStorage.clear();
    document.body.innerHTML = "";
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  });
  afterEach(() => setReloadForTests(null));

  it("knows its own build version", () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("does nothing when the server runs the same version or says nothing", () => {
    expect(noteServerVersion("1.0.0", "1.0.0")).toBe(false);
    expect(noteServerVersion(null, "1.0.0")).toBe(false);
    expect(noteServerVersion("", "1.0.0")).toBe(false);
    setHidden(true);
    expect(reload).not.toHaveBeenCalled();
  });

  it("waits while the tab is visible, reloads when it is hidden", () => {
    expect(noteServerVersion("2.0.0", "1.0.0")).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    setHidden(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads at once when the tab is already hidden", () => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    noteServerVersion("2.0.1", "1.0.0");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("never reloads while the user types or has a dialog open", () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    noteServerVersion("2.0.2", "1.0.0");
    setHidden(true);
    expect(reload).not.toHaveBeenCalled();
    input.blur();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    setHidden(false);
    expect(reload).not.toHaveBeenCalled();
    dialog.remove();
    setHidden(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads at most once per server version (no loop)", () => {
    noteServerVersion("2.0.3", "1.0.0");
    setHidden(true);
    expect(reload).toHaveBeenCalledTimes(1);
    // After the reload the build is still old (e.g. a cached shell): stay put.
    expect(noteServerVersion("2.0.3", "1.0.0")).toBe(false);
    setHidden(false);
    setHidden(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
