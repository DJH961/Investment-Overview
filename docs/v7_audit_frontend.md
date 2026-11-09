# v7 pre-planning audit — frontend

Read-only audit of `frontend/` (React 19 + TS + Vite) done on 2026-11-09 against
`main` at 72210e1f (frontend 6.13.0). `web/` (v5 demo) is out of scope. No code was
changed; this file is the only output.

Finding format: ID, title, severity (Critical / High / Medium / Low / Nit), category,
confidence (confirmed / likely / suspected), where, what the user sees, fix direction
and size (S/M/L).

## Coverage

- [x] Shell: `App.tsx`, `main.tsx`, AppShell, TopBar, Sidebar, TabBar, OfflineBanner, BrandMark, Tour
- [x] Primitives: Button, IconButton, Card, Dialog, Sheet, Menu, Select, Input, Field, Switch, SegmentedControl, Tooltip, InfoTip, Toast, Skeleton, EmptyState, ErrorState, PageHeader
- [x] Numbers: Money, Percent, DeltaBadge, KpiTile, KpiGrid, Freshness
- [x] Charts: Chart, Sparkline, ValueChartCard, HeroIntraday, GrowthBars, DivergingBar, Treemap, AllocationBar
- [x] Overview cards: OverviewHero, OverviewHoldings, OverviewWarnings, MoversCard, CurrencyBox, CurrencyLifetime, AllocationCard, AssetClassCard, DataTable
- [x] Pages: Overview
- [x] Pages: Holdings
- [x] Pages: Transactions
- [x] Pages: Periods
- [x] Pages: Allocations
- [x] Pages: Risk, Projection
- [x] Pages: CurrencyConversions
- [x] Pages: Import, Instruments
- [x] Pages: Settings
- [x] Pages: Diagnostics, Activity (Diagnostics sub-tabs skimmed for layout: MarketDataTab, RepairTab, SchedulerTab, LogsTab, SystemTab, TiingoCard, TwinsCard, JobParamsForm, RunJob not read line by line)
- [x] Pages: Help, Login, Onboarding, NotFound, Styleguide (Styleguide only checked for routing)
- [x] `lib/` (api, live, tickPatch, queries, format, prefs, hooks); not read in full: `displayPrefs.tsx`, `usePullToRefresh.ts`, `appVersion.ts`, `passkeyHint.ts`, `cvd.ts`, `queries/maintenance.ts`, `queries/instruments.ts`, `queries/allocations.ts`, `queries/activity.ts`, `queries/manage.ts`
- [x] `styles/` (tokens, mixins, base, reset)
- [x] Tooling: typecheck, tests, lint, bundle

## How this audit was done

**Not rendered.** `frontend/` has no mock/MSW/demo mode: every route sits behind
`RequireAuth`, and the only render path (Playwright `e2e/start-backend.mjs`) boots a
local backend and needs a sign-in. The brief rules out logging in, so every visual
finding comes from reading the `.tsx` and `.scss` pairs together. "Confirmed" means
the CSS makes the result certain (for example `overflow: hidden` with no
`text-overflow`, or a `flex-shrink: 0` child in a box that cannot grow). "Likely"
means it depends on real string lengths or numbers that I could not see. Widths are
worked out from the tokens (`--sidebar-width` 264/288/312, rail 64, content padding
24 px, phone padding 16 px).

v7 overlap is checked against `docs/v7_plan.md` §7 (UI audit) and §5 (Currency tab).

## Findings

### Shell (AppShell, TopBar, Sidebar, TabBar, OfflineBanner, Tour)

**F-001 Desktop top bar: the page title never shrinks and paints over the portfolio pill**
- Severity: High · Category: visual · Confidence: likely
- Where: `frontend/src/components/TopBar/TopBar.scss:24-40` (`__title-line` and `__title` are both `flex-shrink: 0`), `:64-79` (`__summary` `min-width: 15rem`, `flex-shrink: 0`, `nowrap`), `:115-120` (`__actions` `flex-shrink: 0`)
- What the user sees: between 1024 px and about 1280 px (full sidebar, so the main column is about 760-1016 px) the actions (about 310 px) and the summary pill (value + badge + money move, about 280-320 px with a seven-figure value) are fixed, leaving roughly 80-150 px for the title block. The title block has `min-width: 0` but nothing inside it may shrink, so "Risk & analytics", "Transactions" or "Health & Repair" overflow the block and draw over the pill. The freshness chip is squeezed to just its dot. At tablet width (rail, summary reduced to value + badge) the chip label disappears to an ellipsis. Probably one of the clipping spots the owner knows.
- Fix direction: let the title truncate on desktop too (`flex-shrink: 1` on line and title), give the freshness chip a sensible minimum, and drop the money move from the pill below `wide` as tablet already does. S

**F-002 Phone top bar: the day % beside the title is cut off mid-glyph, with no ellipsis**
- Severity: High · Category: visual · Confidence: confirmed (CSS), widths likely
- Where: `frontend/src/components/TopBar/TopBar.scss:215-225` (`--compact .top-bar__title` `flex-shrink: 0`; `.top-bar__mini` `overflow: hidden` but no `text-overflow`), `:235-245`
- What the user sees: at 360-390 px the right side holds 4-5 tap targets of 44 px (eye, currency, refresh, account, plus health when something is wrong). That leaves about 150 px for "Transactions"/"Overview" plus the mini figures, so "€1.23M +0.4" gets hard-clipped at the pixel. The day %, the figure that changes, is the part that goes. When the health badge appears the value is cut too. Probably the other known clipping spot.
- Fix direction: decide what goes first (for example drop the compact value and keep the %, or stack the mini figures under the title next to the freshness line), and use ellipsis rather than a hard clip. S

**F-003 "Hide numbers" remounts the whole page and drops unsaved work**
- Severity: Medium · Category: bug · Confidence: confirmed
- Where: `frontend/src/components/AppShell/AppShell.tsx:183` (`<main key={hide ? "hidden" : "shown"}>`), reason in `frontend/src/lib/hideAmounts.tsx:1-5`
- What the user sees: tapping the eye while editing Settings (with the unsaved bar showing), filling the transaction form, half-way through an import preview or the allocation builder throws the edits away. It also resets scroll position, expanded holding rows, sort orders and open sheets.
- Fix direction: make the plain formatters read the flag through context or a subscription (or remount only the display leaves) so the page tree survives. M

**F-004 Live stream is not reopened after sign-in; its URL ignores `VITE_API_BASE`**
- Severity: Medium · Category: bug · Confidence: likely
- Where: `frontend/src/main.tsx:19` (`startLive` runs once at boot, also on `/login`), `frontend/src/lib/live.ts:306` (backoff up to 30 s), `:38-39` (hard-coded `/api/stream`, `/api/health`); nothing calls `reconnectStream` after `login`/`passkeyLogin` (`frontend/src/lib/auth.ts`)
- What the user sees: the stream fails on the login page and backs off 1, 2, 4 … 30 s. After signing in, live ticks and the "Live" chip can take up to 30 s to arrive, so the first half-minute after login looks frozen. The same happens after a sign-out followed by a sign-in. A frontend built with `VITE_API_BASE` (documented in `.env.example`) would stream from the wrong origin.
- Fix direction: export a "reconnect now" from `live.ts` and call it after a successful login. Build both URLs from the same base as `api.ts`. S

**F-005 Rail sidebar: the group dividers are chunky grey blocks, not thin lines**
- Severity: Low · Category: visual · Confidence: confirmed
- Where: `frontend/src/components/Sidebar/Sidebar.scss:56-61` sets `height: 1px` and `font-size: 0` but keeps the base `padding: 12px 12px 8px` (`:81-82`). With `box-sizing: border-box` (`styles/reset.scss:4`) that gives a box about 20 × 24 px filled with `--color-border`.
- What the user sees: on tablet, and on desktop with the rail on, two grey lozenges sit between the nav groups (8 px tall on short screens), where the comment promises "thin dividers". The `very-short` rule does reset the padding.
- Fix direction: add `padding: 0` to the rail rule. S

**F-006 The offline/server banner does not line up with the page content**
- Severity: Low · Category: visual · Confidence: confirmed
- Where: `frontend/src/components/OfflineBanner/OfflineBanner.scss:5` (`margin: 8px 16px 0`) vs `frontend/src/components/AppShell/AppShell.scss:55-58` (content: 24 px padding, `max-width: 1440px`, centred)
- What the user sees: on desktop the banner is inset 16 px while the cards are inset 24 px. Above 1440 + sidebar it stretches across the whole main column while the cards stay centred, so its edges match nothing. At phone width the 16 px matches.
- Fix direction: render the banner inside the content column (or give it the same max-width and padding). S

**F-007 The tour finds its target only once per step and anchors to nav items a phone cannot see**
- Severity: Low · Category: ux · Confidence: confirmed
- Where: `frontend/src/components/Tour/Tour.tsx:67-73` (re-queries only on `resize`), `frontend/src/components/Tour/steps.ts:25-37` (`/risk`, `/projection`, `/import` live in the closed More sheet on phones)
- What the user sees: on a phone, steps 4-6 fall back to a centred dialog that points at nothing. The first step says "Use the arrow keys", which a phone does not have. The tour also starts on first visit on every new device, including over the first page load.
- Fix direction: per breakpoint, anchor to the More tab (or skip those steps) and use touch wording on phones. S

