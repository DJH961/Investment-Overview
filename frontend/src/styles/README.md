# The v7 look: calm and premium

The design system behind every page. Tokens live in `tokens.scss`, the shared
recipes in `_mixins.scss`; components use only `var(--…)` tokens and BEM class
names (AGENTS.md › "v6 structure and style"). This file says what the tokens are
*for*, so new screens land in the same voice.

The brief: a private-bank statement, not a trading terminal. Generous, even
spacing; soft layered surfaces with restrained depth; large confident figures; one
restrained accent; quiet motion. The memorable element is the **headline figure in
a serif**; everything around it stays quiet.

## Type

| Role | Face | Where |
| --- | --- | --- |
| Display | Source Serif 4 Variable, optical sizing (`--font-display`, `m.display($size)`) | Page titles, the Overview headline value, the Brief's title. Nowhere else. |
| Interface and figures | Inter Variable, optical sizing (`--font-sans`) | Everything else, including every number in a table or tile. |

- Both fonts are self-hosted through `@fontsource-variable/*` (CSP: no external requests).
- Figures are always tabular (`font-variant-numeric: tabular-nums`); `m.figure($size)` gives
  a big Inter figure (medium weight, `--tracking-display`).
- Scale (rem): 2xs .6875 · xs .75 · sm .8125 · md .9375 · lg 1.0625 · xl 1.25 · 2xl 1.625 ·
  3xl 2.125 · 4xl 2.75 · display 3.25. Page title = 3xl serif; card title = lg semibold;
  body = md/sm; labels = xs medium muted.
- **Labels are sentence case** (`m.eyebrow`): medium weight, muted, no tracked capitals.
  The figure under the label is the loud part. Only tickers stay in capitals (they are names).

## Spacing rhythm

4 px base (`--space-1` … `--space-9` = 4, 8, 12, 16, 20, 24, 32, 48, 64).

- `--page-gap`: between the sections of a page (12 phone · 20 tablet/desktop · 24 at ≥ 1440).
- `--card-pad-x` / `--card-pad-y`: a card's inner padding (16/16 phone · 24/20 elsewhere).
- Inside a card, related rows are 8–12 apart; a card never has two different gutters.
- Grids of tiles use `--page-gap` too, so tile gaps and card gaps read as one rhythm.

## Surfaces and depth

| Level | Token | Use |
| --- | --- | --- |
| 0 canvas | `--color-bg` (+ a faint `--color-bg-glow`) | The page; the sidebar sits on it. |
| 1 surface | `--color-surface`, `--shadow-1`, `--color-border` (`m.surface`) | Cards, tiles, the hero, the active sidebar row. |
| well | `--color-surface-2` (`m.well`) | Sunken: segmented tracks, inputs, chips, table hover. |
| glass | `--color-surface-glass` + backdrop blur | Fixed bars (top bar, phone tab bar). |
| 2 overlay | `--shadow-2`, `--color-overlay` | Dialogs, sheets, menus, popovers. |

Hover on a clickable surface: `m.lift` (border and shadow only, no movement).
Dark mode adds a hairline top highlight (`--color-hairline`) instead of heavier shadow.

## Radii

Controls `--radius-sm` (8) · tiles and wells `--radius-md` (12) · cards `--radius-lg` (16) ·
hero, dialogs, sheets `--radius-xl` (20) · pills `--radius-full`. Larger things are rounder.

## Colour

- **Ink, not colour, for action:** the primary button is `--color-ink` on `--color-ink-fg`.
- **One restrained accent** (`--color-accent`, indigo): selection, focus rings, links, the
  active nav icon. Never a value colour.
- **Values:** gains `--color-pos` (blue), losses `--color-neg` (orange), `--color-warn`
  (ochre), `--color-estimate` (violet, outlines only). Never red/green (the owner is protan).
- Every colour shown next to another with a different meaning is listed in
  `tokens.cvd.test.ts` (protan CIEDE2000 ≥ 20, ≥ 15 deutan/normal, both themes).
  Never colour alone: statuses carry an icon or a word, secondary series are dashed.

## Charts

Series palette `--chart-1` … `--chart-6` (unchanged from v6; validated in the CVD test).
Primary line solid `--chart-1` (or pos/neg on 1D), second currency dashed `--chart-2`,
gridlines `--color-border`, axis labels `--color-muted` xs tabular. Area fills are a soft
fade of the line colour; no gradients as decoration.

## Motion

`--duration-fast` 120 ms (hover, press) · `--duration-base` 200 ms (state changes, sheets) ·
`--duration-slow` 320 ms (the one page fade on route change). Easing `--ease-standard`,
entrances `--ease-out`. Nothing bounces, nothing slides in per card. `prefers-reduced-motion`
switches all of it off (`base.scss`).

## Shared primitives (use these, don't restyle per page)

| Need | Component |
| --- | --- |
| A section | `Card` (title, actions, collapsible) |
| A headline note above a page (the Daily Brief) | `Callout` |
| A KPI | `KpiTile` / `KpiGrid` |
| A row of compact figures in one surface (the Currency tile strip) | `StatStrip` |
| Switch views of one thing (ranges, sub-tabs) | `SegmentedControl` (`block` for a full-width sub-tab bar) |
| Switch whole panels (holding page Details / Transactions / Dividends) | `Tabs` |
| A status, tag or the market clock | `Chip` (tone + icon; `size="sm"` on phones) |
| The top bar's clock slot | `TopBar` `clock` prop (sits beside the freshness chip) |
| Buttons | `Button` (primary = ink, secondary = surface, ghost) / `IconButton` |
| Inputs | `Field` + `Input` / `Select` / `Switch` |
| Overlays | `Dialog` (desktop), `Sheet` (phone) |
| Nothing to show / loading / failed | `EmptyState`, `Skeleton`, `ErrorState` |
| Tables | `DataTable` |
