/// <reference types="node" />
// Node APIs read tokens.scss (vitest runs with css: false, so ?raw would be empty).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VISIONS, contrast, deltaE, type Vision } from "../lib/cvd";

/**
 * Colour-blind guard. The owner is protan (red-green) colour-blind, so protan is the
 * binding case; deutan and normal vision are checked as well. Add every new or changed
 * colour token to CVD_PAIRS (pairs that can be on screen together with different
 * meanings) or to the contrast lists below. See AGENTS.md > Colour accessibility.
 */
const MIN_PROTAN = 20; // pairs that really share a screen
const MIN_OTHER = 15; // normal and deutan, and the "rare" pairs below

/**
 * Pairs that are on screen together with different meanings. `why` says where.
 * Each must reach MIN_PROTAN under protan and MIN_OTHER under deutan/normal.
 */
export const CVD_PAIRS: { a: string; b: string; why: string }[] = [
  { a: "--color-pos", b: "--color-neg", why: "gain/loss everywhere (Money, Percent, DeltaBadge, bars, sparklines)" },
  { a: "--color-warn", b: "--color-neg", why: "status dots (TopBar), Freshness, Diagnostics, Import, Settings badges" },
  { a: "--color-warn", b: "--color-pos", why: "TopBar pos/warn/neg status dots, Freshness" },
  // Main value chart: on 1D the primary line is recoloured pos/neg (trend); the
  // second-currency series (n1 = chart-2) sits next to it. Otherwise primary is chart-1.
  { a: "--chart-2", b: "--color-pos", why: "second currency vs up-day primary line" },
  { a: "--chart-2", b: "--color-neg", why: "second currency vs down-day primary line" },
  { a: "--chart-2", b: "--chart-1", why: "second currency vs primary line (non-1D ranges)" },
  // Risk / Projection: primary (chart-1), benchmark/optimistic (chart-3), muted line.
  { a: "--chart-1", b: "--chart-3", why: "Risk/Projection primary vs benchmark" },
  { a: "--chart-1", b: "--color-muted", why: "Risk/Projection primary vs muted (net invested / pessimistic)" },
  { a: "--chart-3", b: "--color-muted", why: "Risk/Projection benchmark vs muted line" },
  { a: "--chart-3", b: "--color-pos", why: "benchmark next to a trend-coloured primary" },
  { a: "--chart-3", b: "--color-neg", why: "benchmark next to a trend-coloured primary" },
  // Overview hero 1D mini chart: the trend-coloured line next to the dashed
  // previous-close guide (fg; muted is too close to pos for deutan / normal).
  { a: "--color-pos", b: "--color-fg", why: "up-day 1D line vs dashed previous close" },
  { a: "--color-neg", b: "--color-fg", why: "down-day 1D line vs dashed previous close" },
  // Twin estimate (hero chip, Overview/Holdings twin rows): its outline / connector sits next
  // to the pos/neg estimated figures, the warn "stale" pills and the primary text.
  { a: "--color-estimate", b: "--color-pos", why: "twin badge/connector vs up-day estimated figures" },
  { a: "--color-estimate", b: "--color-neg", why: "twin badge/connector vs down-day estimated figures" },
  { a: "--color-estimate", b: "--color-warn", why: "twin badge vs stale-value / bad-history pills" },
  { a: "--color-estimate", b: "--color-fg", why: "twin badge/connector vs the row's primary text" },
];

/** Charts with 3+ untoned series (n2..n4) are rare; they get the lower bar plus dashes. */
const SERIES = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5", "--chart-6"];
export const RARE_PAIRS: { a: string; b: string }[] = [
  ...SERIES.flatMap((a, i) => SERIES.slice(i + 1).map((b) => ({ a, b }))),
  ...["--chart-4", "--chart-5"].flatMap((a) => ["--color-pos", "--color-neg"].map((b) => ({ a, b }))),
];

/** Text colours: >= 4.5:1 on surface and bg for normal vision, >= 3:1 as a protan sees it. */
const TEXT_TOKENS = ["--color-pos", "--color-neg", "--color-warn"];
/** Lines / marks: >= 3:1 on surface and bg, in normal vision and as a protan sees it. */
const MARK_TOKENS = [...SERIES, "--color-muted", "--color-estimate"];

const here = dirname(fileURLToPath(import.meta.url));
const scss = readFileSync(join(here, "tokens.scss"), "utf8");

function block(start: string): string {
  const i = scss.indexOf(start);
  expect(i, `${start} not found`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let k = scss.indexOf("{", i); k < scss.length; k++) {
    if (scss[k] === "{") depth++;
    if (scss[k] === "}" && --depth === 0) return scss.slice(i, k);
  }
  throw new Error(`unterminated ${start}`);
}

function tokens(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of css.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]] = m[2];
  return out;
}

const themes: Record<string, Record<string, string>> = {
  light: tokens(block(":root {")),
  dark: tokens(block("@mixin dark-tokens {")),
};
const min = (v: Vision) => (v === "protan" ? MIN_PROTAN : MIN_OTHER);

describe.each(Object.entries(themes))("colour-blind safe palette (%s)", (_name, t) => {
  it("defines every token the lists name", () => {
    const names = new Set([...CVD_PAIRS.flatMap((p) => [p.a, p.b]), ...TEXT_TOKENS, ...MARK_TOKENS, "--color-surface", "--color-bg"]);
    for (const n of names) expect(t[n], n).toBeDefined();
  });

  it.each(CVD_PAIRS)("$a vs $b is distinguishable ($why)", ({ a, b }) => {
    for (const v of VISIONS) expect(deltaE(t[a], t[b], v), `${a} vs ${b} (${v})`).toBeGreaterThanOrEqual(min(v));
  });

  it.each(RARE_PAIRS)("$a vs $b stays apart in multi-series charts", ({ a, b }) => {
    for (const v of VISIONS) expect(deltaE(t[a], t[b], v), `${a} vs ${b} (${v})`).toBeGreaterThanOrEqual(MIN_OTHER);
  });

  it("text tokens stay readable on surface and bg", () => {
    for (const tok of TEXT_TOKENS)
      for (const bg of ["--color-surface", "--color-bg"]) {
        expect(contrast(t[tok], t[bg], "normal"), `${tok} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t[tok], t[bg], "protan"), `${tok} on ${bg} (protan)`).toBeGreaterThanOrEqual(3);
      }
  });

  it("line/mark tokens keep 3:1 on surface and bg, also as a protan sees them", () => {
    for (const tok of MARK_TOKENS)
      for (const bg of ["--color-surface", "--color-bg"])
        for (const v of ["normal", "protan"] as const) expect(contrast(t[tok], t[bg], v), `${tok} on ${bg} (${v})`).toBeGreaterThanOrEqual(3);
  });
});