**F-008 The sidebar nav scrolls with no visible scroll affordance**
- Severity: Nit · Category: ux · Confidence: confirmed
- Where: `frontend/src/components/Sidebar/Sidebar.scss:65-75` (`scrollbar-width: none`)
- What the user sees: in a very short window (zoomed laptop) the last items (Settings, Help) sit below the fold with no hint that the list scrolls.
- Fix direction: add a fade mask at the bottom when it overflows. S

### Primitives (Button … PageHeader)

These are mostly sound: Radix underneath, tokens throughout, a focus ring on every
control (the global `:focus-visible` in `styles/base.scss` also covers the ones
without their own rule). Points worth fixing:

**F-009 Toasts are told apart by colour alone and cannot be dismissed**
- Severity: Low · Category: a11y · Confidence: confirmed
- Where: `frontend/src/components/Toast/Toast.tsx:35-46`, `Toast.scss:11-17`
- What the user sees: success, error and neutral toasts differ only in a 4 px left border (blue / orange / indigo). There is no icon, which breaks the project's "never colour alone" rule. There is no close button either, and an error toast with a long description vanishes after 5 s.
- Fix direction: add a tone icon and a close button, and keep error toasts open until dismissed (or longer). S

**F-010 Segmented controls are 24-30 px tall on phones**
- Severity: Low · Category: a11y · Confidence: confirmed
- Where: `frontend/src/components/SegmentedControl/SegmentedControl.scss:8-34` (no `m.phone` tap-size rule, unlike Button, IconButton, Select and Menu)
- What the user sees: chart range pickers (1D/1W/1M …), the Holdings and Periods view switches and similar are the smallest targets in the app on a phone, which makes mis-taps between neighbours common.
- Fix direction: raise the item height to `--tap-min` under `m.phone`, as the other controls do. S

**F-011 The bottom sheet's drag handle does nothing**
- Severity: Low · Category: ux · Confidence: confirmed
- Where: `frontend/src/components/Sheet/Sheet.tsx:19`, `Sheet.scss:30-37`
- What the user sees: the More sheet and the holding detail sheet show a grab handle, but swiping down does not close them, and there is no close button. Only a tap on the dimmed area (or the back gesture) closes them.
- Fix direction: either add swipe-to-close or a visible close button, or drop the handle. S

**F-012 Buttons never wrap or truncate**
- Severity: Nit · Category: visual · Confidence: likely
- Where: `frontend/src/components/Button/Button.scss:15` (`white-space: nowrap`, no `max-width`/`overflow`)
- What the user sees: a long label (for example in the Diagnostics repair actions or the import flow) in a narrow card at 360 px pushes past the card edge instead of wrapping.
- Fix direction: allow `max-width: 100%` with ellipsis, or wrapping on phones. S

### Numbers (Money, Percent, DeltaBadge, KpiTile, KpiGrid, Freshness, `lib/format.ts`)

The formatters are good. Everything goes through `formatIntl`, `Money` and
`Percent`, which use tabular figures and `nowrap`, and no rounding is done ad hoc.

**F-013 A value that rounds to zero still shows the gain/loss colour and arrow**
- Severity: Low · Category: inconsistency · Confidence: confirmed
- Where: `frontend/src/lib/format.ts:277-280` (`signOf` uses the raw value) vs `:144`/`:162` (`signDisplay: "exceptZero"` uses the rounded value); used by `Money.tsx:21`, `Percent.tsx:15`, `DeltaBadge.tsx:15-16`
- What the user sees: a day move of −0.003 % renders as "0.00%" with no sign, but in orange with a down-right arrow badge (and "€0.00" in orange for −0.004). On a flat morning or a closed-market day the hero, the top-bar pill and Movers show contradictory "0.00%" chips.
- Fix direction: take the tone from the value rounded to the same digits as the text (one helper in `format.ts`). S

**F-014 The KPI tile's own info button: a 13 px tap target that duplicates InfoTip**
- Severity: Low · Category: a11y / inconsistency · Confidence: confirmed
- Where: `frontend/src/components/KpiTile/KpiTile.tsx:81-87`, `KpiTile.scss:44-66` (padding 0, icon 13 px on phones) vs `frontend/src/components/InfoTip/InfoTip.scss:17-20` (InfoTip pads itself to a finger-sized target on phones)
- What the user sees: on a phone the (i) beside "XIRR", "Total growth" and the other labels is very hard to hit, while the (i) in the strip beneath works fine.
- Fix direction: render `InfoTip` inside `KpiTile` and delete the copy. S

**F-015 Every KPI tile forces a synchronous layout on every render (each SSE tick)**
- Severity: Low · Category: inefficiency · Confidence: confirmed
- Where: `frontend/src/components/KpiTile/KpiTile.tsx:35-59` (`useLayoutEffect` deps include `value`, a new React element on every render; it resets `--kpi-tile-fit` to 1, reads `scrollWidth`, and rebuilds the ResizeObserver)
- What the user sees: nothing directly. But the Overview (8 tiles), Holdings, Periods and Risk each do a read-write-read layout per tile on every tick and refetch, which adds main-thread work on phones exactly when numbers update.
- Fix direction: key the effect on the formatted text (or a primitive), and create the ResizeObserver once. S

**F-016 A KPI tile's secondary line is hard-clipped (no ellipsis), and a value below the 0.55 fit floor spills**
- Severity: Low · Category: visual · Confidence: confirmed (CSS)
- Where: `frontend/src/components/KpiTile/KpiTile.scss:77-93` (`text-overflow` on a flex container has no effect), `:95-109` (`nowrap`, no overflow guard), `KpiTile.tsx:28`
- What the user sees: in a two-column phone grid, "+US$1,234,567.89" under a EUR figure is cut at the pixel. A long negative value such as "−US$12,345,678.90" in a 160 px tile hits the 0.55 floor and then runs into the neighbouring tile.
- Fix direction: wrap the secondary text in an inline-block that truncates; past the fit floor switch to compact notation rather than overflow. S

**F-017 The freshness chip says "Reconnecting…" on any stream blip; the banner waits 10 s**
- Severity: Low · Category: inconsistency · Confidence: confirmed
- Where: `frontend/src/components/Freshness/describeFreshness.ts:72` vs `frontend/src/lib/live.ts:42` (`LOST_AFTER_MS`)
- What the user sees: a one-second proxy reconnect flips the top-bar chip from "Live · 14:32" to an amber "Reconnecting…" and back. The app deliberately avoids that flash in the banner, but not in the chip.
- Fix direction: apply the same grace period to the chip (keep the last good label until about 10 s have passed). S

**F-018 Two dashes for "missing"; "US$" in tables vs "$" in charts**
- Severity: Nit · Category: inconsistency · Confidence: confirmed
- Where: `frontend/src/lib/format.ts:132,155,170` (en dash "–") vs `frontend/src/pages/Periods/Maybe.tsx:19` (em dash "—"); `format.ts:139` (`symbol`, so en-GB prints "US$") vs charts (`narrow`, "$")
- What the user sees: missing cells look slightly different between Periods and every other table. The same dollar amount reads "US$1,234" in a table and "$1,234" in the chart tooltip right above it.
- Fix direction: one `MISSING` constant; consider `narrowSymbol` everywhere while the app only shows EUR and USD. S

### Charts (Chart, ValueChartCard, HeroIntraday, GrowthBars, DivergingBar, Treemap, AllocationBar, Sparkline)

v7 §7 already plans to give HeroIntraday a tooltip by moving it onto the shared
Chart, so that is not repeated here.

**F-019 Phones at 360-375 px: the 8-button range picker pokes out of the Graph card**
- Severity: Medium · Category: visual · Confidence: likely (widths worked out from tokens)
- Where: `frontend/src/components/ValueChartCard/ValueChartCard.tsx:208-213` (8 ranges), `frontend/src/components/SegmentedControl/SegmentedControl.scss:1-34` (`inline-flex`, no wrap, item `min-width: 36px`), `frontend/src/components/Chart/Chart.scss:9-15`
- What the user sees: content width at 360 px is 360 − 2×16 (page) − 2×16 (card) = 296 px. "1D 1W 1M 3M 6M YTD 1Y ALL" needs about 316 px (six 36 px items, YTD/ALL about 40 px each, 2 px gaps and padding). The picker sticks about 20 px past the card's right border (the card does not clip), and still about 5 px at 375 px. It fits from about 390 px.
- Fix direction: let the segmented control shrink its items on phones (`flex: 1`, `min-width: 0`, smaller padding) or scroll horizontally. Folding into a select is not needed. S

**F-020 Chart and Treemap first paint at a fake 600 px width, then jump**
- Severity: Low · Category: visual · Confidence: confirmed
- Where: `frontend/src/components/Chart/Chart.tsx:244` (`useState(600)`) and `:250-259` (`useEffect` measures after paint); `frontend/src/components/Treemap/Treemap.tsx:105-117`
- What the user sees: on a phone, every time a chart mounts (page change, range change from empty, opening the holding sheet) the first frame is laid out for 600 px. That means desktop margins, the non-compact mode and tiny scaled text, before it snaps to the compact phone layout. The Treemap first frame shows tiles squarified for 600 px and clipped. It reads as a flicker on every navigation.
- Fix direction: measure in `useLayoutEffect` (or a callback ref) before the first paint, or render nothing until the width is known. S

