/**
 * Overflow detector. Walks every route of the app (fixture mode: fake data, no
 * backend) at six widths in both themes and fails on:
 *
 *  1. the document scrolling sideways;
 *  2. an element with `scrollWidth > clientWidth + 1`, unless it or an ancestor
 *     carries `data-scrollable` (a container that is meant to scroll);
 *  3. text that leaves the card or clipping container it sits in (a deliberate
 *     `text-overflow: ellipsis` is fine), or leaves the viewport.
 *
 * Screenshots go to `e2e-screenshots/` (git-ignored); CI uploads them as an
 * artifact. Failures are also written to `e2e-report/overflow-*.json`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const ROUTES = [
  "/overview",
  "/holdings",
  "/periods",
  "/activity",
  "/risk",
  "/projection",
  "/transactions",
  "/import",
  "/instruments",
  "/conversions",
  "/allocations",
  "/diagnostics",
  "/settings",
  "/help",
  "/onboarding",
  "/does-not-exist",
];
const WIDTHS = [360, 390, 768, 1024, 1280, 1440];
const THEMES = ["light", "dark"] as const;
/** The empty ledger only needs the extremes: the empty states are narrow-vs-wide, not six-way. */
const EMPTY_WIDTHS = [390, 1280];

interface Finding {
  dataset: string;
  route: string;
  width: number;
  theme: string;
  kind: "page-scroll" | "element-overflow" | "text-clipped" | "text-offscreen";
  selector: string;
  detail: string;
}

const findings: Finding[] = [];

/** Runs inside the page. Returns raw findings (no dataset/route/width/theme yet). */
function detect(): Array<Pick<Finding, "kind" | "selector" | "detail">> {
  const out: Array<Pick<Finding, "kind" | "selector" | "detail">> = [];
  const describe = (el: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = el;
    for (let i = 0; cur && i < 3 && cur !== document.body; i++, cur = cur.parentElement) {
      const cls = (typeof cur.className === "string" ? cur.className : "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
      parts.unshift(cur.tagName.toLowerCase() + (cls.length ? "." + cls.join(".") : ""));
    }
    return parts.join(" > ");
  };
  const visible = (el: Element): boolean =>
    (el as HTMLElement).checkVisibility?.({ checkOpacity: false, checkVisibilityCSS: true }) ?? true;
  const snippet = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 60);

  const root = document.documentElement;
  if (root.scrollWidth > window.innerWidth + 1) {
    out.push({
      kind: "page-scroll",
      selector: "html",
      detail: `document is ${root.scrollWidth}px wide in a ${window.innerWidth}px viewport`,
    });
  }

  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    if (out.length > 60) break;
    if (el.closest("[data-scrollable]") || el.closest("svg") || !visible(el)) continue;
    const box = el as HTMLElement;
    if (box.clientWidth <= 1) continue;
    if (box.scrollWidth > box.clientWidth + 1) {
      out.push({
        kind: "element-overflow",
        selector: describe(el),
        detail: `scrollWidth ${box.scrollWidth} > clientWidth ${box.clientWidth}: "${snippet(box.textContent ?? "")}"`,
      });
    }
  }

  const clips = (cs: CSSStyleDeclaration) => /hidden|clip|auto|scroll/.test(cs.overflowX);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set<Element>();
  for (let node = walker.nextNode(); node && out.length <= 60; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    const parent = node.parentElement;
    if (!parent || !text.trim() || seen.has(parent)) continue;
    if (parent.closest("[data-scrollable]") || parent.closest("svg") || parent.closest("script,style,noscript")) continue;
    if (!visible(parent)) continue;
    // Visually hidden text (the 1px "sr-only" pattern) is not meant to be seen.
    const own = parent.getBoundingClientRect();
    if (own.width <= 2 || own.height <= 2) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) continue;
    const left = Math.min(...rects.map((r) => r.left));
    const right = Math.max(...rects.map((r) => r.right));
    const ellipsised = (() => {
      for (let cur: Element | null = parent; cur && cur !== document.body; cur = cur.parentElement) {
        if (getComputedStyle(cur).textOverflow === "ellipsis") return true;
      }
      return false;
    })();

    if (right > window.innerWidth + 1 || left < -1) {
      seen.add(parent);
      out.push({
        kind: "text-offscreen",
        selector: describe(parent),
        detail: `"${snippet(text)}" spans ${Math.round(left)}..${Math.round(right)} in a ${window.innerWidth}px viewport`,
      });
      continue;
    }
    if (ellipsised) continue;
    // The nearest clipping ancestor and the nearest card: the text must stay inside both.
    let clipper: Element | null = null;
    for (let cur: Element | null = parent; cur && cur !== document.documentElement; cur = cur.parentElement) {
      if (clips(getComputedStyle(cur)) && cur.getBoundingClientRect().width > 2) {
        clipper = cur;
        break;
      }
    }
    const card = parent.closest('[class*="card"]');
    for (const [label, box] of [
      ["clipping container", clipper],
      ["card", card],
    ] as const) {
      if (!box || box === document.body) continue;
      const b = box.getBoundingClientRect();
      if (b.width === 0) continue;
      if (right > b.right + 1 || left < b.left - 1) {
        seen.add(parent);
        out.push({
          kind: "text-clipped",
          selector: describe(parent),
          detail: `"${snippet(text)}" spans ${Math.round(left)}..${Math.round(right)}, ${label} ${describe(box)} spans ${Math.round(b.left)}..${Math.round(b.right)}`,
        });
        break;
      }
    }
  }
  return out;
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page
    .waitForFunction(() => document.querySelectorAll('[aria-busy="true"]').length === 0, undefined, { timeout: 8000 })
    .catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

const cases = [
  ...WIDTHS.flatMap((w) => THEMES.map((t) => ({ dataset: "full", width: w, theme: t }))),
  ...EMPTY_WIDTHS.flatMap((w) => THEMES.map((t) => ({ dataset: "empty", width: w, theme: t }))),
];

for (const { dataset, width, theme } of cases) {
  test(`no overflow: ${dataset} ledger, ${width}px, ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    // Server settings carry a theme too and win over local storage, so pin the attribute.
    await page.addInitScript(
      ([wanted, set]) => {
        localStorage.setItem("iv.tour.seen", "1");
        localStorage.setItem("iv.theme", wanted);
        sessionStorage.setItem("iv.fixtures", set);
        const apply = () => {
          if (document.documentElement.getAttribute("data-theme") !== wanted)
            document.documentElement.setAttribute("data-theme", wanted);
        };
        new MutationObserver(apply).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
        apply();
      },
      [theme, dataset] as const,
    );
    const shots = `e2e-screenshots/${dataset}/${theme}-${width}`;
    mkdirSync(shots, { recursive: true });

    for (const route of ROUTES) {
      await page.goto(`${route}?fixtures=${dataset}`);
      await settle(page);
      const raw = await page.evaluate(detect);
      for (const f of raw) findings.push({ dataset, route, width, theme, ...f });
      const name = route.replace(/\//g, "") || "root";
      await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
    }

    const mine = findings.filter((f) => f.dataset === dataset && f.width === width && f.theme === theme);
    // One file per case: a failed test restarts the worker, so nothing can be merged in memory.
    mkdirSync("e2e-report", { recursive: true });
    writeFileSync(`e2e-report/overflow-${dataset}-${theme}-${width}.json`, JSON.stringify(mine, null, 1));
    const summary = mine.map((f) => `${f.route} [${f.kind}] ${f.selector}: ${f.detail}`);
    expect(summary, `${mine.length} overflow finding(s)`).toEqual([]);
  });
}

