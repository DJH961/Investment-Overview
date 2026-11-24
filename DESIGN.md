---
name: Investment Dashboard
description: Private-bank calm with neobank polish; a personal portfolio read in EUR and USD.
colors:
  ink-navy: "#0d1626"
  slate-muted: "#566173"
  slate-faint: "#5a6578"
  quiet-indigo: "#3e3cb4"
  lagoon-cyan: "#06b6d4"
  brand-indigo: "#4f46e5"
  brand-teal: "#0891b2"
  action-ink: "#121b2c"
  paper-canvas: "#f6f7fa"
  card-white: "#ffffff"
  well-mist: "#eef0f4"
  hairline-grey: "#e3e6ec"
  border-strong-grey: "#cbd1db"
  spine-navy: "#0d1524"
  gain-harbor-blue: "#2a6181"
  loss-rust: "#74210c"
  warn-ochre: "#806912"
  estimate-violet: "#9c6ef7"
  chart-indigo: "#414df3"
  chart-teal: "#319790"
  chart-gold: "#8a6d00"
  chart-clay: "#b88365"
  chart-pine: "#356c62"
  chart-plum: "#691586"
  night-fg: "#eef2f8"
  night-muted: "#9aa4b5"
  night-accent: "#a09bff"
  night-canvas: "#070a10"
  night-surface: "#0f141d"
  night-well: "#161c28"
  night-border: "#1d2431"
  night-gain: "#4eb0cd"
  night-loss: "#d0784e"
  night-warn: "#eacb5d"
typography:
  hero:
    fontFamily: "Source Serif 4 Variable, Georgia, Times New Roman, serif"
    fontSize: "4.5rem"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-0.015em"
    fontFeature: "lnum, tnum"
  display:
    fontFamily: "Source Serif 4 Variable, Georgia, Times New Roman, serif"
    fontSize: "2.125rem"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-0.015em"
    fontFeature: "lnum, tnum"
  title:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  figure:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "1.625rem"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-0.02em"
    fontFeature: "tnum, cv11, ss01"
  body:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "cv11, ss01"
  body-sm:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter Variable, Inter, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "0em"
rounded:
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  full: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "7": "32px"
  "8": "48px"
  "9": "64px"
components:
  button-primary:
    backgroundColor: "{colors.action-ink}"
    textColor: "{colors.card-white}"
    rounded: "{rounded.sm}"
    padding: "0 16px"
    height: "36px"
    typography: "{typography.body-sm}"
  button-secondary:
    backgroundColor: "{colors.card-white}"
    textColor: "{colors.ink-navy}"
    rounded: "{rounded.sm}"
    padding: "0 16px"
    height: "36px"
  button-secondary-hover:
    backgroundColor: "{colors.well-mist}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.slate-muted}"
    rounded: "{rounded.sm}"
    padding: "0 16px"
    height: "36px"
  button-ghost-hover:
    backgroundColor: "{colors.well-mist}"
    textColor: "{colors.ink-navy}"
  card:
    backgroundColor: "{colors.card-white}"
    rounded: "{rounded.lg}"
    padding: "20px 24px"
  input:
    backgroundColor: "{colors.well-mist}"
    textColor: "{colors.ink-navy}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "44px"
  chip:
    backgroundColor: "{colors.well-mist}"
    textColor: "{colors.ink-navy}"
    rounded: "{rounded.full}"
    padding: "0 12px"
    height: "28px"
    typography: "{typography.label}"
  segmented-track:
    backgroundColor: "{colors.well-mist}"
    rounded: "{rounded.md}"
    padding: "2px"
  segmented-option-selected:
    backgroundColor: "{colors.card-white}"
    textColor: "{colors.ink-navy}"
    rounded: "9px"
    height: "30px"
  nav-item-active:
    backgroundColor: "{colors.card-white}"
    textColor: "{colors.ink-navy}"
    rounded: "{rounded.sm}"
---

# Design System: Investment Dashboard

## Overview

**Creative North Star: "The Neo-Private Bank"**

The calm of a private-bank statement, built with the polish of the best neobank and neobroker apps. It should feel technical and current without ever feeling busy: generous, even spacing; soft layered surfaces with restrained depth; large, confident figures; one restrained accent; motion so quiet you notice it only when it's missing. The numbers are the loud part. Everything around them steps back.