**F-021 The chart stops tracking its width if it first mounts empty**
- Severity: Low · Category: bug · Confidence: likely
- Where: `frontend/src/components/Chart/Chart.tsx:250-259` (ResizeObserver deps `[loading, series.length]`; while there is no data the early return at `:407-416` renders no `wrapRef`)
- What the user sees: when a chart first renders the "No history for this range yet." state (new install, a range with no points, the import that adds data while the page is open) and data then arrives with the same number of series and no loading flip, the observer is never attached. The chart stays at 600 px (scaled down on a phone, non-compact) and does not follow window resizes until the page is remounted.
- Fix direction: attach the observer through a callback ref on the always-rendered outer element. S

**F-022 Phone chart readout is hard-clipped, and its values carry no series name**
- Severity: Low · Category: visual / a11y · Confidence: likely
- Where: `frontend/src/components/Chart/Chart.tsx:640-649`, `Chart.scss:349-360` (`overflow: hidden`, `nowrap`, no ellipsis)
- What the user sees: scrubbing a two-currency chart on a 360 px phone shows "Mon 26/10 14:30 ● €123,456 ▬ $134,567". With a third series (Risk/Projection benchmark lines) the last value is cut at the pixel. The values are identified only by a 10 px swatch, so the protan owner has to tell chart-1 from chart-2 by colour (the dashed bar shape helps for secondary series only).
- Fix direction: allow the readout to wrap to two lines (keeping a fixed height), and prefix each value with its short label ("EUR", "USD", "VT"). S

**F-023 Allocation bar: up to six solid colours side by side, checked only at the "rare" CVD bar**
- Severity: Medium · Category: a11y · Confidence: confirmed
- Where: `frontend/src/components/AllocationBar/AllocationBar.tsx:39-46` (segments `c1`-`c6`, no label or pattern, name only in a `title`), `frontend/src/styles/tokens.cvd.test.ts:49-54` (chart-1…chart-6 pairs only need ΔE 15, "charts with 3+ untoned series are rare")
- What the user sees: the allocation bar is not rare. It shows on the Overview allocation card and on Allocations, every segment is a different meaning next to the others, and fills cannot use the dash cue that lines use. Telling "segment 3" from "segment 4" means matching colours against the legend swatches, which is the hardest task for a protan viewer. Slice 7 reuses slice 1's colour.
- Fix direction: put a short label or percentage inside segments wide enough, add hover/tap focus linking segment ↔ legend row, and either move adjacent chart pairs into `CVD_PAIRS` or alternate a hatch pattern on every other segment. M

**F-024 Treemap tooltip is clipped by its own box and flashes on touch; the tiles are dead buttons**
- Severity: Low · Category: visual / a11y · Confidence: likely
- Where: `frontend/src/components/Treemap/Treemap.tsx:170-183` (x clamped to [70, width − 70] assuming a 140 px tooltip; y centred on the tile), `Treemap.scss:5` (`overflow: hidden`), `:140-167` (`<button>` with no action)
- What the user sees: hovering a tile at the bottom or right edge cuts off the tooltip, and so does a long instrument name with "Today +1.23%". On a phone, tapping fires `pointerenter` and then `pointerleave` immediately, so the tooltip blinks. Keyboard users tab through every tile, and Enter does nothing.
- Fix direction: portal the tooltip (or flip it inside bounds), keep it open on tap until the next tap, and make the tiles open the holding detail (or drop their tab stops). S

**F-025 GrowthBars: the axis labels don't line up with the bars; a zero period draws as a tiny gain**
- Severity: Nit · Category: visual · Confidence: confirmed
- Where: `frontend/src/components/GrowthBars/GrowthBars.scss:80-86` (axis `padding-left: 32px` fixed, while the scale column is `auto`), `GrowthBars.tsx:43-53` (`v >= 0` gives a 1 px blue bar)
- What the user sees: with "+12.3%" ticks the scale column is wider than 32 px, so the first and last axis labels sit off their bars. A flat or empty month shows a hairline in the gain colour.
- Fix direction: put the axis in the same grid as the plot; give 0 a neutral tone. S

**F-026 The graph reload times out silently**
- Severity: Nit · Category: ux · Confidence: confirmed
- Where: `frontend/src/components/ValueChartCard/useGraphReload.ts:36` (after 120 s the spinner just stops)
- What the user sees: when the `graphs` event never comes (stream down, job stuck), the spinner stops after two minutes and nothing says whether it worked.
- Fix direction: toast "Reload still running or lost; check Health & Repair" on timeout. S

### Overview cards and the Overview page

**F-027 The Overview holdings list hard-clips its status pills ("stale value", "bad history") on tablet and desktop**
- Severity: Medium · Category: visual · Confidence: confirmed (CSS), likely in practice
- Where: `frontend/src/components/OverviewHoldings/OverviewHoldings.scss:76-91` (`__symbol`: `flex-wrap: nowrap; overflow: hidden`, no ellipsis; wraps only on phones), pill order in `OverviewHoldings.tsx:236-251`
- What the user sees: the holding column is `minmax(9rem, 1.4fr)` on tablet and `minmax(12rem, 1.8fr)` on desktop. A NAV fund with "VTSAX" + LIVE/NAV + ✓ + "STALE VALUE" + "BAD HISTORY" (uppercase, letter-spaced) runs past the column, and the pills are cut at the pixel. The warnings come last, so they are the part that disappears. This is the Holdings card, the key element of the Overview, and very likely one of the cut-off spots the owner has seen.
- Fix direction: allow a second line on every width (as on phones), or collapse several warnings into one "⚠ 2" pill with a tooltip. Warnings should come before decorative pills. S

**F-028 The hero figure overflows its card at 360 px with a seven-figure value, and has no fit logic**
- Severity: Medium · Category: visual · Confidence: likely
- Where: `frontend/src/components/OverviewHero/OverviewHero.scss:7` (the hero keeps 20 px padding on phones, while `Card` drops to 16 px), `:99-112` (`--font-size-3xl` = 34 px), `frontend/src/components/Money/Money.scss:3` (`nowrap`)
- What the user sees: at 360 px the hero has about 288 px inside. "US$1,234,567.89" (USD view) or "1.234.567,89 €" (de-DE) at 34 px semibold tabular is about 290-305 px, so the number runs through the right border. The KPI tiles shrink their figures to fit (`useFitWidth`); the biggest number on the page does not.
- Fix direction: reuse the KPI tile's fit approach (container-query font size plus a scale), and match the Card's phone padding. S

**F-029 The Overview allocation treemap computes each category's day % in the browser**
- Severity: Medium · Category: interplay · Confidence: confirmed
- Where: `frontend/src/components/AllocationCard/AllocationCard.tsx:47-69` (`t = Σmove / Σ(value − move)` per category)
- What the user sees: a "Today +0.84%" per category tile that the server never computed. It is a ratio of summed money (period growth), which AGENTS.md reserves for the server ("the client … never computes a return"). It also ignores cashflows during the day and mixes FX into the base differently from the server's day split, so a category tile can disagree with the same holdings' figures in the hero and KPI grid.
- Fix direction: add per-category `today_pct` (and tone) to the holdings or allocations payload and draw only that. S (server) + S (client)

**F-030 The post-NAV "twin was X pp off" note appears even when today's pending estimate was never seen**
- Severity: Low · Category: bug · Confidence: confirmed
- Where: `frontend/src/components/OverviewHoldings/OverviewHoldings.tsx:76-86` (`seenPending[row.symbol]` is keyed by symbol only), `:330-346` (stores a stamp but never compares it to the session)
- What the user sees: the comment promises the accuracy note only "if the user watched the pending estimate". After a fund's estimate has been seen once on this device, the note shows after every later NAV drop, including days the user never opened the app before the NAV posted. `dismissed` and `seenPending` also grow in localStorage without ever being pruned.
- Fix direction: key `seenPending` by `twinSessionKey`, and prune entries older than a week. S

**F-031 ECB fixing stamp is off by an hour in summer**
- Severity: Low · Category: bug · Confidence: confirmed
- Where: `frontend/src/components/CurrencyBox/CurrencyBox.tsx:73-77` (`${as_of}T15:00:00Z` for "16:00 CET")
- What the user sees: from late March to late October (CEST) the EOD FX stamp reads "as of 05/07, 17:00" Berlin time instead of 16:00, because 16:00 CEST is 14:00 UTC.
- Fix direction: have the server send the fixing instant, or compute it with the Europe/Berlin offset for that date. S

**F-032 The Overview's empty state points to the wrong page and offers no button**
- Severity: Low · Category: ux · Confidence: confirmed · **v7 overlap:** plan §7 "Ship as patches" #4 (empty states without a way out) covers the missing button
- Where: `frontend/src/pages/Overview/Overview.tsx:94-105`
- What the user sees: "Import a broker file from Transactions…", but importing lives on its own Import page (`/import`, its own nav item). There is no button. Extra beyond v7 #4: fix the wording too.
- Fix direction: "Import a broker file" with a primary button to `/import`, and a secondary "Add a transaction". S

**F-033 Overview layout shifts once the payload lands (currency box and lifetime card pop in)**
- Severity: Low · Category: visual · Confidence: confirmed
- Where: `frontend/src/pages/Overview/Overview.tsx:126` and `:146` (`{data && …}`, no skeleton), `OverviewWarnings` `:115`
- What the user sees: on a cold load (or after a hide-numbers remount, F-003) the hero and KPI skeletons sit directly above the chart. Then a currency card of about 180-260 px is inserted between them, and the chart and movers jump down. The warnings banner does the same above the hero.
- Fix direction: render CurrencyBox and CurrencyLifetime with skeleton bodies while loading. S

