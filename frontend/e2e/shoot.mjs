#!/usr/bin/env node
// Review screenshots for agents and the owner's UI feedback loop (AGENTS.md
// "UI feedback loop: screenshots first"). Not part of the app or of CI.
//
// Usage (from frontend/, with the fixture dev server on 5273, e.g. `npm run dev:fixtures
// -- --port 5273` or preview_start "frontend-fixtures"):
//   npm run shots -- <outDir> <route>[,<route>…] [options]   (routes without a leading slash)
// Options:
//   --ccy EUR|USD|both      reporting currency (default both)
//   --theme light|dark|both color scheme (default light)
//   --width 390,1280        viewport widths (default 390,1280; add 360 for phone layouts)
//   --el ".css-selector"    crop each matching element instead of the page
//   --viewport              shoot the window only, not the full page
//   --sidebar               keep the desktop sidebar open (it is folded by default)
//   --base http://localhost:5273
//   --serve                 start (and always stop) our own fixture dev server on a free port;
//                           then no server needs to be running and --base is ignored
//   --pair                  also write <route>-pair-<width>-<theme>.png: EUR left, USD right,
//                           labeled (needs both currencies, not with --el)
//   --tiles                 also cut full-page shots taller than 2.5 screens into screen-sized
//                           pieces with a little overlap (<name>-t1.png, -t2.png, …)
// Examples:
//   npm run shots -- ../.claude/ui-shots/currency currency,overview --theme both
//   npm run shots -- ../.claude/ui-shots/kpi conversions --el ".stat-strip" --width 360,390,800,1280
//
// Files are named <route>-<ccy>-<width>-<theme>[-elN].png. Currency, theme and the
// folded sidebar come from the fixture server's URL switches (`?ccy=USD&theme=dark&
// rail=1`, see src/fixtures/install.ts), checked after load. The script then scrolls
// once so lazy sections load, pins fixed chrome in flow for full-page captures
// (Chromium mis-draws it otherwise) and prints any horizontal overflow.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

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
let base = flag("base", "http://localhost:5273");
const serve = args.includes("--serve");
const wantPair = args.includes("--pair");
const wantTiles = args.includes("--tiles");
const el = flag("el", null);
const fullPage = !args.includes("--viewport") && !el;

mkdirSync(outDir, { recursive: true });

/** The fixture server's view switches (src/fixtures/install.ts): currency, theme, sidebar. */
const viewUrl = (route, ccy, theme) =>
  `${base}${route}${route.includes("?") ? "&" : "?"}ccy=${ccy}&theme=${theme}&rail=${args.includes("--sidebar") ? 0 : 1}`;

/** Fails loudly when the page does not show the asked currency. */
async function checkCcy(page, want) {
  const got = await page.evaluate(() => localStorage.getItem("iv.ccy"));
  if (got !== want) throw new Error(`page shows ${got}, not ${want}: is the server a 7.3.1+ fixture build?`);
}

let server = null;
const stopServer = () => {
  if (!server) return;
  const pid = server.pid;
  server = null;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  else process.kill(pid, "SIGTERM");
};
process.on("exit", stopServer);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    stopServer();
    process.exit(130);
  });
}

/** A free port that is not one of the shared dev/preview ports. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => (port === 4173 || port === 5273 ? freePort().then(resolve, reject) : resolve(port)));
    });
  });

async function startServer() {
  const port = await freePort();
  const vite = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
  server = spawn(process.execPath, [vite, "--mode", "fixtures", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: "ignore",
  });
  let exited = false;
  server.on("exit", () => (exited = true));
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 240; i++) {
    if (exited) throw new Error("the fixture dev server exited before it answered");
    try {
      if ((await fetch(base)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("the fixture dev server did not answer within 60 s");
}

/** Left/right image with a label on each, composed by Playwright (no extra dependency). */
async function writePair(browser, left, right, file) {
  const url = (b) => `data:image/png;base64,${b.toString("base64")}`;
  const ctx = await browser.newContext({ viewport: { width: 400, height: 400 } });
  const page = await ctx.newPage();
  await page.setContent(
    `<body style="margin:0;background:#888;font:600 20px sans-serif;color:#fff">` +
      `<div style="display:flex;gap:16px;align-items:flex-start;width:max-content;padding:8px">` +
      [["EUR", left], ["USD", right]]
        .map(([l, b]) => `<figure style="margin:0"><div style="padding:0 0 6px">${l}</div><img src="${url(b)}" style="display:block"></figure>`)
        .join("") +
      `</div></body>`,
  );
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth));
  await page.screenshot({ path: file, fullPage: true });
  await ctx.close();
}

/** Screen-sized pieces (with overlap) of a full-page capture, by clip. */
async function writeTiles(page, width, total, base0, outDir0) {
  const h = 900;
  const overlap = 80;
  const files = [];
  for (let top = 0, n = 1; top < total; top += h - overlap, n++) {
    const height = Math.min(h, total - top);
    const file = base0.replace(/\.png$/, `-t${n}.png`);
    await page.screenshot({ path: `${outDir0}/${file}`, fullPage: true, clip: { x: 0, y: top, width, height } });
    files.push(file);
    if (top + height >= total) break;
  }
  return files;
}

if (serve) await startServer();
const browser = await chromium.launch();
try {
for (const route of routes) {
  for (const theme of themes) {
    for (const width of widths) {
      const shots = {};
      for (const ccy of ccys) {
        const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
        const page = await ctx.newPage();
        await page.goto(viewUrl(route, ccy, theme), { waitUntil: "networkidle" });
        await page.waitForTimeout(1200);
        await checkCcy(page, ccy);
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
        if (el) {
          const items = page.locator(el);
          const n = await items.count();
          if (!n) console.log(`${name}  no element matches ${el}`);
          for (let i = 0; i < n; i++) {
            const one = items.nth(i);
            if (!(await one.isVisible())) continue;
            const crop = name.replace(/\.png$/, `-el${i + 1}.png`);
            await one.scrollIntoViewIfNeeded();
            await one.screenshot({ path: `${outDir}/${crop}` });
            console.log(crop);
          }
        } else {
          shots[ccy] = await page.screenshot({ path: `${outDir}/${name}`, fullPage });
          console.log(`${name}${overflow > 0 ? `  OVERFLOW ${overflow}px` : ""}`);
          if (wantTiles && fullPage) {
            const total = await page.evaluate(() => document.documentElement.scrollHeight);
            if (total > 2.5 * 900) for (const f of await writeTiles(page, width, total, name, outDir)) console.log(f);
          }
        }
        await ctx.close();
      }
      if (wantPair && shots.EUR && shots.USD) {
        const pairName = `${route.replace(/^\//, "").replace(/\//g, "_") || "home"}-pair-${width}-${theme}.png`;
        await writePair(browser, shots.EUR, shots.USD, `${outDir}/${pairName}`);
        console.log(pairName);
      }
    }
  }
}
} finally {
  await browser.close();
  stopServer();
}
