import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { APP_VERSION } from "../src/version";

const readText = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("APP_VERSION", () => {
  it("is injected from package.json (not the 'dev' fallback)", () => {
    const pkg = JSON.parse(readText("../package.json")) as { version: string };
    expect(APP_VERSION).toBe(pkg.version);
    expect(APP_VERSION).not.toBe("dev");
  });

  it("stays in lock-step with the main app version in pyproject.toml", () => {
    // The web companion's version must always match the desktop/main app's
    // version exactly, so the version chip on the site is meaningful.
    const pyproject = readText("../../pyproject.toml");
    const match = pyproject.match(/^version = "([^"]+)"/m);
    expect(match, "could not find version in pyproject.toml").not.toBeNull();
    expect(APP_VERSION).toBe(match![1]);
  });
});