**F-034 The data warnings banner is a dead end**
- Severity: Low · Category: ux · Confidence: confirmed
- Where: `frontend/src/components/OverviewWarnings/OverviewWarnings.tsx:10-25`
- What the user sees: "Suspect price history for X" / "Missing FX rate for Y" with no link to the repair action that fixes it (Health & Repair → Market data / Repair). The icon size is a hard-coded `size={16}`.
- Fix direction: add "Fix in Health & Repair →" linking to the right tab. S

**F-035 Small tap targets in the Overview rows**
- Severity: Nit · Category: a11y · Confidence: confirmed
- Where: `frontend/src/components/OverviewHoldings/OverviewHoldings.scss:275-297` (twin "×" dismiss is about 16 px)
- What the user sees: the twin-note dismiss is very hard to hit on a phone.
- Fix direction: pad it to `--tap-min` on phones. S

### DataTable (shared)

**F-036 The DataTable's sticky header never sticks**
- Severity: Low · Category: ux · Confidence: confirmed
- Where: `frontend/src/components/DataTable/DataTable.scss:3-16` (`overflow-x: auto` on the wrapper makes it the sticky scroll container, `top: 0` ignores the 56 px top bar)
- What the user sees: on long tables (Transactions, Activity, Instruments) the column headers scroll away with the page, even though the code means to pin them.
- Fix direction: pin with `top: calc(var(--topbar-height) + var(--safe-top))` on a wrapper that scrolls only horizontally (or drop the dead rule). M

**F-037 Phone DataTable chips show "Label –" for empty values, and long chips are hard-clipped**
- Severity: Low · Category: visual · Confidence: confirmed
- Where: `frontend/src/components/DataTable/DataTable.tsx:71-75` (`isEmptyCell` only recognises plain strings, while most cells are `<Money>`/`<Percent>` elements that render "–"), `DataTable.scss:176-187` (`text-overflow` on an `inline-flex` has no effect)
- What the user sees: phone rows carry chips such as "Fee –" or "XIRR –" that the comment says are dropped. A long chip ("Account Very long broker account name") is cut without an ellipsis.
- Fix direction: let columns pass an `isEmpty(row)` predicate (or test the raw value); put the ellipsis on the inner `__value` span. S

### Holdings page

v7 §7 already covers the three holding-row implementations, the 18-column vs
six-chip density gap, and the deep dive becoming a route (v7.4). Findings below are
the ones that still matter before or outside that rework.

**F-038 The Holdings summary strip: big figures spill into the neighbouring stat**
- Severity: Medium · Category: visual · Confidence: likely
- Where: `frontend/src/pages/Holdings/Holdings.scss:10-32` (columns `minmax(8.5rem, 1fr)`; phone: two columns), `:68-77` (`__stat-value` `nowrap`, lg 17 px, no overflow guard); content in `HoldingsKpis.tsx:44-66`
- What the user sees: a stat cell has about 124 px for its figure on a 360 px phone, and about 125-130 px on a 1280-1440 px desktop (seven columns). "US$1,234,567.89" or "+US$123,456.78" (Total value, Total return, Capital gain) at 17 px needs about 140 px, so it runs over the divider into the next stat. On desktop the strip can also scroll sideways with a thin bar, which is easy to miss.
- Fix direction: give the strip's figures the KPI tile's fit-to-width (or `compact` notation under a width), or drop to 5-6 columns on narrower desktops. S

**F-039 The holding detail sheet shows a frozen copy of the row**
- Severity: Low · Category: bug · Confidence: confirmed
- Where: `frontend/src/pages/Holdings/Holdings.tsx:150` (`useState<HoldingRowDto | null>`), `:223` and `:461` (`setSelected(r)` stores the row object), `:550`
- What the user sees: with the sheet open during market hours, value, day move, twin estimate and stamps stay at the moment it opened, while the list behind it ticks on. After a currency switch the sheet keeps the old currency's figures under the new currency code (`ccy` comes from props, the row from the old fetch).
- Fix direction: store `instrument_id` and look the row up in the current `query.data` on each render. S (v7.4 replaces the sheet with a route; do it then if close)

**F-040 Hide-numbers masks the price chart's axis, while the table shows prices unmasked**
- Severity: Low · Category: inconsistency · Confidence: confirmed
- Where: `frontend/src/pages/Holdings/Holdings.tsx:94` (`formatMoney(v, ccy)` without `unmasked`) vs `:267`, `HoldingMobileRow.tsx:70`, `HoldingParts.tsx:139` (`unmasked: true`, "public market data")
- What the user sees: with numbers hidden, the price chart's y-axis and tooltip read "US$•••.••" while the same price shows in clear in the row above. The cost-basis line still sits at the real average price. The axis also uses 2-decimal "US$" labels where every other chart uses `chartMoneyFormat` ("$", rounded).
- Fix direction: use an unmasked chart formatter for prices (and decide whether the cost-basis line should be masked). S

**F-041 The same figure has different names on different pages**
- Severity: Low · Category: inconsistency · Confidence: confirmed
- Where: `frontend/src/pages/Holdings/Holdings.tsx:288` "Fee", `HoldingParts.tsx:263` "Expense", `HoldingsKpis.tsx:89` "Weighted fee", `components/KpiGrid/KpiGrid.tsx:201` "Expense ratio"; "Day" (`Holdings.tsx:377`, `OverviewHoldings`) vs "Today" (sort option `Holdings.tsx:44`, `HoldingMobileRow`); "Growth" vs "Total growth" vs Overview "Since buying"; "Dividend return" vs "Yield (TTM)" vs "Dividend yield, 12 mo"
- What the user sees: four names for the TER and three names for the day move. Small, but it makes the owner wonder whether two numbers are the same thing.
- Fix direction: one glossary key per concept (`lib/glossary.ts` exists) and use its label everywhere. S

**F-042 Two functions called `formatPp` that take different units**
- Severity: Nit · Category: hygiene · Confidence: confirmed
- Where: `frontend/src/pages/Holdings/HoldingParts.tsx:74-80` (input already in pp, string) vs `frontend/src/lib/format.ts:356` (input a ratio)
- What the user sees: nothing yet. An import mix-up would show a 100× wrong "pp" figure (OverviewHoldings already does `formatPp(pp / 100)` to bridge the two).
- Fix direction: rename one (`formatPpValue`) or make the server send one unit. S

### Transactions page (+ TransactionForm)

**F-043 The transaction form rejects decimal commas even when the app shows them**
- Severity: Medium · Category: ux · Confidence: confirmed
- Where: `frontend/src/pages/Transactions/TransactionForm.tsx:31` (`/^\d+(\.\d+)?$/`), `:118-120`
- What the user sees: with Settings → Display set to "1.234,56" (or the de-DE preset), every figure in the app has a decimal comma. Typing "12,5" into Quantity or "1.234,56" into Total gives "Enter a non-negative decimal", and the qty × price reconcile silently does nothing. The same goes for every other number input that uses a dot-only regex (worth a grep in v7).
- Fix direction: normalise the input with the active number format before validating (accept both separators, strip group marks), and echo the parsed value. S

**F-044 New transactions default to the UTC date, not the user's**
- Severity: Low · Category: bug · Confidence: confirmed
- Where: `frontend/src/pages/Transactions/TransactionForm.tsx:54` (`new Date().toISOString().slice(0, 10)`)
- What the user sees: just after midnight in Europe (UTC+1/+2), "Add transaction" pre-fills yesterday's date. The rest of the page uses `todayIn(timeZone)`.
- Fix direction: use `todayIn(getFormatPrefs().timeZone)`. S

**F-045 A remembered "30d / 90d / 12m" range goes stale**
- Severity: Low · Category: bug · Confidence: confirmed
- Where: `frontend/src/pages/Transactions/Transactions.tsx:152` (filters incl. `start` persisted to localStorage), `:162` (dates computed only when the button is clicked)
- What the user sees: "30d" stays highlighted next week, but the list starts at the date it was clicked (37 days back, and growing). "This year" keeps last year's 1 January after New Year.
- Fix direction: persist only `range`, and derive `start`/`end` from it on every render unless it is "custom". S

**F-046 Month cards at a page break show the whole month's count and net over a partial list**
- Severity: Low · Category: ux · Confidence: confirmed
- Where: `frontend/src/pages/Transactions/Transactions.tsx:398-428` (groups from `pageRows`, totals from `view.months` over all filtered rows), `PAGE_SIZE = 50`
- What the user sees: the last card on a page says "23 transactions · net +€4,200" but lists 6 rows; the other 17 are on the next page under a second card with the same title and the same totals.
- Fix direction: page by whole months (or add "6 of 23 shown, continues on next page"). S

**F-047 Kind badges use the gain/loss colours for cash direction**
- Severity: Low · Category: ux / inconsistency · Confidence: confirmed
- Where: `frontend/src/pages/Transactions/Transactions.scss:134-150` (buy/deposit/dividend blue, sell/withdrawal/fee orange)
- What the user sees: every sale is painted in the "loss" orange and every purchase in the "gain" blue, so a profitable sell reads as a loss at a glance. Elsewhere in the app blue/orange always means gain/loss. The text label is there, so it is not colour-only, but the meaning clashes.
- Fix direction: use neutral or accent tones for kinds (or icons: ↓ in, ↑ out), and keep pos/neg for money signs. S

### Periods page (+ PhoneYears)

Data flow is clean: four hooks, but two `/both` requests (`["periods", kind, "both"]`
with a currency `select`), and the browser does no maths.

