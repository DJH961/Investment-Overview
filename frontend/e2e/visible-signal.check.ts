import { expect, test, type Page } from "@playwright/test";

// The API client marks a read with `X-Visible: 1` only while `document.visibilityState`
// is "visible" (read at send time). Run by `e2e/signal.config.ts` on chromium, firefox,
// webkit and the iPhone 13 / Pixel 7 descriptors.

async function capture(page: Page): Promise<Array<string | undefined>> {
  const seen: Array<string | undefined> = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    if (request.url().includes("/api/probe")) seen.push(request.headers()["x-visible"]);
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  return seen;
}

async function probe(page: Page) {
  await page.evaluate(async () => {
    // Vite serves the source modules in dev: use the app's own client.
    const mod = await import(/* @vite-ignore */ "/src/lib/api.ts");
    await mod.api("/api/probe");
  });
}

test("the signal is sent while visible and not after the tab is hidden", async ({ page }) => {
  const seen = await capture(page);
  await page.goto("/login");

  await probe(page);
  expect(seen.at(-1)).toBe("1");

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await probe(page);
  expect(seen.at(-1)).toBeUndefined();

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await probe(page);
  expect(seen.at(-1)).toBe("1");
});