Two signatures carry the identity. The **spine** is the grouped navigation with the portfolio's value at its head: a quiet light spine in the light theme, deep navy ink in the dark. The **stage** is a page's one subject on a single lit surface a step above the cards: on Overview, the portfolio value in an oversized serif with today's move and the chart. Each page has at most one stage, and everything else is a quieter panel.

The dark theme is a theme of its own, not an inverted light one: a deep blue-black canvas lit from above by two faint glows, surfaces that step up in blue-grey, and light hairlines in place of heavier shadows. Confirmed anti-references: a trading terminal (dense, flashing, red/green), a crypto or neon look (glowing gradients, gamified finance), and a hobby or template admin dashboard (default kit cards, walls of charts).

**Key Characteristics:**
- Figures first: tabular numerals everywhere, one oversized serif figure per page at most.
- Ink, not color, for action; one indigo accent for selection, focus and links only.
- Protan-safe values: gains in blue, losses in orange, never red/green, never color alone.
- One stage per page, one rhythm per page, one figure per screen.
- EUR and USD share one shape: switching currency never moves anything.
- Phone and desktop are the same product at two densities.

## Colors

A cool, near-monochrome slate and navy base, with one indigo accent and a small set of value colors chosen to survive protan color blindness. Every co-displayed pair is validated in `frontend/src/styles/tokens.cvd.test.ts` (Machado 2009 protan CIEDE2000 ≥ 20, ≥ 15 for deutan and normal vision, both themes). The frontmatter lists the light theme plus the key dark-theme values (`night-*`); `frontend/src/styles/tokens.scss` holds the full set for both.

### Primary
- **Quiet Indigo** (`quiet-indigo`; dark: `night-accent`): the one accent. Selection, focus rings, links, the active nav icon and its edge bar, hovered card titles. Never a value color.
- **Action Ink** (`action-ink`; dark: inverted to near-white): primary buttons. The one strong action on a screen reads by weight, not hue.

### Secondary
- **Lagoon Cyan** (`lagoon-cyan`): the second accent stop, used sparingly next to indigo (accent pairs, the dark canvas glow).
- **Brand Indigo → Brand Teal** (`brand-indigo`, `brand-teal`): the brand-mark gradient only, identical in both themes and matching the favicon. Not for UI surfaces.

### Tertiary (values and states)
- **Harbor Blue** (`gain-harbor-blue`; dark: `night-gain`): gains, positive deltas, the 1D primary line when up.
- **Rust** (`loss-rust`; dark: `night-loss`): losses, negative deltas, the 1D primary line when down, destructive buttons.
- **Ochre** (`warn-ochre`; dark: `night-warn`): warnings. Without a red-green axis only lightness separates warn from loss; never nudge one without re-checking the other.
- **Estimate Violet** (`estimate-violet`): estimated values, as badge outlines and connectors only, never as text.
- Each value color has a `-soft` translucent twin in `tokens.scss` for chip and badge fills.

### Chart series
- **Indigo, Teal, Gold, Clay, Pine, Plum** (`chart-indigo` … `chart-plum`): series 1–6. Series 2 and 3 must stay distinct from gain/loss, because the 1D chart recolors its primary line to them. Secondary series are always dashed.

### Neutral
- **Ink Navy** (`ink-navy`; dark: `night-fg`): primary text and figures.
- **Slate Muted / Slate Faint** (`slate-muted`, `slate-faint`; dark: `night-muted`): labels, axis text, meta lines, placeholders.
- **Paper Canvas** (`paper-canvas`; dark: `night-canvas` with two faint indigo/teal glows): the page.
- **Card White** (`card-white`; dark: `night-surface`): cards, tiles, the active sidebar row, the raised segmented option.
- **Well Mist** (`well-mist`; dark: `night-well`): sunken things: segmented tracks, inputs, chips, table hover.
- **Hairline Grey / Strong Grey** (`hairline-grey`, `border-strong-grey`; dark: `night-border`): card borders and dividers; the strong step for hover and secondary buttons.
- **Spine Navy** (`spine-navy`): the deep ink of the dark-theme spine and the dark top of the phone dock.

### Named Rules
**The One Accent Rule.** Indigo means "selected, focused or clickable". It never carries a value, a status or a series.

**The Ink-Not-Color Rule.** The primary action is ink on canvas. Colored buttons are reserved for destructive actions (rust, soft fill).

**The Protan Rule.** Gains are blue, losses are orange. Any two colors that appear together with different meanings go into the CVD pair list, and no meaning rides on color alone: statuses carry an icon or a word, secondary series are dashed.

## Typography

