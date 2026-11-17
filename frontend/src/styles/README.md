# The v7 look: calm and premium

The design system behind every page. Tokens live in `tokens.scss`, the shared
recipes in `_mixins.scss`; components use only `var(--…)` tokens and BEM class
names (AGENTS.md › "v6 structure and style"). This file says what the tokens are
*for*, so new screens land in the same voice.

The brief: a private-bank statement, not a trading terminal. Generous, even
spacing; soft layered surfaces with restrained depth; large confident figures; one
restrained accent; quiet motion. Two signatures carry the identity: the **ink spine**
(navigation in deep navy, in both themes) and the **Overview stage** (the portfolio
value in an oversized serif, today's move and the chart on one lit surface). Everything
around them stays quiet.

## Structure (pass 2)

- **Navigation spine** (`Sidebar`, `TabBar`, `.u-ink` in tokens.scss): the dark token set
  on navy in both themes. Groups by what the owner is doing: Portfolio, Dig in, Manage;
  System at the foot. The portfolio's value sits at the head of the spine (the top bar
  shows it only when the spine is a rail or on phones). Phones get a floating ink dock.
  New pages join a group in `lib/nav.ts` (the Currency page joins Dig in).
- **The stage** (`.overview-page__stage`, `--stage-bg`, `--stage-border`, `--radius-xl`): a
  page's one subject. Overview: hero + graph. Holdings: the summary. Periods: the
  growth chart. Projection: the answer + chart. One stage per page, at most.
- **Composition**: one lead surface, then quieter panels. Overview at >= 1280 px:
  Holdings (2fr) beside today's currency and the movers (1fr); both columns end level.
  Cards set into a narrow column lay out by their own width (container queries).
- **A figure appears once per screen.** The ☀ day / ☾ night split of today's move lives
  in the hero only ("☾ + ☀ = Total" while the market is open; after the close tonight's
  ☾ sits beside the Total, not in it). Its explanation is one shared legend
  (`DaySplitLegend`, `DAY_SPLIT_LINES`). The Holdings card says ☾ once in its header.
- **EUR and USD have one shape.** A currency switch never moves anything: fitted
  figures keep a fixed line box, currency-only lines are reserved or held invisibly,
  rows keep their line count. Check with the EUR | USD height script in the PR notes.

## Type

| Role | Face | Where |
| --- | --- | --- |
| Display | Source Serif 4 Variable, optical sizing (`--font-display`, `m.display($size)`) | **The serif marks the subject**: page and section titles, the one lead figure of a page or card (the Overview value at `--font-size-hero`), the Brief's title, the app name. Never in tables, tiles or controls. |
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
| 0 canvas | `--color-bg` (+ `--color-bg-glow`) | The page. Dark: a deep blue-black lit by two faint glows. |
| spine | `.u-ink` | Sidebar, rail, phone dock: navy in both themes. |
| stage | `--stage-bg`, `--stage-border` | A page's one subject, a step above the cards. |
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
Primary line solid 2 px `--chart-1` (or pos/neg on 1D), second currency dashed `--chart-2`,
horizontal gridlines only (`--color-border`), a faint baseline, axis labels `--color-muted`
xs tabular. Area: a soft fade of the line colour (top ≤ 0.18). The last value as a small
pill at the line's end (single-axis charts), text in fg, a dot for identity. The after-close
"now" point is filled in the primary's colour. Hover: crosshair, ringed dots, a level-2
tooltip. Bars: rounded at the data end only, 2 px apart.

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