**F-048 Month names ignore the regional setting**
- Severity: Low · Category: inconsistency · Confidence: confirmed
- Where: `frontend/src/pages/Periods/Periods.tsx:39-47` and `PhoneYears.tsx:14-21` (`toLocaleDateString("en-GB", …)` hard-coded) vs `frontend/src/pages/Transactions/Transactions.tsx:123-127` (`getFormatPrefs().locale`)
- What the user sees: with de-DE chosen, Transactions headings read "Oktober 2026" while Periods reads "Oct 2026" / "October", and the GrowthBars ticks are English too.
- Fix direction: one `formatMonth(label, style)` in `lib/format.ts` that uses `LOCALE`. S

**F-049 Desktop year summary: the money stats can spill over their dividers at 1024-1280 px**
- Severity: Low · Category: visual · Confidence: likely
- Where: `frontend/src/pages/Periods/Periods.scss:69-72` (`minmax(12rem, 1.4fr) repeat(5, minmax(0, 1fr))`), `:175-182` (`nowrap`, no overflow guard)
- What the user sees: at 1024 px a stat column is about 80 px wide after its 16 px left padding. "€123,456.78" (net flow / contributions) at 15 px semibold needs about 85-90 px and runs into the next stat's divider. Wider screens are fine.
- Fix direction: drop the cents (`digits={0}`, as PhoneYears already does), or wrap to 3 + 3 below `wide`. S

**F-050 Dead phone styles for the year summary**
- Severity: Nit · Category: hygiene · Confidence: confirmed
- Where: `frontend/src/pages/Periods/Periods.scss:103-173` (phone rules for `.periods-page__summary` / `__stat--lead`) while phones render `PhoneYears` instead (`Periods.tsx:218-220`)
- What the user sees: nothing. About 70 lines of CSS that only apply in the short gap where `useIsPhone` and the media query disagree, which is a source of confusion when restyling.
- Fix direction: delete them. S

### Allocations page (Builder, DriftCard, PlanResult, SaveTargetDialog)

v7 overlap: plan §7 already lists "two different actual-versus-target bar widgets on
the same page" (AllocationBar vs NowTargetBar) and "the nav lies about the calculator"
(the Builder lives here, not on Projection).

**F-051 Tablets: the drift table is wider than its card**
- Severity: Medium · Category: visual · Confidence: likely (widths worked out from tokens)
- Where: `frontend/src/pages/Allocations/Allocations.scss:405-412` (`minmax(8rem,1.2fr) 8.5rem minmax(6rem,1.6fr) 5rem 7.5rem` + 4 × 16 px gaps ≈ 624 px minimum; the stacked phone layout only starts below 640 px)
- What the user sees: on a tablet (640-1023 px, rail sidebar) the card body is about 488-616 px wide, so the "To target" column (the money figure) pokes 10-130 px out of the card's right edge. Nothing scrolls, so it overlaps the page margin.
- Fix direction: use the stacked layout up to `desktop`, or make the fixed columns `minmax(0, …)` and let the bar give way. S

**F-052 The plan error's "Retry" button doesn't retry**
- Severity: Low · Category: bug · Confidence: confirmed
- Where: `frontend/src/pages/Allocations/Builder.tsx:521-526` (`onRetry={() => plan.reset()}`)
- What the user sees: after a failed "Compute plan", Retry only hides the error. The user has to find and press "Compute plan" again, and may think it was retried and came back empty.
- Fix direction: `onRetry={compute}` (or label it "Dismiss"). S

**F-053 Typed target percentages: a decimal comma silently becomes 0**
- Severity: Medium · Category: ux · Confidence: confirmed
- Where: `frontend/src/pages/Allocations/Builder.tsx:82` (`(Number(v) || 0) / 100`), `:57-66` (`inputMode="decimal"`, which brings up a comma keypad on de-DE phones); the same root cause as F-043
- What the user sees: typing "12,5" in a target box shows the group total and the bar as if 0 % were entered, and "will be scaled to 100 %" kicks in without saying why. The server receives "12,5" (the raw string) for the plan.
- Fix direction: a shared locale-aware decimal parser for every input. S

**F-054 Percent and minus formatting drifts inside the same view**
- Severity: Nit · Category: inconsistency · Confidence: confirmed
- Where: `frontend/src/pages/Allocations/Builder.tsx:348-349` ("now 12.5%" via `Percent` next to "target 12.5 %" via `formatNumber + " %"`), `:498`; `DriftCard.tsx:37` (U+2212 "−" for pp) vs `lib/format.ts:356` (`formatPp`, "-" from Intl); `SaveTargetDialog.tsx:199`; `PlanResult.tsx:31`
- What the user sees: "12.5%" and "12.5 %" side by side in one row; drift says "−1.2 pp" while the Overview says "-1.20 pp" (different glyph, different digits).
- Fix direction: route all of them through `formatPercent` and `formatPp(…, 1)`. S

**F-055 Undefined colour token on the "Use my cash" chip**
- Severity: Nit · Category: hygiene · Confidence: confirmed
- Where: `frontend/src/pages/Allocations/Allocations.scss:37` (`color: var(--color-text)`; no `--color-text` exists in `styles/tokens.scss`)
- What the user sees: nothing today (the invalid value falls back to the inherited colour). It is a typo that a token-lint would catch (see F-088).
- Fix direction: `var(--color-fg)`. S

### Risk and Projection pages

**F-056 Risk and Projection chart tooltips show rounded "€123K" instead of the value**
- Severity: Low · Category: ux · Confidence: confirmed
- Where: `frontend/src/pages/Risk/Risk.tsx:323-325` and `frontend/src/pages/Projection/Projection.tsx:330-332` (one `valueFormat` with `compact: true` for both the axis and the tooltip; no per-series `valueFormat` and no `chartMoneyFormat`)
- What the user sees: scrubbing the equity curve gives "Portfolio €123K · VT €119K · Net invested €98K". Those are axis-grade numbers in the one place meant for the exact figure. The Overview chart shows "€123,456" in its tooltip.
- Fix direction: pass `chartMoneyFormat(ccy, "axis")` for ticks and a per-series tooltip formatter (as `buildValueSeries` does). S

**F-057 Risk: the fixed 540 px chart leaves a gap beside the metrics card**
- Severity: Low · Category: visual · Confidence: likely
- Where: `frontend/src/pages/Risk/Risk.tsx:320-321` (`height={desktop ? 540 : 300}`), `Risk.scss:24-31` (`align-items: stretch`)
- What the user sees: the comment says "the curve fills the height of the metrics table beside it", but the height is a constant. The metrics card (about 18 rows, 4 group titles, the note) is taller than 540 px + chrome, so the equity-curve card has an empty band under the chart. That is the uneven desktop gap the owner dislikes, and it is worse when the attribution note under the chart is missing.
- Fix direction: measure the metrics card, as the Overview treemap does (`useTreemapHeight`), or let the chart flex to fill. S

**F-058 The Projection goal list prints raw server keys**
- Severity: Low · Category: ux · Confidence: confirmed
- Where: `frontend/src/pages/Projection/Projection.tsx:343-349` (`{name}:` from `Object.entries(out.hits)`)
- What the user sees: "pessimistic: Year 14 (14.0 yr)", "expected: …", "optimistic: …", lower-case and in whatever order the object keys come, under a chart whose legend says "Pessimistic / Expected / Optimistic".
- Fix direction: map keys to the legend labels in a fixed order. S

**F-059 Bare element selectors and a raw breakpoint in page styles**
- Severity: Nit · Category: hygiene · Confidence: confirmed
- Where: `frontend/src/pages/Risk/Risk.scss:137-146` (`dt`, `dd` inside `.risk-page__total`), `frontend/src/pages/Projection/Projection.scss:11` (`@media (min-width: 64rem)` instead of `m.desktop`)
- What the user sees: nothing. Both break the AGENTS.md style rule (BEM classes only, breakpoints from the mixins).
- Fix direction: add BEM classes, use the mixin. S

### Currency conversions page

v7.5a (plan §5.1) already covers conversions named "#12", ordering, the ECB-fallback
call to action and the fees analytics. Beyond that:

**F-060 Two KPI tiles in a four-column grid leave half the row empty on desktop**
- Severity: Low · Category: visual · Confidence: confirmed
- Where: `frontend/src/pages/CurrencyConversions/CurrencyConversions.scss:8-16` (`repeat(4, …)` on desktop), `CurrencyConversions.tsx:256-264` (2 tiles)
- What the user sees: "Pool balance" and "Batches" fill the left half of the row and the right half is blank, which is the uneven desktop gap again.
- Fix direction: `repeat(auto-fit, minmax(14rem, 1fr))`, or add the tiles 7.5b will bring (average rate, total fees) now. S

**F-061 The "ECB fallback" badge links to Health & Repair**
- Severity: Low · Category: ux · Confidence: confirmed · **v7 overlap:** 7.5a "Add the conversion" action
- Where: `frontend/src/pages/CurrencyConversions/CurrencyConversions.tsx:145-149`
- What the user sees: clicking "ECB fallback: $500" on a deposit opens the Diagnostics page, which has nothing about that deposit. The useful action, "add a conversion dated on or before this deposit", is a dialog on this same page.
- Fix direction: open `ConversionDialog` pre-filled with the deposit's date and USD gap (as 7.5a plans). S

