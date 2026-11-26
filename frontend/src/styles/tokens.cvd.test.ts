/// <reference types="node" />
// Node APIs read tokens.scss (vitest runs with css: false, so ?raw would be empty).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VISIONS, contrast, deltaE, type Vision } from "../lib/cvd";

/**
 * Color-blind guard. The owner is protan (red-green) color-blind, so protan is the
 * binding case; deutan and normal vision are checked as well. Add every new or changed
 * color token to CVD_PAIRS (pairs that can be on screen together with different
 * meanings) or to the contrast lists below. See AGENTS.md > Color accessibility.
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
  // Conversions page (7.2.1): the deposit bars, a conversion's share in accent and the ECB share
  // hatched in ink (the hatch carries the meaning as well).
  { a: "--color-accent", b: "--color-fg", why: "Conversions: deposit bar, your conversion vs ECB-rate share" },
  // Asset-class bar (Overview, AssetClassCard ASSET_CLASS_LOOK; also the stripe on the Fund-view treemap
  // tiles): etf chart-1, mutual funds chart-3 (gold), cash chart-5 (dark teal), stocks chart-6 (hatched; vs
  // cash it is the one pair under 20 for a protan in the dark theme, so the hatch is the second cue).
  { a: "--chart-1", b: "--chart-3", why: "asset-class bar: ETFs vs mutual funds" },
  { a: "--chart-1", b: "--chart-5", why: "asset-class bar: ETFs vs cash" },
  { a: "--chart-3", b: "--chart-5", why: "asset-class bar: mutual funds vs cash" },
  { a: "--chart-1", b: "--chart-6", why: "asset-class bar: ETFs vs stocks" },
  { a: "--chart-3", b: "--chart-6", why: "asset-class bar: mutual funds vs stocks" },
  { a: "--chart-3", b: "--color-pos", why: "benchmark next to a trend-colored primary" },
  { a: "--chart-3", b: "--color-neg", why: "benchmark next to a trend-colored primary" },
  // Overview hero 1D mini chart: the trend-colored line next to the dashed
  // previous-close guide (fg; muted is too close to pos for deutan / normal).
  { a: "--color-pos", b: "--color-fg", why: "up-day 1D line vs dashed previous close" },
  { a: "--color-neg", b: "--color-fg", why: "down-day 1D line vs dashed previous close" },
  // Twin estimate (hero chip, Overview/Holdings twin rows): its outline / connector sits next
  // to the pos/neg estimated figures, the warn "stale" pills and the primary text.
  { a: "--color-estimate", b: "--color-pos", why: "twin badge/connector vs up-day estimated figures" },
  { a: "--color-estimate", b: "--color-neg", why: "twin badge/connector vs down-day estimated figures" },
  { a: "--color-estimate", b: "--color-warn", why: "twin badge vs stale-value / bad-history pills" },
  { a: "--color-estimate", b: "--color-fg", why: "twin badge/connector vs the row's primary text" },
  // Holding page › Tranches (7.1): the status badges side by side, next to the Gain column.
  // Short-term is neutral (no hue); Long-term shares the gain blue on purpose (tick + word).
  { a: "--color-lot-long", b: "--color-lot-soon", why: "tranche badges: Long-term vs Long-term in N d" },
  { a: "--color-lot-long", b: "--color-neg", why: "Long-term badge next to a loss in the Gain column" },
  { a: "--color-lot-soon", b: "--color-pos", why: "Long-term in N d badge next to a gain" },
  { a: "--color-lot-soon", b: "--color-neg", why: "Long-term in N d badge next to a loss" },
  // Conversions › deposit status chips (7.3): Matched (pos tick) and Partly matched (warn) are
  // listed above; ECB only, Pinned and "Received in USD" are neutral chips (no hue), told apart
  // by icon and word, so they add no color pair. The kept-dollars segment is accent / border /
  // dotted ink with the amount written out beside it.
  // Holding page › Twin (7.1): twin line (chart-1), dashed fund estimate, NAV dots (chart-3).
  { a: "--chart-estimate", b: "--chart-1", why: "twin chart: fund estimate vs twin line" },
  { a: "--chart-estimate", b: "--chart-3", why: "twin chart: fund estimate vs NAV points" },
  // Currency page › rate chart (7.2): the rate line (chart-1), the dashed 200-day average
  // (benchmark, chart-3) and the dashed "your average" reference (muted).
  { a: "--chart-1", b: "--chart-3", why: "rate chart: rate line vs 200-day average" },
  { a: "--chart-1", b: "--color-muted", why: "rate chart: rate line vs your average rate" },
  { a: "--chart-1", b: "--color-muted", why: "Currency Max: your line vs the dashed before-you-started context" },
  { a: "--color-pos", b: "--color-neg", why: "Currency USD view: headline vs the 'Seen from euros' lens of the other sign" },
  { a: "--chart-3", b: "--color-muted", why: "rate chart: 200-day average vs your average rate" },
  // Conversion markers on the rate chart: a neutral ink ring (kind = null), ▲ pos above /
  // ▼ neg below the reference (7.3), each outlined in ink, over the three lines above.
  { a: "--color-fg", b: "--chart-1", why: "rate chart: conversion marker / outline vs rate line" },
  { a: "--color-fg", b: "--chart-3", why: "rate chart: conversion marker / outline vs 200-day average" },
  // Not listed: the ink ring vs the muted "your average" line (19.6 protan, dark). The ring
  // sits on the rate line at the conversion's rate, and a ring never reads as a dashed line.
  { a: "--color-pos", b: "--color-neg", why: "rate chart: conversion above vs below the reference" },
  { a: "--color-pos", b: "--color-fg", why: "rate chart: above-reference marker vs neutral marker" },
  { a: "--color-neg", b: "--color-fg", why: "rate chart: below-reference marker vs neutral marker" },
  { a: "--color-pos", b: "--chart-3", why: "rate chart: above-reference marker vs 200-day average" },
  { a: "--color-neg", b: "--chart-3", why: "rate chart: below-reference marker vs 200-day average" },
  // Impact › constant-currency chart (7.2): actual value (chart-1), the dashed value at a
  // frozen rate (ink, fg) and the gold hatched gap band (chart-3) between them, beside the
  // blue/orange effect figures (pos/neg).
  { a: "--chart-3", b: "--color-pos", why: "constant-currency chart: band hatch vs a positive effect figure" },
  { a: "--chart-3", b: "--color-neg", why: "constant-currency chart: band hatch vs a negative effect figure" },
  { a: "--chart-3", b: "--chart-1", why: "constant-currency chart: band hatch vs actual value line" },
  { a: "--chart-3", b: "--color-fg", why: "constant-currency chart: band hatch vs frozen-rate line" },
  { a: "--chart-1", b: "--color-fg", why: "constant-currency chart: actual value vs frozen-rate line" },
  // Top bar (7.3.1): the ink pulse ring of a scheduled update sits right beside the
  // Health & Repair badge (ok pos / warn / error neg icon).
  { a: "--color-fg", b: "--color-pos", why: "TopBar: update pulse ring vs health badge OK" },
  { a: "--color-fg", b: "--color-warn", why: "TopBar: update pulse ring vs health badge warning" },
  { a: "--color-fg", b: "--color-neg", why: "TopBar: update pulse ring vs health badge problem" },
  // Bell moments (7.3.1): the brass bell and its ripple in the market clock, beside the
  // accent session track / soon digits and the hero's blue/orange day move.
  { a: "--color-bell", b: "--color-accent", why: "market clock: ringing bell vs session track / soon digits" },
  { a: "--color-bell", b: "--color-pos", why: "market clock: ringing bell vs the hero's up-day move / live dot" },
  { a: "--color-bell", b: "--color-neg", why: "market clock: ringing bell vs the hero's down-day move" },
  // FX weekend (7.3.1): the moon (weekend close) and sunrise (reopen) glyphs in the rate
  // chart's head, above the rate line (chart-1) and the dashed 200-day average (chart-3).
  // The two glyphs never show together (one state at a time) and the end cap keeps the line's colour.
  { a: "--color-fx-moon", b: "--chart-1", why: "rate chart: weekend moon glyph vs rate line" },
  { a: "--color-fx-moon", b: "--chart-3", why: "rate chart: weekend moon glyph vs 200-day average" },
  { a: "--color-fx-sunrise", b: "--chart-1", why: "rate chart: reopen sunrise glyph vs rate line" },
  { a: "--color-fx-sunrise", b: "--chart-3", why: "rate chart: reopen sunrise glyph vs 200-day average" },
  // Currency journey (7.4): MoneyTrail (step icon + label, pos/neg change beside fg figure,
  // warn "Part at the ECB rate" chip), Your dollars (DivergingBar pos/neg stage bars,
  // accent links beside pos/neg total), CashOutCard (pos/neg figures beside warn flagged chip
  // and faint "only in euros" dashes), and Impact bridge (accent flow bars beside pos/neg).
  // All already-covered pos/neg, warn/pos, warn/neg, fg/pos, fg/neg pairs hold here too;
  // neutral step icons and EurOnly dashes rely on shape/word, never hue.
  { a: "--color-faint", b: "--color-neg", why: "Dollars bridge / CashOutCard: neutral dash vs loss" },
  { a: "--color-accent", b: "--color-neg", why: "Dollars / Impact bridge: action link or flow bar vs loss" },
];

/** Charts with 3+ untoned series (n2..n4) are rare; they get the lower bar plus dashes. */
const SERIES = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5", "--chart-6"];
export const RARE_PAIRS: { a: string; b: string }[] = [
  ...SERIES.flatMap((a, i) => SERIES.slice(i + 1).map((b) => ({ a, b }))),
  ...["--chart-4", "--chart-5"].flatMap((a) => ["--color-pos", "--color-neg"].map((b) => ({ a, b }))),
];