**Display Font:** Source Serif 4 Variable, optical sizing (with Georgia)
**Body Font:** Inter Variable, optical sizing (with system-ui)

**Character:** Inter does all the work, every figure included, with single-storey `a` and open digits (`cv11`, `ss01`) for calm, even numerals. The serif appears rarely and marks the subject: it is the private-bank half of the pairing; Inter is the neobank half.

### Hierarchy
- **Hero** (Source Serif 4, 500, 4.5rem on desktop, 1.2): the Overview portfolio value. The one oversized figure in the app.
- **Display** (Source Serif 4, 500, 2.125rem, 1.2): page titles, the one lead figure of a page or card, the Daily Brief's title, the app name. Lining tabular numerals.
- **Title** (Inter, 600, 1.0625rem; 0.9375rem on phones): card titles.
- **Figure** (Inter, 500, sizes from 1.25rem to 2.75rem, -0.02em): KPI tiles and big numbers outside the stage. Always tabular.
- **Body** (Inter, 400, 0.9375rem / 0.8125rem, 1.5): text, table cells, controls.
- **Label** (Inter, 500, 0.75rem, muted, sentence case): the eyebrow above a figure. No tracked capitals.

The scale runs 0.6875 · 0.75 · 0.8125 · 0.9375 · 1.0625 · 1.25 · 1.625 · 2.125 · 2.75 · 3.25 · 4.5 rem.

### Named Rules
**The Serif Marks the Subject Rule.** Serif for titles and the single lead figure only. Never in tables, tiles or controls.

**The Tabular Rule.** Every figure is `tabular-nums`, right-aligned in tables.

**The Quiet Label Rule.** Labels are sentence case, medium weight, muted; the figure under them is the loud part. Only tickers stay in capitals, because they are names.

## Layout

A 4px base with an 8px rhythm between blocks (4, 8, 12, 16, 20, 24, 32, 48, 64). The page gap between sections is 12px on phones, 20px on tablet and desktop, and 24px at 1440px and up; tile grids use the same gap, so tiles and cards read as one rhythm. A card's inner padding is 24 × 20px (16 × 16 on phones); related rows inside a card are 8–12px apart, and a card never has two different gutters.

Breakpoints: phone < 640px, tablet 640–1023, desktop ≥ 1024, wide ≥ 1280, xl ≥ 1440, xxl ≥ 1920. Content tops out at 1440px wide.

- **Desktop:** a fixed spine (264px, 288px at ≥ 1440, 312px at ≥ 1920; collapsible to a 64px rail) and a 56px glass top bar with freshness, the EUR/USD toggle and theme. Composition is one lead surface, then quieter panels; at ≥ 1280 Overview runs two columns that end level (the treemap takes the slack) with no hollow cards.
- **Tablet:** the icon rail plus the same top bar.
- **Phone:** a compact glass top bar and a floating dock (56px plus 8px of air) with four primary tabs and More. Cards stack, tables become list rows, tap targets are at least 44px, safe-area insets are respected, and a lone last tile in a two-up grid spans the full row.
- Cards in a narrow column lay out by their own width (container queries).

### Named Rules
**The One Stage Rule.** A page has at most one stage: its single subject, a step above the cards.

**The One Shape Rule.** EUR and USD have one shape. Fitted figures keep a fixed line box, currency-only lines are reserved or held invisibly, and rows keep their line count. A currency switch never moves anything.

**The Once-Per-Screen Rule.** A figure appears once per screen. Charts get a second axis only from 720px of chart width; the right gutter is reserved either way, so the plot never resizes.

## Elevation & Depth

A hybrid of tonal layering and restrained shadow. Levels, lowest to highest: the canvas (with its faint glow), the spine, the stage, surfaces (cards and tiles), wells (sunken), glass (fixed bars, with backdrop blur) and overlays (dialogs, sheets, menus, popovers over a dim scrim). Light-theme shadows are barely there; the dark theme adds a hairline top highlight instead of a heavier shadow.

### Shadow Vocabulary
- **Rest** (`--shadow-1`): every surface at rest; near-invisible in light, hairline-plus-drop in dark.
- **Hover** (`--shadow-hover`): a clickable surface under the pointer, with the strong border.
- **Overlay** (`--shadow-2`): dialogs, sheets, menus and popovers only.

### Named Rules
**The Lift-Without-Moving Rule.** Hovering a clickable surface changes its border and shadow only. Nothing moves, except a 1px press on buttons.

## Shapes