**F-062 Dialog button styles and confirmation copy differ between pages**
- Severity: Nit · Category: inconsistency · Confidence: confirmed
- Where: `CurrencyConversions.tsx:105` (Save is the default *secondary* style) vs `Transactions/TransactionForm.tsx:242` (primary); delete confirmations: "Delete conversion" / "Delete" (`:303`, `:324`) vs "Delete transaction?" / "Confirm delete" (`Transactions.tsx:521-529`); `CurrencyConversions.scss:35` hard-codes `1px`
- What the user sees: the main action in a dialog is sometimes filled, sometimes outlined; destructive confirmations are worded three different ways (Diagnostics has a third pattern, see that section).
- Fix direction: one `ConfirmDialog` component (title "Delete X?", body, "Cancel" + danger "Delete"), primary for the main action in every form dialog. S

### Import page (+ ImportHistory, ColumnMapping, RowCheck, UnknownActions)

**F-063 Leaving the Import page mid-preview loses the preview and leaves it pending on the server**
- Severity: Medium · Category: bug / ux · Confidence: confirmed (client), likely (server keeps it)
- Where: `frontend/src/pages/Import/Import.tsx:88-89` (`preview`/`result` live only in component state), `:145-153` (discard only via the button); plus F-003 (hide-numbers remounts the page)
- What the user sees: uploading a file, resolving flagged rows and adjusting columns, then tapping another tab, reloading, or toggling "hide numbers", returns to an empty step 1. The resolved choices are gone, and the staged import is never discarded (`DELETE /api/imports/{id}` is not called).
- Fix direction: keep the active `import_id` in the URL (`/import?id=…`) or sessionStorage and reload the preview from the server; warn before navigating away with unresolved work. M

**F-064 Long file names overflow the drop zone and the preview title on phones**
- Severity: Low · Category: visual · Confidence: likely
- Where: `frontend/src/pages/Import/Import.scss:45-47` (`__drop-text`, no `overflow-wrap`), `Import.tsx:250` (card title `Preview - ${filename}`; `.card__title` has no wrap rule), `ImportHistory.tsx:149` (file as the phone row title)
- What the user sees: broker exports are often named like `Portfolio_Positions_Nov-09-2026_full.csv`. Underscores give no break points, so on a 360 px screen the name runs past the card edge in three places.
- Fix direction: `overflow-wrap: anywhere` (or a middle ellipsis) on file names; consider it on `.card__title` globally. S

**F-065 Count chips are always coloured, even at zero; the copy says "1 transactions"**
- Severity: Low · Category: ux · Confidence: confirmed
- Where: `frontend/src/pages/Import/Import.tsx:252-258` ("Warnings 0" in warn, "Errors 0" in the error style), `:161`, `:369`, `:378` (`Imported ${n} transactions`, `Import ${n} transactions`), `ImportHistory.tsx:52`
- What the user sees: a clean file still shows an amber "Warnings 0" and an orange "Errors 0" chip, which reads as alarming until you look closely. One-row imports say "Import 1 transactions". Copy uses ASCII " - " as a dash ("Preview - file.csv", "…account - the import only runs…") where the rest of the app uses "·" or "—".
- Fix direction: neutral chips at zero, pluralise, and use one dash style. S

**F-066 Import results list unresolved symbols and missing FX dates with nowhere to go**
- Severity: Low · Category: ux · Confidence: confirmed
- Where: `frontend/src/pages/Import/Import.tsx:385-396`
- What the user sees: "Unresolved symbols: ABC, DEF" and "FX missing on: …" are plain text. The fixes live on Instruments (map the symbol) and Health & Repair (backfill FX), but there are no links.
- Fix direction: link each list to the page/tab that fixes it (Instruments filtered to the symbol; Repair → FX backfill). S

**F-067 The drop zone flickers while dragging, and the progress bar is the unstyled native one**
- Severity: Nit · Category: visual · Confidence: likely
- Where: `frontend/src/pages/Import/Import.tsx:200-208` (`onDragLeave` fires when the pointer crosses the icon/button children), `:236` (native `<progress>`, no styles; the shell's refresh bar is a styled div)
- What the user sees: the highlighted state blinks on and off while a file is dragged across the zone; the upload bar is the browser's default colour, not the accent.
- Fix direction: count dragenter/dragleave (or check `relatedTarget`), and style the progress with tokens (`accent-color` at least). S

### Instruments page

**F-068 Search boxes that remember yesterday's search**
- Severity: Low · Category: ux · Confidence: confirmed
- Where: `frontend/src/pages/Instruments/Instruments.tsx:320` (`usePersistentState("instruments.q")`), `frontend/src/pages/Transactions/Transactions.tsx:152` (the `q` text is part of the persisted filters) vs `frontend/src/pages/Holdings/Holdings.tsx:147` (plain state)
- What the user sees: coming back days later, Instruments says "No instruments match." or Transactions shows "3 matching" because of a search typed last week. Nothing on the page explains why, apart from the text in the box. Holdings forgets its search, so the behaviour differs page to page.
- Fix direction: persist filters, not free-text search (or clear the search on a new session). S

**F-069 Native checkboxes sit next to the app's Switch component**
- Severity: Nit · Category: inconsistency · Confidence: confirmed
- Where: `frontend/src/pages/Instruments/Instruments.tsx:299-302`, `:426-429`; `frontend/src/pages/Transactions/Transactions.tsx:355-361`; `frontend/src/pages/Transactions/TransactionForm.tsx:226-229` vs `components/Switch` (Settings, Allocations, SaveTargetDialog)
- What the user sees: browser-default checkboxes (blue in Chrome, no dark-theme styling, 13 px target) on some pages and the app's switch on others, for the same kind of on/off choice.
- Fix direction: use `Switch` (or a styled `Checkbox` primitive) everywhere. S

### Settings page (+ SettingField, UnsavedBar, AccountsCard, PasskeysCard, HistorySheet, ImportDialog)

**F-070 Advanced settings are hidden by default, against the owner's "settings visible" rule**
- Severity: Medium · Category: ux · Confidence: confirmed
- Where: `frontend/src/pages/Settings/Settings.tsx:117` (`usePersistentState("settings.advanced", false)`), `:234-236`, `:256-260` ("Show N advanced setting(s)")
- What the user sees: tunable server knobs tagged `level: "advanced"` don't appear until the owner flips a small Hide/Show switch at the bottom of the nav (per device), and a search excludes them too. The owner's standing rule is that knobs go in the Settings window, grouped by topic, never hidden as advanced.
- Fix direction: show everything by default and keep the "Advanced" badge as a label (or drop the toggle). S

**F-071 Unsaved settings are dropped silently on in-app navigation**
- Severity: Medium · Category: bug / ux · Confidence: confirmed
- Where: `frontend/src/pages/Settings/Settings.tsx:157-162` (only `beforeunload`, which covers reloads and tab closes), `:123` (drafts in component state); also F-003
- What the user sees: editing three fields and then clicking "Holdings" in the sidebar (or a `g h` shortcut, or the eye toggle) throws the edits away with no prompt. Only closing or reloading the tab warns.
- Fix direction: block in-app navigation while `dirtyCount > 0` (react-router `useBlocker`) with "Save / Discard / Stay". S

**F-072 "Sign out" vs "Log out", and the second sign-out path skips the shell's cleanup**
- Severity: Nit · Category: inconsistency · Confidence: confirmed
- Where: `frontend/src/pages/Settings/Settings.tsx:49-66` ("Log out", its own `logout → invalidateAuth → navigate`) vs `frontend/src/components/TopBar/TopBar.tsx:115` and `AppShell.tsx:129-135` ("Sign out")
- What the user sees: two words for one action. The Settings path is also a separate copy of the sign-out logic that can drift (it already differs: it awaits `invalidateAuth`, the shell does not).
- Fix direction: one `useSignOut()` hook and one label. S

**F-073 Settings source badges borrow the gain colour; the dirty dot has no accessible role**
- Severity: Nit · Category: a11y / ux · Confidence: confirmed
- Where: `frontend/src/pages/Settings/Settings.scss:308-311` (`--env` uses `--color-pos-soft`), `Settings.tsx:351` and `:398` (`<span aria-label="unsaved changes">` with no role, so most screen readers skip it); `Settings.scss:398` (`z-index: 5`), `:266`, `:118`, `:405` (`1px`), `:331` (`520px`), `:21` (`220px`) are raw values, not tokens
- What the user sees: "Env" badges look like a gain chip. Screen-reader users get no hint which sections hold unsaved changes.
- Fix direction: a neutral or accent tone for sources; `role="img"` (or visually-hidden text) for the dot; tokens for the raw values. S

### Health & Repair (Diagnostics) and Activity pages

v7 §7 "Ship as patches" #5 already covers the hand-rolled tab bar on Diagnostics. Note
for that patch: the current `role="tablist"` has no arrow-key / roving-tabindex
handling (`Diagnostics.tsx:55-70`), so the ARIA tabs pattern is announced but not
honoured. The shared SegmentedControl (Radix ToggleGroup) fixes both.

**F-074 The Activity kind badge is always "gain blue", even for withdrawals**
- Severity: Low · Category: inconsistency · Confidence: confirmed
- Where: `frontend/src/pages/Activity/Activity.scss:47-59` (one style, `--color-pos-soft`/`--color-pos`, "matches the Transactions kind badge") vs `Transactions.scss:134-150` (withdrawal/transfer-out orange)
- What the user sees: a withdrawal is blue on Activity and orange on Transactions; the comment claiming they match is wrong. (See F-047: neither should really use the gain/loss pair.)
- Fix direction: one shared `KindBadge` component used on both pages. S

**F-075 Mixed-case status words in Diagnostics checks**
- Severity: Nit · Category: inconsistency · Confidence: confirmed
- Where: `frontend/src/pages/Diagnostics/HealthTab.tsx:103` ("OK" vs raw "warning"/"error" from the API)
- What the user sees: the status column reads "OK", "warning", "error".
- Fix direction: map severities to labels ("OK", "Warning", "Problem"), as the TopBar's health label already does. S

**F-076 Activity's KPI tiles put the other currency in `hint`; the Overview uses `secondary`**
- Severity: Nit · Category: inconsistency · Confidence: confirmed
- Where: `frontend/src/pages/Activity/Activity.tsx:169-171`, `:290-291` vs `components/KpiGrid/KpiGrid.tsx:130-137`
- What the user sees: on Activity the USD line sits lower and smaller, in the hint style; on the Overview it sits right under the figure. The same "other currency" idea gets two layouts.
- Fix direction: pass it as `secondary`. S

### Help, Login, Onboarding, NotFound, Styleguide

v7 overlap: plan §7 "Ship as patches" #1 (the 404 page says "Coming soon",
`NotFound.tsx:12-13`) and #2 (Onboarding is unreachable; it also imports `PasskeysCard`
from the Settings page) are already planned.