/** Text colors: >= 4.5:1 on surface and bg for normal vision, >= 3:1 as a protan sees it. */
const TEXT_TOKENS = ["--color-pos", "--color-neg", "--color-warn", "--color-faint"];
/** Lines / marks: >= 3:1 on surface and bg, in normal vision and as a protan sees it. */
const MARK_TOKENS = [
  ...SERIES,
  "--color-muted",
  "--color-estimate",
  "--color-accent",
  "--chart-estimate",
  "--color-lot-long",
  "--color-lot-soon",
  "--color-bell",
  "--color-fx-moon",
  "--color-fx-sunrise",
];

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

const dark = tokens(block("@mixin dark-tokens {"));
const themes: Record<string, Record<string, string>> = {
  light: tokens(block(":root {")),
  dark,
  // The navigation spine. Light theme (.u-ink): the light set on a tinted canvas with
  // white tiles. Dark theme (ink-tokens): the dark set on a navy canvas. The portfolio
  // card in the sidebar shows pos/neg/warn figures and the market-state dot there.
  "spine-light": { ...tokens(block(":root {")), ...tokens(block(".u-ink {")) },
  ink: { ...dark, ...tokens(block("@mixin ink-tokens {")) },
};
const min = (v: Vision) => (v === "protan" ? MIN_PROTAN : MIN_OTHER);

describe.each(Object.entries(themes))("color-blind safe palette (%s)", (_name, t) => {
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
