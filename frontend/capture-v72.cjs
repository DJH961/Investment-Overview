const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const out = path.resolve("..", ".codex", "v7.2.0-ui");
  fs.mkdirSync(out, { recursive: true });
  for (const width of [390, 1280]) {
    for (const theme of ["light", "dark"]) {
      const context = await chromium.launchPersistentContext(path.join(out, `profile-${width}-${theme}`), {
        headless: true,
        executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        viewport: { width, height: width === 390 ? 844 : 900 },
        deviceScaleFactor: 1,
        colorScheme: theme,
        reducedMotion: "reduce",
      });
      try {
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.addInitScript((choice) => {
          localStorage.setItem("iv.theme", choice);
          localStorage.setItem("iv.ccy", "EUR");
          localStorage.setItem("iv.tour.seen", "1");
          document.documentElement.dataset.theme = choice;
        }, theme);
        await page.goto("http://127.0.0.1:5273/currency?fixtures=full&brief=off", { waitUntil: "networkidle" });
        await page.waitForFunction((choice) => document.documentElement.dataset.theme === choice, theme, { timeout: 10000 }).catch(() => undefined);
        await page.waitForSelector(".currency-page__stack", { timeout: 15000 });
        await page.waitForTimeout(1000);
        for (let y = 0; y < (await page.locator("body").evaluate((element) => element.scrollHeight)); y += 650) {
          await page.evaluate((top) => window.scrollTo(0, top), y);
          await page.waitForTimeout(150);
        }
        await page.waitForTimeout(800);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(300);
        const filename = `currency-${width}-${theme}.png`;
        await page.screenshot({ path: path.join(out, filename), fullPage: true, animations: "disabled" });
        const metrics = await page.evaluate(() => ({
          theme: document.documentElement.getAttribute("data-theme"),
          viewportWidth: document.documentElement.clientWidth,
          documentWidth: document.documentElement.scrollWidth,
          pageHeight: document.documentElement.scrollHeight,
          sections: [...document.querySelectorAll("[data-section]")].map((section) => section.getAttribute("data-section")),
          tourVisible: Boolean(document.querySelector('[aria-label="Guided tour"]')),
        }));
        console.log(JSON.stringify({ path: path.join(out, filename), errors, ...metrics }));
      } finally {
        await context.close();
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