**F-077 Help and Settings contradict each other on which value wins (env or app)**
- Severity: Low · Category: ux · Confidence: confirmed
- Where: `frontend/src/pages/Help/Help.tsx:76-79` ("env (… read-only here) … An env value wins over the app until it is removed on the server") vs `frontend/src/pages/Settings/SettingField.tsx:147-151` ("Set in the app (wins over the server env file)") and `:338-340` ("Overrides the server env value")
- What the user sees: Help says the opposite of what Settings shows and does. A non-sysadmin owner reading Help will think an app change is ignored.
- Fix direction: rewrite the Help paragraph to match the real precedence (app > env > default, with env bounds as limits). S

**F-078 Two different guided tours, both exported as `TOUR_STEPS`**
- Severity: Low · Category: inconsistency · Confidence: confirmed
- Where: `frontend/src/pages/Help/Help.tsx:11-42` (six demo-era steps: "designed mobile-first, like a modern neobroker", "Flip the currency toggle…") vs `frontend/src/components/Tour/steps.ts:9-43` (the tour that actually runs)
- What the user sees: Help's "Tour" card lists steps the replayed tour never shows, in marketing copy carried over from the v5 demo.
- Fix direction: render the Help card from `components/Tour/steps.ts` and drop the copy. S

**F-079 The login tile uses accent colours, not the brand gradient**
- Severity: Nit · Category: visual · Confidence: confirmed
- Where: `frontend/src/pages/Login/Login.scss:29-44` (`linear-gradient(135deg, var(--color-accent), var(--color-accent-2))`, `56px`, bare `svg` selector) vs `components/BrandMark` (`--color-brand-start/end`, the same in both themes)
- What the user sees: in dark theme the login logo is lilac→cyan while the sidebar mark and the favicon are indigo→teal, so the first screen's logo differs from the app's.
- Fix direction: render `<BrandMark size={56} />` with its own tile. S

**F-080 The styleguide route ships to production**
- Severity: Nit · Category: hygiene · Confidence: confirmed
- Where: `frontend/src/App.tsx:63` (`/_styleguide` inside the signed-in routes), `pages/Styleguide/*`
- What the user sees: nothing, unless they type the URL. It adds a lazy chunk and a maintenance surface (demo data, every component variant) that has to keep compiling.
- Fix direction: gate it behind `import.meta.env.DEV`. S

### `lib/` (api, live, tickPatch, queries, invalidation, prefs, refresh, hooks)

The plumbing is strong: one `/both` entry per report with a currency `select`,
ETag/304 reuse for `/both` (`api.ts:84-101`), a central invalidation table, staggered
tick refetches, restart ride-out, and rollback on every optimistic write. The
findings are about the places where it lets the numbers drift.

**F-081 Each live tick replaces the server's FX-aware per-holding day % with a browser-computed USD price %**
- Severity: High · Category: interplay / bug · Confidence: confirmed
- Where: `frontend/src/lib/tickPatch.ts:152-167` (`patchRow`: `today_pct = px / prev − 1` and `today_move = shares × (px − prev) × fx_now`, written into **both** the EUR and USD sides), against the server's definition in `backend/src/investment_dashboard/readmodels/queries/overview_query.py:1076-1145` (`_instrument_daily_growth`: each leg converted at its own session's rate)
- What the user sees: in EUR view, a USD holding's "Day" % and money move on Holdings and the Overview holdings list jump on every tick to the dollar price change (no FX leg). 0-5 s later the staggered refetch puts back the server's FX-inclusive EUR figure, until the next tick. On a day when EUR/USD moved, the numbers visibly flip between two values all session, and for a few seconds they disagree with the Movers card and the hero. It also breaks two AGENTS.md rules: "the client never computes a return", and "never compute a return in one currency and convert the result into another".
- Fix direction: have the tick carry the per-holding `today_pct`/`today_move` per currency (computed server-side, as for the totals), or patch only price and value (`shares × px × fx_now` is allowed) and leave day figures to the refetch. S-M (server tick payload + client patch)

**F-082 Writes that leave other pages stale: account renames and imports**
- Severity: Medium · Category: interplay / bug · Confidence: confirmed (invalidation lists), likely (visible effect)
- Where: `frontend/src/lib/queries/accounts.ts:50` and `:63` (save/delete account invalidate only `["accounts"]`); `frontend/src/lib/queries/invalidation.ts:26` (`importWrite` comments "also new instruments, accounts" but has no `"accounts"` root); `useImportSettings` (`queries/settings.ts:124`) invalidates only `["settings"]`
- What the user sees: renaming an account in Settings leaves the old name in Holdings (group by account, the detail sheet), the Transactions ledger rows and filters, and Activity, until each query goes stale and refetches. An import that creates a new account doesn't show it in the Transactions/Activity account filters until a reload. A settings import that changes report inputs only refreshes reports if the SSE `settings` event arrives (a dropped stream means stale reports).
- Fix direction: add an `accountWrite` kind (accounts + holdings + transactions + deposits + allocations), add "accounts" to `importWrite`, and run `settingsAffectReports` on the import result as `useSettingsWrite` does. S

**F-083 The whole query cache is stringified to localStorage after every tick**
- Severity: Medium · Category: inefficiency · Confidence: likely
- Where: `frontend/src/lib/queries.ts:51-54` and `:87-94` (`createSyncStoragePersister` with default throttling; every successful query is dehydrated, including `["transactions","all"]`, eight graph ranges × both currencies with minute-level 1W points, holdings, analytics…), combined with `lib/live.ts:218-223` (each tick does several `setQueryData` calls plus a refetch)
- What the user sees: on a phone during market hours, every tick (and every refetch it triggers) re-serialises several MB of JSON on the main thread about once a second, which competes with scrolling and the chart scrub. When the cache grows past the about 5 MB localStorage quota, `setItem` throws and persistence silently stops, so the "instant/offline open" feature quietly degrades exactly for the owner with the longest history.
- Fix direction: persist only the first-paint keys (overview/both, holdings/both, the remembered graph range), raise the throttle, or move to an async IndexedDB persister. M

**F-084 A failed top-bar refresh just stops spinning**
- Severity: Low · Category: ux · Confidence: confirmed
- Where: `frontend/src/lib/refresh.ts:149-154` (non-409 error, so `running: false` with no message)
- What the user sees: tapping refresh while the server returns 500, or the 30 s POST timeout fires, ends with the icon simply stopping. No toast, and the prices are not updated. (The offline case does get a toast, from AppShell.)
- Fix direction: toast "Couldn't start a refresh" with the error, as `RefreshCard` already does on Health & Repair. S

**F-085 Holding rows reshuffle on ticks**
- Severity: Low · Category: visual · Confidence: likely
- Where: `frontend/src/components/OverviewHoldings/OverviewHoldings.tsx:61-68` (`byValue` sort on every render), `pages/Holdings/Holdings.tsx:185-191` (phone sort by value/today), with values patched each tick (F-081)
- What the user sees: two holdings of similar size (or a "Today" sort on the phone) swap places as ticks arrive. Rows jump under the finger, and the top-8 cut on the Overview can flip one holding in or out of view.
- Fix direction: sort on a value snapshot that only changes on a refetch (or apply hysteresis), and animate reorders if they stay. S

**F-086 The "/" search shortcut only works on some pages; leftover legacy guidance in `queries.ts`**
- Severity: Nit · Category: inconsistency / hygiene · Confidence: confirmed
- Where: `frontend/src/lib/useShortcuts.ts:34-39` (`[data-search]`) is set on Holdings and Transactions only; Instruments (`Instruments.tsx:419`) and Settings (`Settings.tsx:328`) searches lack it. `frontend/src/lib/queries.ts:96-108` still documents the old per-currency key pattern with `TODO(later workers)`, which contradicts the `/both` design. `toNum` is implemented three times (`queries/portfolio.ts:19`, `queries/reports.ts:19`, `pages/Transactions/numbers.ts:4` as `num`), plus `num` in `PlanResult.tsx:9` and `n` in `ledgerAll.ts:52`.
- What the user sees: "/" does nothing on Instruments or Settings, the two pages where searching is the main action.
- Fix direction: add `data-search`, delete the stale comment, and keep one `toNum`. S

### `styles/` (tokens, mixins, base, reset) and token use across the tree