Larger things are rounder: controls 8px, tiles and wells 12px, cards 16px, the stage, dialogs and sheets 20px, chips and pills fully round. Borders are 1px hairlines. Bars in charts round only at the data end, 2px apart. Area fills fade from the line color at no more than 0.18 opacity.

## Components

### Buttons
Quiet and weighty; the action reads by ink, not by color.
- **Shape:** gently rounded (8px), 36px tall (28 small, 44 large); on phones the label wraps and the button grows to at least 44px.
- **Primary:** action ink with white text, semibold 0.8125rem, rest shadow; hover drops to 88% opacity.
- **Secondary:** card surface with a strong border; hover sinks to the well color.
- **Ghost:** transparent, muted text; hover gets a well fill and full-strength text.
- **Danger:** soft rust fill, rust border and text; hover fills solid rust.
- **States:** 1px press on active, 55% opacity when disabled, a 2px indigo focus ring offset 2px.

### Chips
- **Style:** fully round, 28px, well fill with a hairline, 0.75rem medium tabular text, an optional muted leading icon.
- **Tones:** outline, accent (soft indigo), pos and neg (soft value fills), each with an icon or word. A small size for phones.

### Cards / Containers
- **Corner Style:** 16px; the stage uses 20px with its own lit gradient and border.
- **Background:** card surface, hairline border, rest shadow. A plain variant borrows the surface it sits in.
- **Header:** semibold title on the left; a quiet, right-aligned meta note (price time, "Today") that wraps to its own line before it squeezes the title. Collapsible cards make the whole title the toggle, with a rotating chevron.
- **Internal Padding:** 24 × 20px (16 × 16 on phones).

### Inputs / Fields
- **Style:** a well: sunken fill, hairline border, 8px radius, 44px tall, 0.9375rem text, faint placeholder and leading icon.
- **Focus:** the border turns indigo, the fill lifts to the card surface, and an indigo ring appears.
- **Disabled:** 55% opacity.

### Segmented Control
A sunken track (12px radius, 2px padding) whose selected option is a raised surface tab. Used for ranges, sub-tabs and the EUR | USD toggle; a full-width block variant serves as a sub-tab bar.

### Navigation (the spine)
Grouped by what the owner is doing (Portfolio, Dig in, Manage; System at the foot), with the portfolio value at its head. The open page is a lit row: card surface, rest shadow, semibold text, an indigo icon and an indigo bar on its edge, so shape, weight and position say "here", not hue alone. Phones get a floating dock that follows the theme.

### The Stage (signature)
The Overview hero: the portfolio value in the hero serif, today's move as a pill, the ☀ day / ☾ night split shown once as two figures in the order they happened, a facts-only Today block (low, high, previous close), and the value chart, all on one lit surface.

### Charts
Primary line solid 2px in series 1 (or gain/loss on 1D), second currency dashed in series 2, horizontal gridlines only, muted 0.75rem tabular axis labels. The last value sits in a small pill at the line's end. Hover shows a crosshair, ringed dots and an overlay-level tooltip.

## Do's and Don'ts

### Do:
- **Do** take every color, size, space and radius from a `var(--…)` token in `tokens.scss`, with BEM class names.
- **Do** use tabular numerals for every figure and right-align numbers in tables.
- **Do** add every new co-displayed color pair to `tokens.cvd.test.ts`, and pair every status color with an icon or a word.
- **Do** dash every secondary chart series.
- **Do** keep motion quiet: 120ms for hover and press, 200ms for state changes and sheets, 320ms for the one page fade; standard easing `cubic-bezier(0.2, 0, 0, 1)`; turn all of it off under reduced motion.
- **Do** show freshness on every data view and use skeletons, never a spinner over a blank page.
- **Do** keep the information on phones; change the density, not the content.

### Don't:
- **Don't** use red/green for gains and losses, or let color alone carry a meaning.
- **Don't** use the indigo accent as a value, status or series color.
- **Don't** set the serif in tables, tiles or controls, or put more than one oversized figure on a page.
- **Don't** let a EUR/USD switch move, resize or reflow anything.
- **Don't** build a trading-terminal look: dense flashing tickers, red/green walls, cramped grids.
- **Don't** use a crypto or neon look: glowing gradients, saturated color fields, gamified finance styling.
- **Don't** ship a hobby or template-admin dashboard: default kit cards, walls of charts, uneven gaps or a lone tile on its own row.
- **Don't** bounce, slide cards in one by one, or move surfaces on hover.
