#!/usr/bin/env node
// Review screenshots for agents and the owner's UI feedback loop (AGENTS.md
// "UI feedback loop: screenshots first"). Not part of the app or of CI.
//
// Usage (from frontend/, with a fixture server running, e.g. `npm run dev:fixtures`):
//   node e2e/shoot.mjs <outDir> <route>[,<route>…] [options]   (routes without a leading slash)
// Options:
//   --ccy EUR|USD|both      reporting currency (default both)
//   --theme light|dark|both color scheme (default light)
//   --width 390,1280        viewport widths (default 390,1280)
//   --base http://localhost:5273
//   --viewport              shoot the window only, not the full page
// Example:
//   node e2e/shoot.mjs ../.claude/ui-shots/currency currency,overview --theme both
//
// Files are named <route>-<ccy>-<width>-<theme>.png. For each shot the script:
// sets the currency with the app's own toggle and checks that it took effect (the
// fixture settings would override a seeded localStorage value); scrolls the page
// once so lazy sections load; keeps the sidebar and phone nav from stretching or
// floating mid-page in a full-page capture (screenshot-only CSS); and prints any
// horizontal overflow.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
};
const [outDir, routesArg] = args;
if (!outDir || !routesArg) {
  console.error("usage: node e2e/shoot.mjs <outDir> <route>[,<route>…] [--ccy both] [--theme light] [--width 390,1280]");
  process.exit(2);
}
// Write routes without the leading slash ("currency,holding/FAKEL"): Git Bash
// rewrites an argument like "/currency" into a Windows path.
const routes = routesArg.split(",").map((r) => (r.startsWith("/") ? r : "/" + r));
const both = (v, pair) => (v === "both" ? pair : [v]);
const ccys = both(flag("ccy", "both"), ["EUR", "USD"]);
const themes = both(flag("theme", "light"), ["light", "dark"]);
const widths = flag("width", "390,1280").split(",").map(Number);
const base = flag("base", "http://localhost:5273");
const fullPage = !args.includes("--viewport");

mkdirSync(outDir, { recursive: true });

/** Reads the current reporting currency from the top bar (desktop switch or phone button). */
async function currentCcy(page) {
  return page.evaluate(() => {
    const radio = [...document.querySelectorAll('[role="radio"]')].find(
      (r) => (r.textContent ?? "").trim() === "USD" || (r.textContent ?? "").trim() === "EUR",
    );
    if (radio && radio.offsetParent) {
      const checked = [...document.querySelectorAll('[role="radio"]')].find(
        (r) => r.offsetParent && r.getAttribute("aria-checked") === "true" && /^(EUR|USD)$/.test((r.textContent ?? "").trim()),
      );
      if (checked) return checked.textContent.trim();
    }
    const btn = [...document.querySelectorAll("button[aria-label]")].find((b) => /^Showing (EUR|USD)/.test(b.getAttribute("aria-label")));
    return btn ? btn.getAttribute("aria-label").slice(8, 11) : null;
  });
}

async function setCcy(page, want) {
  for (let i = 0; i < 2; i++) {
    if ((await currentCcy(page)) === want) return;
    const radio = page.getByRole("radio", { name: want, exact: true }).first();
    if ((await radio.count()) && (await radio.isVisible())) await radio.click();
    else await page.getByRole("button", { name: /^Showing (EUR|USD), switch to/ }).first().click();
    await page.waitForTimeout(1200);
  }
  const got = await currentCcy(page);
  if (got !== want) throw new Error(`could not switch to ${want} (shows ${got})`);
}

const browser = await chromium.launch();
for (const route of routes) {
  for (const theme of themes) {
    for (const width of widths) {
      for (const ccy of ccys) {
        const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
        const page = await ctx.newPage();
        await page.goto(base + route, { waitUntil: "networkidle" });
        await page.waitForTimeout(1200);
        await setCcy(page, ccy);
        // Fold the desktop sidebar to its icon rail (the app's own toggle) unless
        // --sidebar is given: shots show the page, not the navigation.
        if (!args.includes("--sidebar")) {
          const fold = page.getByRole("button", { name: "Collapse sidebar" });
          if ((await fold.count()) && (await fold.first().isVisible())) {
            await fold.first().click();
            await page.waitForTimeout(500);
          }
        }
        // Scroll the window (not the mouse wheel: over the fixed sidebar a wheel can
        // shift the whole shell sideways in the capture).
        for (let i = 0; i < 40; i++) {
          await page.evaluate(() => window.scrollBy(0, 700));
          await page.waitForTimeout(120);
        }
        await page.waitForTimeout(2000);
        await page.evaluate(() => window.scrollTo(0, 0));
        if (fullPage) {
          // Screenshot-only: Chromium's full-page capture mis-draws fixed and sticky
          // chrome (the sidebar drops and the page slides under it; the phone nav
          // floats mid-page). Pin them in normal flow at their on-screen size.
          await page.addStyleTag({
            content:
              "aside.sidebar{position:absolute !important;top:0 !important;height:900px !important}" +
              "header{position:relative !important;top:0 !important}" +
              "[class*='bottom-nav'],[class*='mobile-nav']{position:static !important}",
          });
        }
        await page.waitForTimeout(600);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        const name = `${route.replace(/^\//, "").replace(/\//g, "_") || "home"}-${ccy}-${width}-${theme}.png`;
        await page.screenshot({ path: `${outDir}/${name}`, fullPage });
        console.log(`${name}${overflow > 0 ? `  OVERFLOW ${overflow}px` : ""}`);
        await ctx.close();
      }
    }
  }
}
await browser.close();