A scripted sweep of every `.scss`/`.tsx` file found **no hard-coded hex colours**
outside `tokens.scss`, and every `var(--…)` resolves except one (F-055). The CVD
pair test covers the gain/loss, warn and series pairs well.

**F-087 `--color-faint` is used for small text but is below 4.5:1 in places**
- Severity: Low · Category: a11y · Confidence: confirmed (computed contrast)
- Where: `frontend/src/styles/tokens.scss:16` (dark `#6f7c91`) and `:55` (light `#6b7588`). Used as **text** at 11-12 px in `TopBar.scss:48` (updated stamp), `Sidebar.scss:83` (group titles), `Holdings.scss:379` and `:530` (chip/group keys), `Freshness.scss:90` (stamp keys), `OverviewHoldings.scss:309` (twin age), `Risk.scss:121`, `Settings.scss:380`, `DataTable.scss:82` (group headings). `tokens.cvd.test.ts:57` checks pos/neg/warn text contrast, but not faint.
- What the user sees: WCAG contrast is 4.16:1 on dark surface, **3.67:1** on dark `surface-2` (the Holdings chips, the top-bar pill), and 4.10:1 on light `surface-2`. Those tiny grey labels are the hardest text in the app to read, especially on a phone in daylight.
- Fix direction: nudge faint a step lighter in dark and darker in light (or use muted for text and faint only for strokes), and add `--color-faint` to the text-contrast list in `tokens.cvd.test.ts`. S

**F-088 Raw px values and fallback hacks in component styles**
- Severity: Nit · Category: hygiene · Confidence: confirmed
- Where: borders written as `1px` instead of `--border-width` (`Settings.scss`, `Diagnostics.scss`, `Import.scss`, `ColumnMapping.scss`, `CurrencyConversions.scss`); layout widths `220px`, `520px` (Settings, Diagnostics), `56px` (Login), `200px`/`240px` flex bases (Diagnostics); `z-index: 5` (`Settings.scss:398`) and `z-index: 1` (Chart tooltip, DataTable head, Holdings sticky column) outside the `--z-*` scale; pointless fallbacks for tokens that always exist (`OfflineBanner.scss:13,17`, `Holdings.scss:565-568`, `Settings.scss:515`); `PhoneYears.scss:57` `0.15s ease` instead of the motion tokens
- What the user sees: nothing directly, but these are exactly the places that drift from the design system (for example the unsaved bar can slide under a z-index 20 sidebar or the chart tooltip).
- Fix direction: a stylelint rule (`declaration-property-value-disallowed-list` for px on border/z-index, `custom-property-pattern` plus a "known tokens" plugin) in the quality gate. S

### Tooling run (read-only)

- `npm run typecheck`: clean.
- `npm run lint` (oxlint): 1 warning, `public/theme-init.js:6` unused catch parameter.
- `npm run test` (vitest): 68 files, 482 tests, all pass in about 31 s. Several "not wrapped in act(...)" warnings are printed (test hygiene only).
- `vite build` (into the git-ignored `dist/`): main chunk `index-*.js` **447 KB / 140 KB gzip**, a shared chunk Rollup named `ErrorState-*.js` **102 KB / 34 KB gzip** that every lazy page pulls in, CSS 74 KB / 12 KB gzip. Pages are lazy-loaded with an idle preload (`lib/routeChunks.ts`), which is good.

**F-089 First-load bundle: Login and its WebAuthn library ride in the main chunk**
- Severity: Low · Category: inefficiency · Confidence: suspected (composition not inspected with a visualiser)
- Where: `frontend/src/App.tsx:9-10` (`Login`, `RequireAuth` and `Overview` imported eagerly; `Login` pulls `@simplewebauthn/browser`), `frontend/package.json` (`radix-ui` umbrella, `lucide-react`)
- What the user sees: a 140 KB gzip parse on every cold open of a phone PWA, plus about 34 KB more before any lazy page can render.
- Fix direction: lazy-load `Login`, and run `rollup-plugin-visualizer` once to see what the 102 KB shared chunk is (most likely Radix Select/Dialog plus the icon set) before deciding more. S

## Summary

### Counts

| Severity | Count |
| --- | --- |
| Critical | 0 |
| High | 3 (F-001, F-002, F-081) |
| Medium | 16 |
| Low | 48 |
| Nit | 22 |
| **Total** | **89** |

No finding shows a *persistently* wrong money number. The closest is F-081: a
browser-computed day % flashes on screen between each tick and the following refetch.

What is already good, so it is not churned in v7: typing against
`api-types.ts` is tight (only two `as unknown as` casts in non-test code, neither on
money), every report uses the `/both` + ETag path, invalidation is centralised,
optimistic writes roll back, formatters are shared, there are no hard-coded colours,
gain/loss is blue/orange everywhere, and the test suite is green.

### Every text-clipping / overflow finding

| ID | Where | Width / condition |
| --- | --- | --- |
| F-001 | Top bar title runs over the portfolio pill; freshness chip squeezed to a dot | desktop 1024-1280, tablet |
| F-002 | Phone top bar: day % cut mid-glyph, no ellipsis | 360-390 px, worse with the health badge |
| F-027 | Overview holdings: status pills ("stale value", "bad history") hard-clipped | tablet + desktop |
| F-028 | Hero value overflows the hero card (seven figures, USD / de-DE) | 360 px |
| F-019 | Graph range picker (8 buttons) sticks out of the card | 360-375 px |
| F-038 | Holdings summary strip figures spill into the next stat | phone and 1280-1440 desktop |
| F-051 | Allocations drift table wider than its card | tablet 640-1023 |
| F-016 | KPI tile secondary hard-clipped; values below the fit floor spill | phone 2-column grid |
| F-022 | Phone chart scrub readout clipped with 3+ series | phone |
| F-024 | Treemap tooltip clipped by the treemap box at the edges | all |
| F-037 | Phone DataTable chips hard-clipped (no ellipsis) | phone |
| F-049 | Periods year-summary money stats over their dividers | 1024-1280 |
| F-064 | Long file names overflow (drop zone, preview title, history) | phone |
| F-012 | Buttons never wrap; long labels push past the card | phone (likely) |

Pattern behind most of them: `white-space: nowrap` + `flex-shrink: 0` (or fixed grid
columns) with no `min-width: 0` / `overflow` / `text-overflow` on the element that
should give way, and `text-overflow: ellipsis` placed on flex containers, where it has
no effect. A one-off sweep for `overflow: hidden` without `text-overflow` on non-block
elements would catch the rest.

### Top 10 to fix first

1. **F-081**: stop the tick patch from writing a browser-computed (FX-free) day % / move into the EUR side; it flickers all session and breaks the currency rule.
2. **F-002**: phone top-bar figures clipped mid-glyph (seen on every page).
3. **F-001**: desktop/tablet top-bar title overlapping the portfolio pill.
4. **F-027**: Overview holdings warning pills cut off (the Holdings card is the key element).
5. **F-028**: hero figure overflowing at 360 px.
6. **F-019**: range picker overflowing the Graph card at 360-375 px.
7. **F-038**: Holdings summary strip figures spilling.
8. **F-043 + F-053**: decimal-comma input silently rejected or zeroed (transaction form, target %, conversions); one shared parser.
9. **F-003 + F-071 + F-063**: work lost on navigation or the hide toggle (Settings drafts, import preview, every page's local state).
10. **F-082**: stale account names and filters after a rename or import (add the missing invalidation kinds).

Next in line: F-029 (client-computed category day %), F-051 (drift table at tablet
width), F-070 (advanced settings hidden by default, against the owner rule),
F-004 (live stream not reopened after sign-in), F-083 (cache persistence on every tick).

### Overlap with v7 (not re-reported, only noted)

v7 §7 already plans: 404 "Coming soon", unreachable Onboarding, the nav calling
Projection the calculator, empty states without a button (F-032 adds a wrong page
name), Diagnostics' hand-rolled tabs (adds: no arrow-key handling), the three
holding-row implementations, HeroIntraday having no tooltip, the two target-bar
widgets, shared components in page folders, and Holdings density / the deep-dive
route (F-039 is moot once the deep dive is a route). v7.5a covers conversion naming,
ordering and the ECB-fallback action (F-061).

### What I could NOT cover

- **No rendering.** There is no mock or demo mode; every route needs a sign-in to a local backend, which the brief rules out. All visual findings come from the code, and widths were worked out from the tokens. Light/dark checks are limited to computed contrast (F-087) and token use; nothing was looked at in a browser, at any width.
- Read only partially (layout and grep, not line by line): Diagnostics sub-tabs (`MarketDataTab`, `RepairTab`, `SchedulerTab`, `LogsTab`, `SystemTab`, `TiingoCard`, `TwinsCard`, `JobParamsForm`, `RunJob`); Import's `ColumnMapping`, `RowCheck`, `UnknownActions`; Settings' `AccountsCard`, `PasskeysCard`, `HistorySheet`, `ImportDialog`, `UnsavedBar`; `Styleguide`; `lib/displayPrefs.tsx`, `usePullToRefresh.ts`, `appVersion.ts`, `passkeyHint.ts`, `cvd.ts`, `routeChunks.ts`, and the `queries/` files for maintenance, instruments, allocations, activity and manage.
- Front/back comparison was done for the endpoints behind the findings (stream, holdings day growth, the `/both` reads, invalidation targets), not for every router in `backend/src/investment_dashboard/api/`.
- Not run: Playwright e2e, Lighthouse/axe, a bundle visualiser (F-089 is therefore "suspected").

