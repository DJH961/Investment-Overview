# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Versioning policy

- **0.x** — pre-UI scaffolding milestones. The app does **not** yet present a
  usable web UI.
- **1.0.0** — first release with a runnable UI: end-to-end flow from CSV
  import / manual entry through `/overview` with real XIRR/TWR numbers.
- Subsequent **minor** bumps add features; **patch** bumps are bugfixes only.

## [Unreleased]

## [3.9.6] — 2026-06-23

### Fixed

- **Shutdown now gives instant feedback and reliably ends the session.**
  Confirming "Shut down" used to run the live-web upload synchronously before
  any UI update reached the browser, so the click appeared to do nothing while
  the app kept loading in the background. The confirm now paints a full-screen
  "Shutting down…" overlay immediately, then defers the upload (and the server
  stop) so the overlay actually appears first; the overlay stays up until the
  upload result is reported. When the server stops, the overlay swaps to a final
  "App shut down — you can close this tab" frame that never triggers the
  reconnect machinery and offers a manual close button if the browser refuses to
  auto-close the tab.

## [3.9.5] — 2026-06-23

### Changed

- **Value / equity / drawdown graphs are now currency-correct (USD-native).**
  USD is the booked currency — spot prices arrive in USD — so the USD curve is
  now computed natively with **no FX applied**, and EUR is the FX-derived view
  (not the other way around). Analytics exports a true per-day USD value series
  (`portfolio_value_usd`, built from the desktop USD snapshot bundle) instead of
  rescaling the EUR curve by today's spot, so each currency's history reflects
  the actual rate on every day rather than a single uniform conversion. The web
  companion renders each chart natively in the active currency; the live "today"
  tip uses the live intraday EUR/USD spot, so the USD and EUR graphs legitimately
  differ point-by-point as the FX market moves.
- **End-of-day FX history is sourced from the ECB (Frankfurter), intraday from
  yfinance.** Historical end-of-day EUR/USD marks come from the ECB reference
  rates; an earlier yfinance `EURUSD=X` end-of-day overlay has been reverted (and
  any rows it left behind are purged on boot so the ECB backfill owns those
  dates). yfinance is now used only for the *live and intraday* rates that feed
  the "1 Day" curve. Every figure is still converted at its own point in time —
  each day at that day's ECB rate, never today's.
- **Overview "1 Day" graph uses true per-minute EUR/USD FX.** When the curve is
  reconstructed (now every 15 minutes, down from 30), each back-filled point is
  converted at the EUR/USD rate actually struck at that minute — pulled from
  yfinance's `EURUSD=X` intraday bars — and live samples record the rate they
  were captured at (new nullable cache-tier `fx_eur_usd` column on
  `intraday_value`, added in place). USD stays the booked currency (FX-free); the
  EUR view diverges from it minute-by-minute as the FX market moves, instead of a
  single uniform conversion. Missing bars fall back to the day's settled rate.

### Fixed

- **Overview "1 Day" graph no longer spikes or steps from mutual-fund NAVs.**
  The intraday curve now stores only the *intraday-priced* (market) component of
  the portfolio — stocks/ETFs — and reapplies the constant cash + NAV base
  (mutual funds, money-market funds, cash) at render time. Because once-a-day-NAV
  holdings never enter the intraday variation, a mutual fund's post-close NAV
  revaluation shifts the whole curve uniformly instead of spiking the points
  captured live before it, and a session watched live for only part of the day
  joins its reconstructed remainder on a single consistent basis (no misleading
  step where the two meet). Cache-tier `intraday_value` gains a renamed
  `market_value_eur` column (migration `0014`); the table is regenerable, so it
  is recreated rather than back-filled.

## [3.9.4] — 2026-06-23

### Fixed

- **Header "Quit" performs a clean shutdown.** The desktop header quit action
  now goes through a dedicated shutdown flow so the app exits cleanly instead
  of leaving the process in an inconsistent state.
- **Refresh-chip tooltip is scoped to the chip.** The refresh indicator's
  tooltip is now attached to the chip itself rather than bleeding onto
  surrounding layout elements.

## [3.9.3] — 2026-06-23

### Added

- **Settings → "Update all data now".** A maintenance button in the web
  companion's settings that clears all cached prices/FX and re-polls every
  holding from scratch, for the rare case the incremental refresh logic gets
  into a bad state.

### Fixed

- **Late-arriving NAV prices are attributed to the correct US trading day.**
  Mutual-fund / money-market NAVs often publish around (EU) midnight. The
  "expected NAV date" is now anchored to the latest *settled US session*
  (`latestSettledSessionDate`) rather than the viewer's local (EU) calendar
  date, so a NAV arriving at 02:00 CET is back-dated to the right US date and
  the local date roll-over no longer triggers spurious polling or
  mis-attribution.
- **Daily live-data credit budget resets at 00:00 UTC.** The free-tier daily
  allowance is now counted per UTC calendar day (`creditsSpentToday`) to match
  Twelve Data's reset, instead of a rolling trailing-24h window that could
  appear inflated in the morning.

## [3.9.2] — 2026-06-23

### Fixed

- **"Live" now only shows when prices are genuinely live (web + desktop).** The
  live badge/caption is suppressed unless the market is truly open *and* fresh
  data was actually accessed:
  - The Python market clock (`domain.market_hours`) is now **holiday-aware**
    (full NYSE calendar incl. Good Friday, Juneteenth and the observed-day
    rule), matching the web companion — so a randomly-closed (holiday) session
    never reads "live".
  - A shared **live-recency window** (`feed_is_fresh`, 15 min) now gates the
    desktop per-row "As Of" badge and the Daily Growth caption (not just the
    header chip), so a stalled or unreachable feed honestly settles to
    "today"/"as of …" instead of claiming "live".
  - The web headline "Live" badge gains a freshness ceiling (a stale cache no
    longer reads live) and honours Twelve Data's own `is_market_open=false`
    ground truth (catching unscheduled or early-close sessions the modelled
    clock would miss).

## [3.9.1] — 2026-06-22

### Changed

- **"Today's movers" now sits below the value graph on the web too.** It used to
  render above the chart; it now follows the chart and the stats block whose
  notes explain how fresh the data is ("data last pulled…", live coverage,
  budget), matching the desktop, which already places the band directly under
  the value graph. On both apps the leaderboard now reads right after the graph
  (and, on web, the update text) that frame it, and still above the Holdings
  list.

## [3.9.0] — 2026-06-22

### Changed

- **"Today's movers" redesigned (web + desktop).** The winners/losers board is
  now a distinct, attention-grabbing "special notice" band that lays its movers
  out as up to four blocks across on wider screens. Each block leads with the
  stat it was ranked on (the money move for "biggest move", the percentage for
  "top %") shown large on top, with the secondary figure below. On the web the
  band sits just above the Holdings list; on the desktop it moved to directly
  under the value graph.
- Each holding that tops today's movers leaderboard now carries a small badge
  ("Top gainer" / "Top % gainer" / "Top loser" / "Top % loser") in the holdings
  list, so the winners/losers are recognisable in context too.

### Fixed

- **Today's movers now rank in the active display currency.** The biggest-%
  pick is genuinely FX-variant (EUR and USD daily percentages differ as the
  day's FX drifts), so ranking always in EUR could disagree with the figures on
  screen — and the desktop and web apps could name different movers. Both apps
  now rank in the chosen currency, so the EUR/USD views and the two apps agree.

## [3.8.1] — 2026-06-22

### Fixed

- Desktop daily-growth FX caption now matches the web app's rolled-back FX
  display: USD view shows EUR/USD (`€1≈$…`) and EUR view shows USD/EUR
  (`$1≈€…`). The foreign-currency strength percentage convention is unchanged.

## [3.8.0] — 2026-06-22

### Added

- **"Today's movers" overview (web + desktop).** A new dedicated section near the
  top of the Overview gives an at-a-glance read of the day's winners and losers
  without scrolling. Each side shows up to two names: the **biggest money move**
  and the **biggest percentage move** — and when one holding tops both, the
  second slot becomes the **percentage runner-up** so two distinct names always
  show. The board is measured on the freshest price date across the book, so
  before the market opens it reflects the last completed session, and during the
  session only holdings that have already printed today.

### Changed

- **Today's growth is greyed out for holdings that haven't updated yet.** When
  some holdings have repriced more recently than others (e.g. ETFs printing
  intraday while a mutual fund is still on yesterday's NAV), the lagging
  holdings' daily-move figure is greyed with a "not updated today" hint, so a
  glance cleanly separates today's numbers from the ones still to refresh.
  Before the market opens every holding shares the same close, so nothing is
  greyed. Applies to both the web companion and the desktop app.

## [3.7.2] — 2026-06-22

### Fixed

- **Web Calculator no longer overflows its boxes.** Long fund names, category
  labels, large currency amounts, share counts and the live-total hint now wrap
  or shrink within their cards instead of spilling out, across the builder rows,
  per-category fund pickers, summary stats and the generated buy/rebalance plan
  (mobile-first). Achieved with `min-width: 0` / `overflow-wrap` and flexible
  flex-basis on the affected rows.
- **Calculator categories read like the main app.** A holding the user filed
  under an explicit category in the desktop app keeps that category on the web
  (it already rides along in the encrypted export blob); holdings with no
  explicit category now fall back to a friendly, humanised asset-class label
  ("Bonds", "Money market", "ETFs") instead of a raw lowercase slug.

### Changed

- **The web companion version is now shown on the site** (a small `vX.Y.Z` chip
  next to the brand) and is kept in lock-step with the main app's version — both
  are bumped together and a test fails if they ever drift.

## [3.7.1] — 2026-06-22

### Fixed

- **Today's growth is no longer inflated.** The overview "today's move" is now
  valued on a single global price step (holdings off the latest print date are
  forward-filled so they contribute FX-only) instead of summing each holding's
  own previous-close window, which a lagged NAV session could inflate in both
  EUR and USD.
- **FX % now tracks foreign-currency strength** so its sign correctly reflects
  whether EUR/USD rose, with live FX pulled first and the display-relative FX
  conversion flipped (web + desktop).

## [3.7.0] — 2026-06-22

### Changed

- **Web Calculator tab is now an allocation/invest planner** (a port of the
  desktop app's calculator), replacing the previous forward-projection
  simulator. You set a **target mix** — by category (e.g. "20% International")
  or by individual fund — and a cash contribution, and it returns a concrete
  buy-only plan (or, with rebalancing enabled, a buy/sell plan) showing **how
  much to invest** in each fund. It supports per-category value/equal splits,
  fractional or whole shares, "match current mix" / "equal
  weight" presets, and a one-tap **"Load saved target…"** picker that reads the
  target allocations stored in the encrypted export blob. The forward
  projection it replaced still lives **under the Periods tab** (Projection),
  unchanged.
- **Web Calculator now matches the desktop's selected-only category split.**
  A category's % is divided across only the funds you tick — the funds you do
  invest in absorb the whole category target between them, while an un-ticked
  fund keeps its current holding (left to dilute over time) instead of being
  handed a target it never tops up. A category with a positive target but no
  ticked funds is now rejected with a clear prompt.
- **Web Calculator remembers its "allow fractional shares" and "rebalance"
  toggles across reloads** (parity with the desktop's persisted `calc.*`
  settings), and **auto-loads the active saved target on open** so your
  last-saved mix is ready without a manual "Load" click.
- The mobile-export holdings payload now includes a nullable `category` field so
  the web calculator can group holdings into the same category buckets the
  desktop uses (falling back to `asset_class`, then "Uncategorized").

## [3.6.8] — 2026-06-22

Desktop holdings and calculator polish from user feedback (T2, T4).

### Changed

- **Holdings table shows every row, no vertical scrolling.** The AG-Grid
  positions table now uses `domLayout: autoHeight`, growing to fit all holdings
  in full instead of being capped at a fixed-height viewport.
- **Calculator: "Load saved target" button restored with auto-apply.** The saved
  target still auto-loads on open, and a "Load saved target" button re-applies it
  on demand. The redundant "Clear saved target" button is removed since the
  existing "Clear" button already resets the inputs.

## [3.6.7] — 2026-06-22

Live web companion: a cleaner, currency-correct overview hero, a manual
"refresh now" that actually pulls fresh prices, an honest "up to date" signal,
a configurable auto-refresh cadence, and a NAV cache that stops chasing prices
that cannot change.

### Added

- **Manual Refresh forces a fresh market pull.** Tapping Refresh now re-fetches
  market (non-NAV) symbols even when their cached quote is still inside its
  freshness window — the "pull new prices now" path. NAV holdings (mutual
  funds / money-market) are deliberately exempt, since their once-a-day NAV
  cannot have changed, so a tap never wastes credits chasing it. A credit
  reserve guards the free tier: below 10% of the day's budget a tap falls back
  to the normal cache-respecting refresh (with a toast) rather than spending the
  last of the budget at once. A descriptive summary toast reports the outcome
  (e.g. how many holdings were freshly pulled).
- **Configurable auto-refresh cadence.** Settings gains an "Auto-refresh
  (minutes)" field (default 5, max 120) controlling the steady-state gap between
  automatic live refreshes once everything is fresh. An off-cycle manual tap
  also pushes the next automatic refresh out by this interval.

### Changed

- **EUR display shows the FX rate inverted instead of hiding it.** The overview
  hero previously dropped all FX context in EUR display. It now shows the same
  line as USD display, just from the euro holder's side: the reciprocal
  `USD/EUR` quote with the today-deviation percentage flipped (USD display still
  shows `EUR/USD`). The freshness line's FX rate is quoted from the same side so
  the two never disagree. The intraday FX profit/loss money line stays out of
  the hero — that slice lives only in the Risk tab's Currency panel.
- **"Today" growth is currency-correct.** The hero's daily move, the "Today"
  return segment, and each holding's daily change now follow the display
  currency (EUR vs USD) instead of rescaling one from the other, so the figure
  changes honestly with the currency toggle — matching the desktop's
  per-currency daily growth.
- **Cleaner value-basis chip on the hero.** The old "as of …" caption is
  replaced by a compact top-right chip that reads "Live" while the NYSE session
  is open and we hold a same-day quote, "Today" when the freshest price is from
  today, or the date it is from otherwise — so a settled close, weekend, or
  holiday value reads honestly as the day it applies to.
- **"Up to date" is only claimed when data was actually just pulled.** The
  live-coverage summary now asserts holdings are up to date only when a network
  pull landed within the last 60 seconds; a refresh served entirely from cache
  no longer dresses old prices up as current.
- **NAV freshness window widened to 24 hours (was 12).** Outside the evening
  publish window a fund's NAV is never re-fetched until its cached value is more
  than a day old — there is no new price to chase in between, so the longer
  window saves free-tier credits without hiding any update.

## [3.6.6] — 2026-06-22

The Periods tab is reorganised into a two-column layout that keeps the year
groups and the contributions + projection stack visually distinct.

### Changed

- **Periods tab restructured into a two-column layout.** The left column holds
  the per-year groups while the right column stacks the recent contributions and
  an independent projection. On mobile each column collapses to a single
  vertical stack so the tab stays phone-first.

## [3.6.5] — 2026-06-22

### Fixed

- **Patch release.** Routine bug-fix version bump; no functional changes to
  existing behavior.

## [3.6.4] — 2026-06-22

Keep the new "1 Day" close-aware chart strictly colourblind-safe.

### Fixed

- **"1 Day" chart honours the red-green colourblind-safe palette.** The
  previous-close-aware intraday curve added in 3.6.x is now guaranteed to use
  only the Wong colourblind-safe palette and to never rely on colour alone:
  - The "below previous close" tint used a hard-coded vermillion fill
    (`rgba(213,94,0,…)`) that did not match the documented loss **orange**
    (`#E69F00`); the fill now matches `LOSS_COLOR` exactly
    (`rgba(230,159,0,…)`), so the curve is **blue** above yesterday's close and
    **orange** below — never red/green.
  - The previous-close reference line was drawn in the loss orange (implying a
    direction of its own); it is now a **neutral muted slate**, leaving the
    gain/loss read to the curve alone.
  - Direction is now encoded **redundantly, not by colour alone**: the latest
    point is marked with an up/down **triangle** (▲/▼) — a shape cue that
    survives any colour-vision deficiency — in addition to the curve's position
    versus the dashed reference line.
- **Allocation Calculator contribution bar drops its green fallback.** The
  "added contribution" slice resolved to the colourblind-safe `--inv-gain` blue
  in-app, but its hard-coded fallback colour was green (`#21ba45`); the fallback
  is now the Wong gain blue (`#0072B2`) so the bar stays colourblind-safe even
  when the stylesheet variable is unavailable.

## [3.6.3] — 2026-06-22

The settled-day caption is dated by the market, not by our fetch.

### Changed

- **Daily Growth caption stamps the *market* time a settled price is from.**
  In the "TODAY" state (US market closed, today's close already in) the caption
  previously stamped *when we pulled* the price — which simply echoed the
  visible refresh time. It now stamps **when the price is from on the exchange**:
  the data provider's market time (yfinance's `regularMarketTime`, e.g. the
  moment a mutual fund's NAV finally publishes), with our own pull instant
  trailing as "· updated HH:MM". So a settled figure reads, for example,
  "as of 21:59 · updated 22:16" in your display timezone. When the provider
  publishes no market time the caption falls back to the pull instant and then
  to the modelled 16:00 session close, and the clock is still omitted while the
  session is *live* (where it would merely echo the "· live" flag).

### Added

- **Per-instrument provider market time is cached.** The live price refresh now
  records yfinance's `regularMarketTime` alongside the pull timestamp in a new
  nullable `price_cache_metadata.price_market_time` column (Alembic migration
  0013, with a boot `create_all` guard for packaged installs). The capture is
  best-effort and isolated — a quote-timing hiccup never disturbs the price
  refresh.

## [3.6.2] — 2026-06-22

A clearer Daily Growth caption.

### Fixed

- **Daily Growth caption stamps when a settled price is from.** When the US
  market is closed but today's close is already in (the "TODAY" state), the
  caption now stamps *when the price is from* — the moment we last pulled it
  from the data provider, e.g. "as of 22:07" in your display timezone — instead
  of the vague "as of today" (falling back to the modelled 16:00 session close
  when no pull time is recorded). The clock is omitted only while the session is
  *live*, where it would merely echo the "· live" flag.
- **Exchange rate kept under Daily Growth, just tightened — now with its move.**
  The display-relative spot is no longer dropped from the caption; it returns in
  a compact form with its percentage change versus the prior trading day
  (`€1≈$1.0830 (+0.10%)` for USD users, `$1≈€0.9234 (−0.10%)` for EUR users).
  The move is a *percentage only* (no absolute) and reads live while the session
  is open, dropping the verbose absolute/“live FX” detail that made the line
  noisy.

## [3.6.1] — 2026-06-22

A calmer, more legible Analytics tab.

### Changed

- **Single-currency XIRR headline.** The Analytics summary now shows the
  money-weighted return (XIRR) in just the selected display currency. The
  second-currency figure added noise without insight — the headline already
  implies the currency lens — so the stat reads as one clear value.
- **Five-up KPI grid.** The Analytics scalar KPIs are laid out on a tidy
  five-across grid so the headline numbers line up instead of wrapping
  unevenly.
- **Paginated attribution table.** The per-instrument attribution grid now
  paginates (like the other tables) at a fixed height instead of growing the
  grid to fit every row, so a long holdings list scrolls through pages rather
  than overflowing and pushing the surrounding text off-screen.

## [3.6.0] — 2026-06-22

Daily Growth that knows whether the market is open, graphs that remember your
time range, and a Data Health page that tells warnings apart from errors.

### Added

- **Live vs. settled Daily Growth.** While the US market is open (today's stock
  prices are in), the Overview's Daily Growth caption shows the **live** FX rate
  and value with an "as of TIME" stamp plus the day's FX move. After the close
  (or on weekends/holidays) it falls back to the **last open-market day**, that
  day's settled FX rate and change, and an "as of DATE" stamp ("today" written
  out when it was today) — using live FX only if the settled rate hasn't been
  published yet.
- **Sticky graph time ranges.** The Overview value range, Analytics lookback,
  and Projection granularity selections are now remembered across reloads
  (persisted via `app_config`), so a graph keeps the window you last chose.
- **Fetched-symbol report in Settings.** The connectivity card now lists which
  symbols each provider (yfinance / Frankfurter) last fetched.
- **Scroll position restored on refresh.** The Update button (and any reload)
  now returns you to where you were on the page.

### Changed

- **Warnings are no longer shown as errors in Data Health.** `WARNING`-level log
  lines and stray `stderr` chatter (e.g. "returned no data", a UI-responsiveness
  stall) now surface as amber **warnings** — in the toast and on the Data Health
  page — instead of red errors. `BackgroundError` carries a `severity`, set from
  the log record's level and from a `WARNING`-line classifier on the stderr tee.



Saved target allocations now remember how you built them.

### Added

- **No-buy distinction persisted in saved targets.** The Calculator's central
  no-buy flag — funds that count toward the target percentages but never
  receive fresh cash — is now stored per fund on each saved target
  (`target_allocation_items.no_buy`). Loading a saved target restores the exact
  ticked/un-ticked state instead of re-ticking every member.
- **Calculator settings frozen with the target.** Saving also records the
  rebalance toggle (`target_allocations.allow_sell`, off = buy-only) and the
  entry/display currency (`target_allocations.display_currency`), and loading a
  saved target reapplies both so the plan reproduces what you built.

### Migration

- `0011_v3_5_3_allocation_settings` adds the three columns idempotently;
  packaged/split-DB installs gain them through the boot `create_all` guard,
  which now also runs against the config tier.

## [3.5.2] — 2026-06-22

Sharper Analytics, an honest benchmark, a new currency lens, and a Data Health
surface that cleans up after itself.

### Added

- **Currency (EUR ↔ USD) section on Analytics.** A new band of stats spells out
  how the exchange-rate move has affected a euro-based investor who holds dollar
  assets: the current rate vs the average rate you invested at, how far the euro
  has moved since, the slice of your EUR return that came from currency (EUR
  return minus USD return), the FX gain/loss baked into your EUR value, and what
  you'd receive converting the whole portfolio back to EUR now. Backed by the
  pure, unit-tested `domain.currency_effect` module.
- **"vs Benchmark (funded)" KPI.** A money-terms "did I beat the market?" tile
  that compares the portfolio to the *funded* benchmark (see below).

### Changed

- **The benchmark is now funded by your own contributions.** The Analytics
  equity-curve overlay (and the new KPI) invest the *same* deposits/withdrawals
  into the index on the same dates, instead of a single lump sum rebased to the
  window's start — so a dollar-cost-averaged portfolio no longer looks like it
  automatically beats a flat benchmark line over long horizons.
- **Smarter equity curve.** The old cumulative-contributions overlay is now a
  clear **Net invested** (cost-basis) line, with the band between it and the
  portfolio value shaded green when you're ahead and red when you're under
  water — your profit/loss reads at a glance.
- **Analytics headline redesigned.** The lone full-width "Total Growth" card
  (which stretched across the row and left a wall of whitespace) is replaced by
  a tidy three-tile hero band — Portfolio value · Total Growth · Capital gain —
  in the same uniform KPI grid as the rest of the page.
- **Per-instrument attribution table overhauled.** Columns now flex to fit (no
  more horizontal cut-off), P&L and % are sign-coloured, and a pinned **Total**
  row ties the per-instrument P&L back to the portfolio headline. Every holding
  is shown, sorted by P&L.
- **Monthly & Yearly tables read newest-first.** Both period tables are now in
  reverse-chronological order so the most recent period is at the top; the
  charts keep their natural left-to-right flow.

### Fixed

- **Data Health no longer keeps stale notices forever.** Background-error
  notices (e.g. "outdated prices") can now be **dismissed** individually or all
  at once, and they **auto-resolve**: a successful price/FX refresh clears its
  own earlier failure, so a notice disappears once the prices are actually
  flowing again instead of lingering until restart.

## [3.5.1] — 2026-06-22

Web companion: currency-aware growth and risk, a descriptive live-coverage
status, a heads-up when a new desktop export lands (now on automatic checks
too), a "prices all live" confirmation when the staged fill completes, and a
sensible FX line.

### Added

- **Live-coverage status that actually tells you something.** The overview now
  carries a calm inline note — e.g. "13/18 up to date · stocks & ETFs done, 5
  funds still refreshing" or "All 18 holdings up to date" — instead of either a
  60-second floating banner or the opaque "some prices aren't updated". The
  manual-refresh toast uses the same descriptive summary, naming the once-a-day
  NAV funds that lag rather than showing a bare count.
- **Heads-up when a larger update is on the wire.** A manual refresh now always
  performs the cheap encrypted-blob check (the moment you ask "is there anything
  new?"), and loading a genuinely new export pops a small "New data found —
  loading the latest portfolio…" toast. The silent 304/unchanged check stays
  silent. This toast now also fires when the **automatic** background check
  discovers a new export, not just a manual tap, so a fresh desktop publish
  always announces itself.
- **"Prices all live" confirmation.** When a portfolio is large enough that
  prices fill in over several refresh rounds (the free-tier per-minute cap), the
  moment the **last** still-pending holding catches up the app pops a brief
  "All prices live — every holding is now on a fresh price" toast, so the staged
  fill ends with a clear "you're fully up to date" signal instead of silence.
- **FX rate deviation in the hero.** The EUR/USD line now shows both the spot
  rate and how far it has moved today (e.g. "EUR/USD 1.0832 (+0.30% today)"),
  the cause behind the FX P/L slice.

### Changed

- **Growth and risk stats follow the currency toggle.** Period growth (monthly
  and yearly), and the risk/return metrics (volatility, Sharpe, Sortino, max
  drawdown, VaR, beta, alpha, …) now switch between EUR and USD with the display
  currency, matching XIRR and the per-stock growth. The mobile export gained a
  per-trade-date `cost_basis_eur` for each holding and `*_usd` companions for
  the currency-sensitive analytics metrics so the web can show currency-correct
  figures instead of rescaling EUR at today's spot.
- **FX P/L is no longer shown in USD.** The FX-revaluation slice of today's move
  is intrinsically a EUR-side effect (a USD-booked holding only changes in EUR
  when EUR/USD moves; its USD value is unaffected), so USD display now says "FX
  moves your EUR value, not USD" instead of rescaling a meaningless number.

## [3.5.0] — 2026-06-22

A from-scratch redesign of the **Calculator** tab: build a target mix right on
the page (no more trip to Settings), think in **categories** that auto-group
your funds, and read the plan visually.

### Added

- **In-page allocation builder.** The Calculator now defines its own target
  mix — no need to create and activate an allocation in Settings first. Two
  modes: **By category** (e.g. "10 % International", with the funds in that
  category sharing the slice automatically) and **By fund**. Every row shows
  *how much percent it currently has* next to the target input, with a bar that
  overlays the current weight under a target marker.
- **Category fund picker + fair split.** Inside each category you can tick which
  funds to actively invest in and choose how the category's weight is divided:
  **Fair by value** (proportional to current holdings) or **Even**. New domain
  helper `expand_category_weights` does the math (covered by unit tests).
- **Presets & live total.** One-click **Match current mix**, **Equal weight**,
  **Load saved target**, and **Clear**, plus a live total bar. Targets are
  normalised to 100 % on compute, so you can sketch freely without the old
  "weights must sum to 100" friction.
- **Visual buy plan.** The plan now leads with KPI tiles (investing / allocated
  / left over) and a per-fund list showing the add amount (EUR + USD + shares)
  and a bar of the resulting weight versus target.
- **Save as target.** Persist the mix you built as a named target allocation
  (optionally activating it) so it still drives the allocation-drift views.

### Changed

- **Settings de-cluttered.** The busy per-instrument weight-entry dialog has
  been removed from Settings; the *Target allocations* section now lists saved
  targets and links to the Calculator to build new ones.
- **Calculator computes off the event loop.** The page now uses the `deferred`
  `compute` hook (as the other heavy pages do since 3.4.2): it paints its shell
  and a spinner first and gathers the calculator data + active allocation on a
  worker thread (via `nicegui.run.io_bound`), so building a target mix on a
  large portfolio no longer stalls the websocket or trips the reconnect storm.
- Calculator share math now prices holdings in **EUR** (converting USD closes at
  the current rate) so share counts line up with the EUR buy amounts.

## [3.4.2] — 2026-06-22

Keep the desktop UI responsive under load: every heavy page now gathers its
data **off the event loop**, and the slow update/upload tasks were moved off it
too — so one slow calculation, scan or import can no longer stall the websocket
and trip the "disconnected" / reconnect storm on every open tab.

### Changed

- **All heavy pages now compute off the event loop.** The `deferred` `compute`
  hook (introduced for Overview in 3.3.0) is now used by **Holdings**,
  **Analytics**, **Monthly**, **Yearly** and **Projection** as well: each
  page's DB + metrics gathering runs on a worker thread (via
  `nicegui.run.io_bound`) and only the rendering happens back on the loop. The
  websocket stays free to answer heartbeats while the numbers crunch.
- **Data Health gathers off the loop too.** The page now paints its shell and
  spinner first and runs the whole-database health scan on a worker thread,
  instead of blocking the loop before the page could paint.
- **CSV import runs off the loop.** Importing a broker history (parsing + DB
  inserts) and the follow-up live-web republish now run on a worker thread, with
  the Import button disabled and an "Importing…" status while it works — a long
  history no longer freezes every connected tab mid-import.
- **Support-bundle download builds off the loop.** Packaging the log file and
  app context for the "Report an issue" download now runs on a worker thread, so
  a large log can't stall the UI.

## [3.4.1] — 2026-06-22

Minor reliability fixes to the main app: timezone-aware "last update" stamps, a
live refresh that actually advances those stamps, per-holding total growth that
matches the compounded XIRR figure, and an analytics tab that loads again.

### Fixed

- **Timezone-aware "last update" times.** The overview holding card's price
  freshness and the connectivity section's timestamps now render in the user's
  configured timezone instead of naive/hard-coded UTC.
- **Live price refresh advances the "updated" time.** The live tick now writes
  cached closes and the per-symbol `last_refreshed_at` stamps through the cache
  database tier (the one the overview reads under split-DB layouts), so the
  on-screen prices and "updated" time move when live prices update.
- **Per-holding total growth uses the compounded XIRR formula.** Each holding's
  total growth is now the compounded `(1 + XIRR) ^ years` figure (matching the
  portfolio headline) rather than a plain gain/cost ratio, which had badly
  deflated the growth of holdings funded by regular, ongoing contributions. The
  same fix is mirrored in the web companion.
- **Analytics tab loads again.** The equity-curve build now bounds its live
  recompute to a recent trailing window (filling deeper history from the
  background snapshot warm) instead of synchronously revaluing every uncached
  day on the request thread, which had hung the tab on long lookbacks / a cold
  cache.

## [3.4.0] — 2026-06-22

FX-aware, live "today's growth". Today's move now captures the EUR↔USD
revaluation of held positions, not just the security's price move, and tracks
live intraday EUR/USD on both apps.

- **Desktop** sources the live EUR/USD spot keylessly from yfinance
  (`EURUSD=X`) during each price refresh and overlays it onto the ECB daily
  history for *today only* — the headline and per-holding "today" figures move
  intraday with the currency, while every historical mark (and the
  golden-master daily figures) stays byte-stable. The live spot is in-memory
  only and never written to `fx_history`.
- **Web companion** fetches live EUR/USD from Twelve Data (the same provider as
  prices, one credit/min within the free-tier budget) with a graceful fallback
  to the ECB daily rate. Today's move is recomputed as a value delta
  (`value_now` at the live rate minus `value_prevClose` at the prior-close
  rate), the USD move stays FX-neutral, and the hero surfaces the live EUR/USD,
  an "incl. … from FX" split, and an "end-of-day FX" tag when the live rate is
  unavailable.

## [3.3.0] — 2026-06-22

Desktop live-web companion workflow polish — quieter, smarter auto-publishing
and shutdown — plus a money-market profit/loss correction that now flows through
to the web companion, and a smarter update button.

### Added

- **Resilience against disconnects and long calculations.** Several safeguards
  so a single slow calculation no longer takes the whole desktop app down:
  - The **Reconnect now** button now first attempts an *in-place* socket
    reconnect (preserving the page's state) and only falls back to a full reload
    if the socket stays down — it no longer kills a page that was merely busy.
  - A brief websocket stall is ridden out behind the calm "Still working…" hint
    for a short grace window; the alarming "connection lost" banner only appears
    if the drop persists, so it no longer flashes the instant something loads.
  - Heavy page builds can now run their data gathering **off the event loop**
    (new `compute` hook on the `deferred` helper), keeping the websocket
    responsive while metrics crunch; the Overview page uses it.
  - A new **event-loop stall watchdog** surfaces a heads-up (Data Health + log)
    when a long synchronous calculation blocks the UI, turning an invisible
    freeze into an explicit, actionable signal.

- **Debounced auto-publish after manual edits.** Editing, adding or deleting a
  transaction now schedules a single live-web republish 120 seconds after the
  *last* edit, so a burst of manual corrections coalesces into one upload
  instead of publishing on every keystroke. The pending publish is cancelled on
  shutdown (which publishes once itself).
- **Publish notifications.** After an import-triggered or shutdown-triggered
  auto-publish, a short toast reports whether the snapshot was published or
  failed (with a non-sensitive reason). Skipped/disabled publishes stay silent.

### Changed

- **Money-market profit/loss now counts reinvested dividends.** Settlement
  funds (VMFXX, SPAXX …) price at par ($1), so their reinvested dividends were
  folded into the cost basis and cancelled out, pinning gain and growth at zero.
  Those reinvest legs are now excluded from money-market cost basis, surfacing
  the earned dividends as the holding's gain/growth in the desktop overview,
  the mobile export, **and** the web companion.
- **The update button reloads the page as well as the prices.** A user-initiated
  refresh now repaints the page "page first" if prices are slow to arrive, then
  reloads again once the fresh prices land, so the view never feels stale.
- **"Last published" time is shown in your configured timezone** (no longer in
  raw UTC), and the header clock drops its timezone suffix (set the zone in
  Settings instead).

### Changed — shutdown

- **Cleaner log-off.** Shutting down now auto-closes the tab and shows a calm
  "Shutting down… you can close this tab." message instead of the alarming
  "connection lost" reconnect screen.

### Fixed

- **Web: a transient HTTP 404 no longer dead-ends the dashboard.** Only true
  config/auth failures (HTTP 401/403) now route to the Settings error screen;
  every other live-price hiccup keeps the last-known values and shows a soft
  banner, so a refresh can't strand the app on a full-screen error.
- **Web: guard against rate-limit (HTTP 429) self-inflicted bursts.** Free-tier
  credits are now reserved *before* the network fetch, so the login prefetch and
  the first scheduled refresh can no longer each spend a full per-minute budget
  at once (the concurrent double-spend that tripped the 429).
- **Web: quieter refresh status.** The live-degradation banner is now a single,
  non-duplicative line, and the auto-update pill no longer lingers on screen
  between staged burst rounds.
- **Desktop: today's EUR growth no longer inflated by a stale FX gap.** When the
  prior price date's exchange rate is forward-filled from far in the past, the
  EUR daily-growth figure is neutralised to the USD figure instead of absorbing
  months of currency drift into a single day's move.


## [3.2.1] — 2026-06-22

Web companion: a batch of mobile-first UI polish around the chart axis, the live
update animation, and free-tier budget awareness, plus a desktop equity-curve fix.

### Changed — web companion

- **Chart Y-axis now uses "nice" round ticks.** The growth chart picks evenly
  spaced, human-friendly gridline values (1/2/5 × 10ⁿ family) instead of the raw
  data min/max, giving more exact number ticks without widening the axis gutter.
- **The update indicator now actually animates and shows real progress.** The
  Refresh glyph spins for every update (not just manual ones) and stays alive
  across the per-minute burst rounds, filling in an "N of M symbols" count so a
  large watchlist that can't refresh in one free-tier minute still feels alive.
  The deferral banner is calmer and explains symbols will keep filling in.
- **Daily free-tier budget is now paced and surfaced.** Refresh cadence eases off
  automatically as the day's credit usage approaches the 800/day cap, the footer
  shows "Live-data budget today: X / Y credits used", and the status line warns
  when usage is very close to or over the limit.

### Fixed — desktop analytics

- **Contribution equity curve no longer stays flat for transfer-funded
  portfolios.** The analytics equity curve now counts `transfer_in`/`transfer_out`
  as external contributions/withdrawals (matching the metrics service), so
  accounts funded via transfers show a rising contribution line.

## [3.2.0] — 2026-06-22

Web companion: currency-correct growth, clearer data-freshness wording, and a
batch of chart and tooltip fixes — all mobile-first.

### Changed — web companion: growth figures now follow the display currency

- **Growth, gain and XIRR are currency-dependent again.** Percentages and gains
  on the Overview KPIs (Total gain, Total growth, XIRR, this-month / this-year
  returns) and on each holding card (growth, P/L, XIRR) previously stayed on the
  EUR figure even when the display was switched to USD. Because the EUR→USD rate
  drifts between the cash-flow dates and today, EUR- and USD-denominated growth
  genuinely differ, so the companion now exposes both and shows the one matching
  the selected currency — mirroring the desktop's per-currency KPIs. The mobile
  export now carries the USD primitives this needs (`cost_basis_usd` per holding,
  `amount_usd` per cash flow, and USD period openings). When the USD figure can't
  be derived it falls back to the EUR value.

- **The Plan-tab projection input follows the display currency too.** The
  "Annual contribution" field is now labelled with the active currency, seeds its
  default in that currency, and converts what you type back to EUR before
  projecting, so the projection stays consistent in USD as well as EUR.

### Changed — web companion: "prices updated" footer now reports the last data pull

- **The footer states when data was last pulled, not when prices are from.** The
  per-holding "as of" chips already say when each price is from, so the footer
  above Holdings now reports when the app last fetched live data — with a
  "today" / "yesterday" keyword so, for example, a Sunday refresh clearly reads
  as today's pull. The Refresh button's hover tooltip shows the same last-update
  time.

### Fixed — web companion: chart range labels, axis ticks, and the contribution line

- **Charts no longer mislabel a one-year view as "All".** The equity / value
  curve is now exported from inception, so the "All" range really does span the
  whole history and the 1Y / 6M / 3M / 1M presets slice it correctly.
- **The contribution line is no longer flatlined.** With the full-history curve,
  cumulative contributions rise from zero instead of looking flat inside a
  one-year window where existing wealth dwarfs recent contributions.
- **Short-range charts label the x-axis by day.** A one-month view now shows day
  ticks instead of a single month label, with an extra tick or two when there is
  room.

### Fixed — web companion: Risk-tab info tooltips no longer linger

- **Tapping an info "i" now dismisses like a normal tooltip.** On touch devices a
  pinned definition stayed on screen until tapped again; it now closes on an
  outside tap, on Escape, or when focus leaves. On hover-capable devices the tip
  simply follows the pointer and vanishes on mouse-leave.

### Fixed — local app: editing a cash move no longer desyncs its settlement leg

- **Editing or deleting a transaction now keeps its paired money-market
  settlement leg in lock-step.** A deposit/withdrawal/transfer (and every
  imported cash move) is mirrored by an equal-and-opposite settlement-fund leg
  that is hidden from the ledger by default. Previously, editing the visible
  parent left that hidden leg untouched, so the settlement balance silently
  diverged; deleting the parent stranded the leg. The editor now re-derives the
  leg from the edited amount/date (or removes it if the edit zeroes the cash
  flow), and deleting a parent removes its leg too.
- **Works for existing entries.** Imported rows are matched through their
  `:vmfxx` external-id link; legacy manually-added settlement legs (which had no
  link) are matched by their auto-description, account, date and opposite
  amount, so editing transactions already in your database stays correct.
- Newly auto-created manual settlement legs are now linked to their parent and
  hidden by default like the importer's sweeps (reveal them with **Show
  settlement sweeps**); opening the editor directly on a settlement leg now
  steers you to edit its parent instead.
- **Transactions toolbar stays on one line.** The filter/action bar under the
  KPI tiles no longer wraps the **Import** button onto a second row — the action
  buttons are kept clustered on a single, non-wrapping line.

## [3.2.0] — 2026-06-22

### Analytics page
- **Equity curve** now has labelled x/y axes (Date, Value) with gridlines and roomy margins instead of edge-clipped axes; the cumulative-contributions overlay is hidden when no deposits/withdrawals are logged so it no longer renders as a confusing flat line pinned to the bottom.
- **Per-instrument attribution** now uses the same Alpine table theme as the rest of the app (no more out-of-place styling / clipping) and carries a one-line caption explaining it is the per-holding breakdown behind the totals above.
- **Risk metrics** are regrouped into tidy, uniform-width tiles under labelled bands — *Returns*, *Risk & volatility*, *Drawdown & tail risk*, *Benchmark & market* — replacing the ragged, mismatched-size flex rows.

### Holdings page
- Added **Total Growth** and **XIRR** KPI cards to the headline row.
- Portfolio shape now fits on a single row instead of wrapping a lone tile to a second line.
- Re-ordered the per-holding growth columns to **XIRR → Total → YTD → MTD → Today**, adding the previously-missing **MTD** column.
- Roomier table spacing so figures and labels are no longer clipped.

### Added — local app: edit transactions & a much easier manual entry

- **Transactions are now editable (and deletable) right from the ledger.** Each
  row carries a small ✏️ action in a pinned left column — clicking it opens the
  same form pre-filled, so you can correct any row (especially manually-added
  ones) or delete it behind an "are you sure?" gate. There is no toolbar edit
  button; the action lives in the table next to the row it edits.
- **Manual entry no longer makes you do the arithmetic or pick a sign.** You type
  **quantity, price and total** and the form fills in whichever one you leave
  blank and checks the three agree (within a small rounding tolerance) before it
  will save — catching the "these don't reconcile" mistake that previously slipped
  through silently. The **+/- sign is now derived from the kind**: a *Sell* is
  always cash in, a *Buy* always cash out, and a sale's share count is stored
  negative automatically, so logging a sale with the wrong sign is no longer
  possible.
- **Cash transfers fill / deplete the money-market fund automatically.** When an
  account holds a settlement / core money-market fund (VMFXX, SPAXX, …), a
  deposit / withdrawal / transfer in or out now also buys or sells that fund at
  its $1.00 NAV, so the uninvested-cash balance stays correct without you logging
  the move twice. This mirrors the importer's Vanguard settlement-sweep logic and
  can be switched off per entry.

### Changed — local app: broker import is upload-first and more forgiving

- **Import flow reordered so you upload first, then choose the account.** The
  importer modal previously fired the moment a file was picked and dropped the
  file entirely if no account was selected yet. Now the file is stashed on
  upload, the broker/account can be chosen in any order, and the import runs only
  when you press an explicit **Import** button (disabled until a file is staged).

### Changed — local app: live price refresh

- **One refresh indicator, not two.** The duplicate refresh animation in the
  header was removed; the live-update indicator is the single source of truth, and
  it is now clickable to force a manual refresh.
- **Page refreshes now refresh prices too**, and the **auto-update interval is
  editable in Settings** (15 s – 1 h) with a small animated bar at the top of the
  page while an update is in flight.
- **The per-symbol "last updated" time no longer sticks.** Every instrument that
  is actually queried in a refresh is now stamped, so the overview's freshness
  times advance even when the feed returns no new closing price.

### Changed — local app: projection & monthly overview

- **The projection screen shows a single currency** (USD *or* EUR, matching your
  current display choice) instead of always rendering both.
- **The monthly overview now includes the current, in-progress month** and
  computes its month-to-date growth rather than ending at the last completed
  month.

### Fixed — local app: Data Health no longer reports benign Alembic noise

- **Routine Alembic migration log lines are no longer surfaced as "recent
  errors".** The embedded migration runner no longer routes Alembic's INFO logging
  to stderr, and the error reporter additionally ignores INFO/DEBUG-only chunks,
  so the Data Health screen stops flagging a healthy startup as a problem.

### Fixed — web companion: correct USD contribution / period figures

- **Contributions and monthly/yearly figures are now correct in USD.** The
  web companion previously took every figure in EUR and rescaled it to USD by
  *today's* spot rate. For sums of historical cash flows (contributions, period
  net flows/dividends/interest) and point-in-time valuations this double-
  converted any amount originally booked in USD, so the totals did not match
  the desktop. The companion now uses the per-trade-date USD figures the export
  already carries: the `deposits` read-model's `*_usd` / `amount_usd` fields,
  and — newly — the monthly/yearly `*_display` (USD) fields, which the mobile
  export now always emits (it builds the period read-models against a USD
  context) regardless of the desktop's own display currency. When FX history is
  too sparse to convert a figure, the companion falls back to the EUR value.

### Fixed — manual refresh feedback was invisible on mobile

- **Tapping the web Refresh button now always shows feedback.** Two gaps made a
  phone tap look completely inert: (1) a refresh fully served from cache resolves
  in a few milliseconds, so the spinner + "Refreshing prices…" pill flashed for
  less than a frame, and (2) a tap that landed while an automatic background pull
  was already running was silently dropped. The manual feedback is now held on
  screen for a short minimum so it is always perceptible, a tap during an
  in-flight auto-refresh is acknowledged instead of ignored, and every manual
  refresh ends with a brief toast stating the outcome (prices updated, already
  up to date, queued, or a fallback when live data couldn't be reached).
- **The local app's Settings refresh spinner no longer flashes by.** The same
  root cause applied on desktop: `Refresh prices` / `Refresh FX rates` early-
  return without a network call when the data is already current, so the
  button's in-place spinner could appear and vanish within a single frame. The
  spinner is now held for a short minimum so a manual refresh is always
  perceptible there too (the outcome toast was already shown).

## [3.1.1] — 2026-06-21

Desktop price-freshness transparency and a holdings redesign that mirrors the
live-web companion, plus a small web tweak so the per-holding chip shows the
stat that actually matters — and visible feedback for manual and automatic
price refresh across both apps.

### Added — desktop: price-freshness transparency

- **Every holding now says when its price is from.** The desktop app reads the
  same two facts the web companion surfaces — the observation date of the
  latest cached print (`PriceHistory.date`) and the saved fetch time
  (`PriceCacheMetadata.last_refreshed_at`) — and shows them per holding. Money-
  market funds (par $1.00, no feed) are labelled as such instead of faking a
  date.

### Changed — desktop: overview redesign + new Holdings tab

- **The outdated positions table on `/overview` is gone.** In its place every
  holding gets a card (like the web companion's holding rows) with value, daily
  move, total growth, P/L, XIRR, YTD, price, shares, cost basis, expense ratio,
  and its "as of" / "updated" freshness line. Cards are sorted by EUR value,
  largest first.
- **New `/holdings` tab.** The full sortable table moved here, joined by deeper
  detail: a portfolio-**weight** column, an "As Of" column, headline KPI cards,
  and a summary strip (best/worst performer, gainers vs. losers, most-
  concentrated holding, weighted expense ratio).

### Changed — live-web companion

- **The per-holding chip now shows total growth instead of portfolio weight.**
  Growth (unrealised P/L over cost) is the primary read; weight is a secondary
  stat and now lives in the desktop Holdings table.

### Added — visible feedback for manual and automatic price refresh

- **Manual refresh now shows in-progress feedback.** On the web app, tapping
  the header **Refresh** button spins the button glyph and shows a
  "Refreshing prices…" pill until the live data lands. On the local app, the
  Settings **Refresh prices** (and **Refresh FX rates**) buttons show a spinner
  and disable while the refresh runs — the work is offloaded to a worker thread
  so the spinner keeps animating instead of the click silently blocking.
- **Automatic background price pulls are now visible too, and distinct from a
  manual refresh.** On the web app the scheduler's auto-refresh shows a separate
  accent-tinted "Auto-updating prices…" pill. On the local app a new header
  "Live / Auto-updating…" chip (backed by a small `refresh_status` service)
  spins while the post-boot deferred refresh or the periodic live-price tick is
  running and shows the last automatic-update time when idle — so it's clear the
  automatic features are working.

## [3.1.0] — 2026-06-21

Live-web companion (`web/`): mutual-fund (NAV) pricing, the value-over-time
chart, and the benchmark line. This release lands the work from PR #34 (which
had not been recorded here) **and** the follow-up fixes that finally make NAV
freshness correct around market closures.

### Fixed — live-web companion: overview hero & live NAV override

- **The date stamp at the very top of the overview is gone.** The "Updated …"
  line that sat above "Total value" has been removed; freshness now lives only
  where it is actionable — the per-holding "as of" chips and the footer note —
  so the hero is just the headline value and today's move.
- **A fresh Twelve Data pull now overrides a stale or wrong exported NAV on the
  same trading day.** Previously a live NAV only superseded the exported value
  when its value-date was *strictly newer* than the export, so a re-fetch could
  not correct a bad value baked into the export/blob for the current day. A live
  NAV bar now wins whenever it is for the **same or a newer** trading day than
  the exported price; the export is kept only when the live bar is strictly
  *older* (a closed-day carry-forward), so the value never swaps backward onto a
  stale basis.

### Fixed — live-web companion: value chart & holding dates

- **The "Value over time" chart no longer drops off a cliff at the live tip.**
  The exported analytics equity curve was serialized in the desktop's *display*
  currency, but the web companion works in EUR internally (its FX pivot) and converts to the display
  currency at render time — so the curve was effectively converted twice,
  inflating the whole line by the EUR→display factor and leaving a ~16% vertical
  drop where the (correctly-EUR) live total joined the (display-currency)
  history. The export now always emits the curve in EUR, matching every other
  figure in the bundle. Risk/return metrics are scale-invariant, so they are
  unchanged.
- **Removed the redundant date stamp under the chart.** The
  "`<date>` → today · live tip from your current total value." caption is gone;
  a note now appears only when there is something to flag (an incomplete live
  total or a stale holding).
- **Each holding's "as of" date moved to the top row.** It now sits in the space
  between the symbol/NAV pill and the price, instead of on a line under the name.
- **Fallback (non-live) holding dates now show when the value was actually last
  updated.** The export carries a per-holding `last_price_date` (the trading day
  the exported price came from); the web uses it instead of the export date, so
  a fund priced from Friday's NAV no longer reads as "today" when the export was
  taken on a weekend.

- **NAV is now priced from the daily `time_series` endpoint, not `quote`.**
  Twelve Data's `/quote` carries a fund's last NAV forward and stamps it with
  *today's* date even when the market is closed — so on a Sunday (or a mid-week
  market holiday) it looked like a fresh price and revalued the fund onto the
  wrong basis. NAV symbols are now fetched from `/time_series`
  (`interval=1day`), which only emits a bar for a **real trading day**. A
  weekend or holiday produces no new bar, so the exported NAV is correctly kept
  until the fund actually re-strikes. This needs no hand-maintained holiday
  calendar.
- **The exported NAV is superseded by a same-or-newer value-date**, and a live
  value is never stamped with the fetch time — its "as of" is
  the NAV's real strike date. Together with the `time_series` source this fixes
  the "Twelve Data says the fund updated today even though markets are closed"
  bug.
- **Per-fund publish window is learned from observed value-date flips** (PR
  #34) rather than a fixed guess, with a sensible Europe-close bootstrap, so
  NAV polling happens around when each fund actually publishes.

### Fixed — live-web companion: value-over-time chart & benchmark

- **The end-of-line "cliff" is gone.** The chart's final, live point no longer
  drops far below the historical line. It was caused by the bogus closed-day NAV
  above revaluing a fund onto a wrong basis; with NAV freshness fixed the live
  tip sits on the same basis as history.
- **The live tip is only appended when today's total is complete** (PR #34).
  If a holding drops out (missing price/FX), the incomplete sum is no longer
  drawn as a false final-day dip.
- **The benchmark series is rebased to the portfolio's scale** (PR #34) so the
  comparison line is visible alongside the portfolio instead of being pinned to
  the axis floor.

### Changed — live-web companion: freshness shown at the top

- **The last-updated time/date now appears at the very top of the screen.** It
  shows the **exact market time** when a live holding (stock/ETF) updated today
  and live-refreshes, and falls back to a **date** for mutual funds and for
  markets that are closed — matching how a neobroker shows freshness.
- **The "last known" badge is removed.** That bubble is replaced everywhere by
  the price's actual date or time, so the top of the screen always states when
  the figure is from.

### Added — live-web companion: fingerprint-first unlock & idle auto-lock

- **Fingerprint-first unlock.** Once fingerprint unlock is enrolled, the unlock
  screen leads with a single prominent "Unlock with fingerprint" button (with the
  passphrase tucked behind "Use passphrase instead") and **auto-prompts** the
  platform authenticator on load, so a returning user is in with one touch and no
  extra tap.
- **Idle auto-lock.** After a configurable period of inactivity (default **5
  min**, `0` disables) the session clears the in-memory passphrase and returns to
  the unlock screen, so an unattended phone doesn't sit on an open dashboard.

### Changed — live-web companion: Settings reorganised, dark-mode-friendly defaults

- **Settings are grouped and reordered** to lead with **Appearance** (the
  System → Light → Dark theme control), then **Security** (the idle auto-lock
  timeout and a fingerprint-unlock toggle), and finally **Data source** (data
  source, quote cache, blob URL override), so the most-used controls come first.

## [3.0.1] — 2026-06-21

Patch release collecting the post-v3.0.0 follow-up work through PR #36: local-app
responsiveness and diagnostics, live-web companion fixes for real-world hosting and
free-tier data limits, and polish for charts, tables, mobile spacing, settings, and
shutdown behavior.

### Added — local app reliability and diagnostics
- **Live navigation and connection feedback.** A top progress bar, long-load hint,
  immediate connection-lost banner, header status dot, and longer NiceGUI
  reconnect window make slow page builds and websocket drops visible instead of
  feeling like the app is stuck.
- **Clean in-app shutdown.** A header power button confirms and requests a graceful
  server shutdown, releasing the single-writer lock without needing a console or
  process kill.
- **Shareable log files and support bundles.** Logging now writes a redacted,
  rotating `dashboard.log` beside the data directory by default, and Data Health
  can download a support bundle with version/platform/config context plus recent
  log output.
- **Every important error surfaces in the browser.** Warning/error logs, uncaught
  exceptions, asyncio loop failures, unraisable/thread exceptions, and stray
  `stderr` tracebacks now funnel into the same in-app Recent errors tracker, with
  de-duplication to avoid toast floods.

### Changed — local app performance and table UX
- **Monthly/Yearly pages paint immediately.** Their heavy roll-ups now run through
  the deferred spinner helper, and abandoned clients are skipped so rapid tab
  switches do not queue work for dead pages.
- **Yearly no longer cold-recomputes the full history on the request thread.**
  Snapshot refreshes rebuild cached daily values in place instead of deleting the
  cache first, and the Yearly full-history curve bounds synchronous recompute to
  a short recent tail while the background warm fills older gaps.
- **Overview positions are easier to scan.** The table opens sorted by holding
  value, capital gains are sign-coloured, and each row gets a gain/loss stripe
  based on total growth in the displayed currency.

### Added — live-web companion hosting and chart polish
- **CORS proxy for the encrypted blob.** Added a pinned Cloudflare Worker under
  `web/proxy/` plus setup docs so the browser companion can fetch the overwritten
  GitHub release asset through a CORS-enabled URL without putting ciphertext in
  Pages builds or git history.
- **Chart time-range presets.** Overview and Risk charts now offer adaptive
  1M/3M/6M/1Y/All buttons that re-slice already-loaded data on both phone and
  desktop.

### Changed — live-web companion data freshness and free-tier behavior
- **Twelve Data free-tier budgeting.** Quote and FX loading is cache-first, tracks
  rolling per-minute/day credit use, defers overflow symbols instead of failing
  the whole dashboard, and retries transient 429/5xx/network errors with backoff.
  Settings now include a quote-cache TTL knob.
- **NAV polling learns from each fund.** The companion records when a fund's NAV
  `valueDate` actually advances and derives a tighter per-symbol publish window;
  the bootstrap guess now starts around the European close instead of polling too
  early.
- **Desktop web layout uses wide screens better.** The Overview hero/chart,
  Periods spacing, Risk tooltips, and Plan projection layout were widened and
  aligned so tabs no longer jump between different content widths.

### Fixed — live-web companion correctness and failures
- **Unlock failures now explain the real CORS problem.** Browser-generic
  `Failed to fetch` errors are translated into an actionable Blob URL / proxy
  hint, while HTTP, JSON, and missing-blob errors remain distinct.
- **The value-over-time chart no longer draws a false final dip.** Holdings that
  cannot be valued live fall back to the last exported EUR value when available,
  get a `stale value` label, and still contribute to totals; only holdings with
  no usable price/FX/fallback are excluded, in which case the chart stops at the
  last fully valued exported point.

### Added — web companion UI: spacing, collapsible lists, period overview, settings (PR #35)
- **Roomier spacing.** Widened the topbar button gaps and the overall
  content/section gaps, and switched the contributions stat grid to
  `minmax(0, 1fr)` columns so the three figures can shrink to fit instead of
  colliding on narrow phones.
- **Collapsible sections.** A `collapsibleSection()` helper (native
  `<details>` + summary header/chevron) now wraps holdings, the monthly/yearly
  period tables, and attribution, so long lists can be folded away; each
  section remembers its open/closed state per device via `localStorage`.
- **Fuller period overview.** The live current month is synthesised when the
  export omits it (carrying the prior period's closing value forward), and a
  missing first-period growth number falls back to a Modified Dietz computation
  mirroring the desktop app's `_period_query` semantics.
- **In-app settings.** A new gear (⚙) topbar button opens a Settings panel that
  is editable while logged in (data source, cache, blob URL); saving re-runs the
  load pipeline in place. The light/dark/system theme control moved into it.

### Fixed — web companion UI regressions from PR #35 (PR #36)
- **Overview cards no longer bleed together.** `.panel-overview` only received
  its grid (with gaps) inside the desktop media query, so on phones the hero,
  return horizons, KPIs, holdings, and allocation stacked flush against each
  other. A base `display: grid; gap` rule now separates them on mobile too.
- **Contribution rows align with their header.** The recent-contributions
  ledger nested inside the allocation `<details>` panel had no horizontal
  padding, so the "Deposit" label sat flush against the card edge instead of
  lining up with the padded summary header.
- **Clearer projection table.** The Plan projection table gained more row
  spacing and zebra striping for visual separation, and its hypothetical
  figures are now rounded to whole currency units (no misleading cents) via a
  new `formatCurrencyWhole` helper.

## [3.1.0] — 2026-06-21

Smarter, cheaper data movement for the live-web companion: the encrypted blob is
only re-downloaded when it has actually changed, live quotes start warming up
**during login** so the dashboard fills in faster, and quotes are fetched in
priority order (biggest ETFs/stocks first, then mutual funds). Includes one
Cloudflare Worker redeploy and an automatic, publisher-controlled version stamp.

### Added — only re-download the blob when there is a newer version
- **HTTP conditional fetch.** `web/src/blob.ts` gains `fetchEnvelopeConditional`,
  which sends `If-None-Match` / `If-Modified-Since` from the cached validators so
  an unchanged blob comes back as a bodyless **304 Not Modified** — no transfer,
  no decrypt. Validators (`ETag`, `Last-Modified`) are cached alongside the
  envelope (`cache.ts` `writeCachedEnvelope`/`readCachedEnvelope`).
- **Publisher-controlled version stamp (robust fallback).** The desktop publisher
  (`services/publish_service.py`) now uploads a tiny `portfolio.meta.json`
  sidecar next to `portfolio.enc` on every publish, carrying a SHA-256 of the
  encrypted blob (`build_meta`). The companion fetches this few-byte file first
  (`fetchBlobMeta`) and skips the blob entirely when the version is unchanged —
  the most reliable "is there a newer export?" signal, fully under your control.
- **Cheapest-signal-first refresh.** `App.maybeRefreshBlob` now checks the meta
  stamp, then a conditional GET, and only pulls ciphertext on a genuine change.
  The old fixed 2-minute re-download guard is removed (the check is now near-free).
- **Near-free freshness polling.** Once the auto-refresh settles into its slow
  steady-state cadence, it piggy-backs the cheap meta/304 check so a fresh
  publish is picked up automatically within minutes — without reopening the app.
- **CORS proxy update (`web/proxy/`).** The Cloudflare Worker forwards the
  conditional headers, relays upstream **304**s, exposes `ETag`/`Last-Modified`
  via `Access-Control-Expose-Headers`, and serves the sidecar on `?meta`. **You
  must redeploy the Worker once** (`wrangler deploy`) — see `web/proxy/README.md`.

### Added — faster live data at login
- **Warm-on-login prefetch.** `App.prefetchLiveData` starts fetching quotes for
  the symbols it already knows about (from a cached plan) **while you type your
  passphrase and the blob decrypts**, so the first post-login paint is live
  instead of starting the per-minute clock from zero. EUR FX is fetched in
  parallel. The work writes into the same caches the real refresh reads and
  honours the shared free-tier credit budget, so it can never double-spend.
- **Cached symbol plan.** A small `iv.web.symbol_plan` cache (`cache.ts`
  `readSymbolPlan`/`writeSymbolPlan`) persists the priority-ordered tickers +
  coarse sizes from the last refresh — tickers/sizes only, never decrypted data.

### Changed — prioritised fetch order
- **Biggest first, ETFs/stocks before funds.** `compute.buildFetchPlan` orders
  the live fetch as: market holdings (ETFs/stocks) largest-EUR-first, then
  fetchable mutual funds largest-first. Money-market funds remain never-requested
  (NAV pinned at $1). Under the free-tier per-minute cap, the most impactful
  prices now land first.

### Settings
- **New "Version-file URL override" field** in the Settings menu, mirroring the
  existing Blob URL override. Leave it blank to derive the sidecar URL from the
  blob URL automatically; set it only if the meta file lives elsewhere
  (`config.ts` `resolveMetaUrl`, new `metaUrl` config key).

## [3.0.0] — 2026-06-21

The **v3.0 live-web companion** lands: an encrypted publish pipeline and an
in-browser dashboard that decrypts and renders your portfolio client-side, plus
an installable PWA, desktop auto-publish triggers, a public-repo security scrub,
and structured per-row broker imports. This release also folds in the portable
bundle first-start fix that shipped under 2.11.x.

### Added — v3.0 live-web companion, Phase 5 "PWA + auto-publish + public scrub"
- **Installable PWA (`web/`).** A web manifest (`public/manifest.webmanifest`),
  a brand SVG icon (`public/icon.svg`), and a service worker (`public/sw.js`)
  make the companion add-to-home-screen capable and offline-ready. The worker
  caches **only the public, static app shell** — never the encrypted blob, the
  live price/FX responses, or any decrypted data (which stays in memory). It is
  registered (production builds only) by `src/pwa.ts`.
- **Auto-publish triggers (desktop).** `services/auto_publish.py` republishes the
  encrypted live-web blob **after every successful import** and **on graceful app
  close** (proposal §5.4). Both triggers are individually toggleable in
  **Settings → Live web companion** and stay dormant until the master switch is
  on. Publishing is best-effort and never raises, so a publish hiccup can never
  break an import or block shutdown.
- **Public-repo security scrub (proposal §7).** Added `SECURITY.md` documenting
  the encrypted-blob trust model ("the ciphertext is public, the passphrase is
  everything"), `.gitignore` blocks so real broker exports / audit snapshots
  can't be re-added, "this repo is PUBLIC" guard-rail headers on
  `mobile_export.py` / `publish_service.py` (§7.4), and an automated
  public-readiness guard (`tests/test_public_readiness.py`) that fails if a
  secret or real-data file is ever tracked.

### Added — v3.0 live-web companion, Phase 3 "web hero"
- **Browser front-end (`web/`).** A Vite + TypeScript single-page app deployed
  to GitHub Pages that downloads the encrypted `portfolio.enc` blob, decrypts it
  **in the browser** with the mobile passphrase (WebCrypto PBKDF2-HMAC-SHA256 →
  AES-256-GCM, mirroring `storage/blob_crypto.py`), fetches live quotes (Twelve
  Data) and EUR FX (Frankfurter), and renders a live **Overview + per-holding**
  dashboard — total value, today's move, total gain, and XIRR (portfolio and
  per holding), all computed client-side.
- **Ported return maths with a parity suite.** `web/src/returns.ts` re-implements
  the `domain/returns.py` leaf functions (XIRR, CAGR, annualise, growth
  variants) on decimal.js. `web/test/returns.parity.test.ts` replays the
  committed `tests/parity/vectors.json` so the browser numbers can never silently
  drift from the desktop, and `web/test/crypto.test.ts` decrypts a committed
  golden envelope produced by the Python crypto to prove interop.
- **Setup + unlock UX.** A device-local setup screen stores the Twelve Data API
  key and data-source repository in `localStorage` (never in the repo); the
  passphrase is held in memory only and dropped on "Lock". NAV-only and
  last-known-price fallbacks are labelled explicitly, and gain/loss colours use
  a colourblind-safe blue↔orange palette.
- **CI + Pages wiring.** A new `web` job in `ci.yml` runs the typecheck, parity +
  unit tests, and production build; `pages.yml` now builds `web/` with Vite and
  publishes `web/dist`.

### Added — v3.0 live-web companion, Phase 2 "crypto + publish"
- **Encrypted publish pipeline for the browser companion.** New
  `services/publish_service.py` orchestrates export → encrypt → publish:
  it builds the minimized mobile export (Phase 1's
  `readmodels.build_mobile_export`), seals it into an AES-256-GCM envelope, and
  overwrites a single `portfolio.enc` asset on a fixed GitHub release so old
  ciphertext never accumulates in git history.
- **AES-256-GCM envelope crypto** (`storage/blob_crypto.py`): PBKDF2-HMAC-SHA256
  at 600,000 iterations, random salt/nonce per publish, ciphertext and tag
  stored separately so the browser's WebCrypto code can recombine and decrypt
  with zero JavaScript crypto dependencies. Tampering is detected on decrypt.
- **Keyring-backed secrets.** The mobile passphrase and the GitHub fine-grained
  PAT are stored in the OS keychain alongside the SQLCipher passphrase — never
  in the repo, `.env`, or logs.
- **New CLI `inv-dashboard-publish-web`** mirrors `inv-dashboard-export-snapshot`
  for manual/scheduled publishing, with `--refresh` and a `--output` dry-run
  that writes the encrypted blob to a local file.
- **Settings → Live web companion panel** captures the repo, passphrase, token
  and include-transactions toggle, and offers a "Publish now" button plus a
  last-published indicator.
- **New settings** (`INV_DASHBOARD_` prefix): `publish_enabled`, `publish_repo`,
  `publish_release_tag`, `publish_token`, `mobile_passphrase`,
  `publish_include_transactions`. All additive and off by default.
- New dependency: `cryptography>=48.0.1` for AES-GCM.

### Fixed — portable bundle first-start

Bug-fix work for the portable bundle's first-start experience.

- **First start no longer crashes with `no such table: app_config`.** A fresh
  install resolves to a split-DB layout (separate `ledger`/`config`/`cache`
  files), and the portable bundle ships no Alembic, so boot falls back to
  `create_all`. That fallback only built each tier's tables in its own file, so
  the ledger database had no `app_config` table — yet config-tier reads (the
  benchmark symbol, display currency, persisted storage paths) still run on the
  back-compat ledger session. The first page render therefore 500'd before the
  user could pick where their database goes. Boot now mirrors Alembic migration
  0001 and builds the full schema on the ledger database, so those reads
  resolve. `create_all` stays idempotent, so existing installs are unaffected.

### Changed
- **The live-web companion now works out of the box — no `[encrypted]` extra
  needed.** The OS-keychain dependency (`keyring`), used to store the mobile
  passphrase and GitHub publish token, moved from the optional `[encrypted]`
  extra into the core dependencies. The `[encrypted]` extra is now *only* the
  SQLCipher driver (`pysqlcipher3`) for optional encryption-at-rest of the local
  synced database tiers. Keychain-related UI messages no longer tell you to
  install an extra.
- **The portable ZIP extracts much faster.** The bundle is now slimmed before
  zipping — bundled `pip`/`setuptools`/`wheel` (unused at runtime; the portable
  launcher never self-updates) and all `__pycache__` bytecode caches
  (regenerated on first import) are pruned, and the archive uses optimal
  compression. This removes thousands of tiny files, the main cause of the slow
  unzip.

### Added — broker import: structured per-row reporting (audit D2–D5)
- **Imports no longer abort on the first bad row (D3).** The Fidelity / Vanguard
  CSV and Vanguard XLSX parsers now collect per-row problems into a structured
  `ParseReport` and keep going, so a single unknown transaction type no longer
  discards an otherwise-good 100-row import. Skipped rows (with their source
  line numbers) are reported in the Transactions import summary.
- **Light row validation (D4).** Parsed rows are checked for a non-negative
  price and that `amount ≈ quantity × price` (± fees) on trade rows; failures
  are surfaced as warnings while the row is still imported.
- **US-locale assumption documented and enforced (D5).** Decimal/date parsing
  is centralised in `adapters/locale_parsing.py`; an EU-locale value (comma
  decimal, `DD/MM` date) now raises `LocaleError` and is reported per-row
  instead of being silently mis-parsed.
- **Unresolved symbols surfaced (D2).** When the data provider returns nothing
  for a symbol (delisted, a typo, or offline), the enrichment service reports it
  and the importer lists it under `unresolved_symbols` in the import summary.

## [2.11.0] — 2026-05-31

Performance pass: the same numbers, computed with far fewer round-trips, and
the heavy historical rebuild moved off the page-render thread. The trading-day
live-price refresh is unchanged — intraday prices keep updating exactly as
before.

### Changed
- **Daily equity curves load in bulk instead of day-by-day.** The Overview
  value-over-time chart and the Analytics equity curve previously walked the
  selected range one calendar day at a time, and *each* day reopened a
  cache-tier session for the snapshot **and** reloaded the entire EUR→display
  FX rate series — roughly 365 cache sessions and 365 full FX scans for the
  default one-year view, all on the request thread. A new
  `snapshots_service.series_in_currency` reads every cached snapshot in the
  window in a single query, loads the FX series once, and only recomputes the
  days genuinely missing from the cache. The plotted values are identical; only
  the round-trips change (`services/snapshots_service.series_in_currency`,
  `ui/pages/_overview_query.build_value_series`,
  `ui/pages/_analytics_query._build_curve`).
- **The snapshot cache is warmed in the background after a refresh.** The
  deferred network refresh drops every cached daily snapshot once fresh prices
  and FX land, so the *first* Overview/Analytics render used to rebuild the
  whole history day by day on the UI thread — the slow first load (and the
  occasional "connection lost"). A new `_warm_snapshots()` boot step now
  recomputes that history over the portfolio lifetime on the post-boot
  background thread, so the first render reads cached values
  (`boot._warm_snapshots`, `services/snapshots_service.warm_range`).
- **Each page navigation opens one chrome session instead of three.** The
  shared `page_frame` header/sidebar read the theme, onboarding gate, display
  currency, and clock in three separate transactions on every tab switch; they
  now share a single session (`ui/layout.page_frame`).

## [2.10.2] — 2026-05-31

Fixes the "vs market" comparison and the empty analytics benchmark overlay, and
removes a double-count that inflated the portfolio XIRR.

### Fixed
- **Benchmark history was invisible in split-DB mode.** `benchmark_service`
  read and wrote the benchmark's close series through the *ledger* session, but
  `price_history` is a cache-tier table — so split-DB installs saw only a
  handful of closes (whatever happened to be in the ledger copy), collapsing the
  analytics comparison curve onto the x-axis and starving the "vs market"
  verdict. `get_series`/`refresh_history` now route through
  `cache_read_session`/`cache_write_session` like the rest of the price feed
  (`services/benchmark_service`).
- **Benchmark history is now backfilled over the portfolio lifetime.** Boot
  never called `refresh_history`, so benchmarks the user doesn't already hold
  had no curve at all. A `_refresh_benchmark()` step now runs in both the
  synchronous and deferred network-refresh paths, fetching from the earliest
  transaction date (`boot`).
- **"Vs market" is now an apples-to-apples XIRR comparison.** The verdict
  compared the portfolio's *legacy simple* growth (`(V−C)/C`) against a raw
  two-close price move of the benchmark — two different methods over two
  different horizons, which is what produced the nonsensical "66 % vs 2.87 %".
  It now simulates the portfolio's own external contributions into the benchmark
  and compares the resulting **benchmark XIRR** against the **portfolio XIRR**,
  expressing both as the compounded total growth `(1 + XIRR) ^ years − 1` the
  overview already headlines (`services/benchmark_service.simulate_benchmark_xirr`,
  `ui/pages/_overview_query.compute_market_verdict`, `ui/pages/overview`).
- **Distributions swept into in-portfolio settlement funds no longer inflate
  XIRR.** Dividends/interest paid into a money-market settlement fund
  (VMFXX/SPAXX) are already captured by that fund's terminal value; counting
  them again as XIRR outflows double-counted the cash. Accounts that hold a
  money-market fund are now treated as cash-retaining
  (`services/metrics_service`).

## [2.10.1] — 2026-05-31

Investigates the residual ~8–10 % gap between the developer audit export and the
authoritative `Investments.xlsx` historic balances, and adds a UI flag for
instruments whose cached price feed is corrupt.

### Added
- **Inaccurate-price-history warning.** When an instrument's cached price
  history contains a non-positive (zero or negative) close — a value yfinance
  occasionally returns for a missing print, which then forward-fills into every
  historical valuation that lands on it — the Overview now shows a red banner
  naming the affected symbols, and the audit export carries a
  `price_data_warning` flag per position. This is distinct from the existing
  zero-*value* warning (which only catches a holding worth zero *today*): the
  new flag surfaces instruments whose *past* numbers are silently understated
  (`prices_repo.instrument_ids_with_nonpositive_close`,
  `prices_service.instruments_with_price_anomalies`, `ui/pages/overview`,
  `ui/pages/_overview_query`, `readmodels/overview`).

### Investigated
- **Historic divergence root cause (split back-adjustment).** The remaining
  divergence is traced to stock splits: yfinance returns *split-adjusted*
  (back-adjusted) closes for all history, but the ledger applies a split as a
  share-count change only on the split date. For any date *before* a split the
  dashboard multiplies the pre-split share count by the post-split-adjusted
  (smaller) price, understating that holding by the split ratio. The two splits
  in the data (SCHK 2:1 on 2024-10-11, VUG on 2026-04-21) each leave a visible
  step in the spreadsheet-vs-dashboard gap, and the gap vanishes once both
  splits are reached — fully explaining the historic understatement. The fix is
  scoped in `docs/history/v2.10.1-plan.md` and shipped below (Option A).

### Fixed
- **Split back-adjustment in historical valuation.** Past-date holdings are now
  valued on the same adjustment basis as the price feed: when valuing an
  as-of date, the share count is scaled by the cumulative split factor of every
  split that occurs *after* that date, so a pre-split date multiplies the
  *adjusted* share count by yfinance's *adjusted* close instead of understating
  the holding by the split ratio. The today path (no future splits ⇒ factor 1)
  and money-market par-pricing are unchanged, and cached daily snapshots are
  already cleared on each boot refresh so historic closing values recompute.
  This closes the ~8–10 % historic gap on `SCHK`/`VUG` against `Investments.xlsx`
  (`services/positions_service.compute_positions`).
- **Splits are corrected even for instruments sold before the split.** The split
  factor is now sourced from the market-data feed's authoritative corporate-action
  history, not only from ledger `split` rows. A split that happens *after* the
  user sells a holding never appears as a ledger row (brokers only record splits
  for shares you still hold), yet yfinance still back-adjusts that instrument's
  whole price history for it — so previously-owned tickers like `SCHD`/`VGT`
  were understated on every date they were held. A new device-local
  `price_split` cache table is populated on each boot refresh
  (`prices_service.refresh_splits`, `adapters/yfinance_client.fetch_splits`),
  and historical valuation prefers the feed factor
  (`prices_service.cumulative_split_factor_after`), falling back to the ledger
  `split` rows only when no feed data is cached yet (offline-safe). Repointing an
  instrument's ticker now also invalidates its cached splits
  (`models/price_split`, `repositories/splits_repo`, migration `0008`).



Reconciles the developer audit export with the authoritative `Investments.xlsx`
after it diverged on four distinct valuation defects, plus two UX/robustness
improvements.

### Added
- **Show settlement sweeps toggle.** Auto-generated Vanguard settlement legs
  (`external_id … :vmfxx`) are now hidden from `/transactions` by default via a
  new `LedgerFilters.hide_settlement_sweeps`, with a **Show settlement sweeps**
  toggle to bring them back. They remain in the ledger, so VMFXX valuation is
  unchanged (`ui/pages/_ledger_query`, `ui/pages/transactions`).

### Fixed
- **Fidelity share distributions are no longer booked as dividends.** Schwab's
  2-for-1 `SCHK` distribution arrives as `DISTRIBUTION, Type=Shares, blank
  price, qty=26.1` and was mapped unconditionally to `dividend_cash` — dropping
  the shares and inventing a ~$728.97 dividend. The `Type=Shares` form (non-zero
  qty, no price) is now reclassified to `split`; genuine cash dividends
  (`Type=Cash`, qty 0) are untouched. Alembic `0007` repairs already-imported
  rows so `SCHK` resolves to 53.145 shares and the 2024 dividend spike is removed
  (`adapters/fidelity/parser`, migration `0007`).
- **Single dividend-income definition.** Dividend income is now recognised once
  per distribution: reinvested legs valued at `quantity × price` (capturing VMFXX
  interest whose cash leg is `$0`), paired cash legs skipped, and un-reinvested
  cash counted. Metrics separate **income** (KPI / yield / yearly) from
  **realized cash** (capital-gain add-back), which previously double-counted
  reinvested dividends (`domain/dividends`, `metrics_service`).
- **Withdrawal sign convention.** The deposits and period queries re-subtracted
  already-negative withdrawals (effectively adding them) while `metrics_service`
  netted them correctly. All paths now net withdrawals once, correcting
  contributions, net flow, growth % and XIRR (`_deposits_query`,
  `_period_query`).
- **Historic valuation leading-gap backfill.** Price / FX refresh only extended
  the cache forward, so a cache starting later than the earliest needed date left
  early months valuing holdings at zero (~11–13% understatement). Refresh now
  refetches from the earliest needed date when a leading gap exists
  (`prices_repo.earliest_price_date`, `fx_repo.earliest_rate_date`,
  `prices_service`, `fx_service`).
- **Early non-reinvested dividends.** Income recognition now treats a
  `dividend_cash` row with no paired reinvest on the same
  `(account, instrument, date)` as income, covering the early cash-dividend
  period (`domain/dividends`).

## [2.9.8] — 2026-05-31

### Added
- **Developer audit export.** Settings → Developer tools can now download the
  full dashboard snapshot — the same read-model the mobile API serves, covering
  overview KPIs and positions, deposits, the raw ledger, the monthly/yearly
  period tables, analytics and the calculator — as a pretty-printed JSON
  document for offline reconciliation. The panel is gated behind a configurable
  developer password (`INV_DASHBOARD_DEV_PASSWORD`), verified with a
  constant-time comparison, and stays hidden/inert when no password is set
  (`services/audit_export_service`, `ui/pages/settings`, `config`).

## [2.9.7] — 2026-05-31

Follow-up to the 2.9.6 valuation bundle: makes preset/imported instruments
fully editable, surfaces held-but-unpriced holdings, and stops money-market
funds showing an inconsistent single-day growth.

### Added
- **Zero-value warning.** When a holding has shares but values to `0` because
  no price could be sourced (e.g. a ticker that stopped pricing), the Overview
  now shows a red banner naming the affected symbols — that state is abnormal
  and understates every downstream total, growth and allocation figure, so the
  numbers can't be trusted until it prices again (`positions_service`,
  `_overview_query.position_rows`, `ui/pages/overview`).

### Fixed
- **Instrument ticker & native currency are now editable.** The Settings →
  Instruments editor only exposed name / asset class / category / TER, so a
  preset or imported line that resolved to the wrong ticker (e.g. a DAX line
  that never priced) could not be repaired from the UI. Symbol and native
  currency are now editable; changing the symbol clears that instrument's
  cached closes so the next refresh repopulates from the new ticker
  (`instruments_repo.update_instrument`, `prices_service`, `ui/pages/settings`).
- **Money-market / settlement funds no longer show an inconsistent daily
  growth.** `SPAXX` / `VMFXX` have no price feed, so their single-day growth
  rendered as an em dash while their other figures were computed — looking
  "strange" next to each other. The par NAV does not move, so their daily
  growth is now a flat `0` in both currencies (`_overview_query`).
- **Re-seeding repairs drifted preset metadata.** An instrument an import had
  created with stub metadata (e.g. `unknown` asset class, no name, no TER) is
  now corrected to the canonical preset facts on the next *seed defaults* run;
  deliberate user customisations are left untouched (`onboarding_service`).

## [2.9.6] — 2026-05-31

Bug-fix bundle for portfolio valuation accuracy: partial-sale growth, money-
market settlement funds, Vanguard cash sweeps, reinvested-dividend
double-counting, and the DAX ticker.

### Fixed
- **Partial sales no longer deflate growth.** A sale released no cost basis, so
  after selling part of a holding the remaining shares kept the *full* original
  basis and the reported growth collapsed. Sales now release a proportional
  slice of the cost basis (average-cost method) in the native, EUR, and USD
  views (`positions_service.compute_positions`,
  `_overview_query.compute_instrument_metrics`).
- **Money-market / settlement funds value at par.** `VMFXX`, `SPAXX`, and peers
  have no tradeable price feed, so their positions valued at `0` — which
  understated monthly/yearly **closing values** by the whole uninvested-cash
  balance and gave the funds an absurd >1000 % growth. They are now priced at
  their constant $1.00 NAV (`domain/money_market.py`).
- **Vanguard deposits sweep into the settlement fund automatically.** The
  Full-History export drops the internal "Sweep In/Out" rows, so uninvested
  cash was invisible. The importer now reconstructs the `VMFXX` settlement legs
  deterministically — deposits/sales/dividends flow **in**, security buys flow
  **out** — so the settlement holding matches what you actually hold
  (`adapters/vanguard/settlement.py`). Fidelity is unaffected (it exports
  `SPAXX` explicitly).
- **Reinvested dividends are no longer double-counted.** A reinvested dividend
  arrives as a cash leg *and* a reinvestment leg; the cash leg was added to
  income while the new shares were also counted, inflating the gain. The cash
  leg of a reinvested dividend is now excluded from cash-dividend income.
- **DAX (and any `EXCHANGE:TICKER` symbol) resolves on yfinance.** A symbol
  pasted as `NASDAQ:DAX` was queried verbatim and failed to price. A recognised
  exchange prefix is now stripped to the bare ticker
  (`ticker_validation_service.normalize_symbol`).

### Notes
- Fidelity `SPAXX` reinvested-dividend shares (e.g. 12.23) faithfully reflect
  the reinvestment rows in the export; the par-pricing and double-count fixes
  bring its growth back to a sane value, but the share count itself mirrors the
  source data.

## [2.9.4] — 2026-05-31

A maintenance round driven by an internal audit: fixes a family of latent
FX-conversion bugs, restores `^IRX` as the default risk-free symbol (with a
resilient fetch), corrects the documentation, and clarifies that near-real-time
intraday quotes are a supported feature.

### Added
- **Daily-snapshot time-weighted return** (`/monthly`, `/yearly`). When daily
  portfolio snapshots exist inside a period, the growth % now chains each
  sub-period's Modified-Dietz return (`Π(1+rᵢ)−1`) instead of approximating the
  whole period with a single flow — so a contribution made between two market
  swings no longer averages the swing away. Degrades to the old single-period
  calc when daily values are sparse (`_period_query`, `snapshots_service`).
- **Dividend-yield KPI** on `/overview` (`cash dividends ÷ closing balance`),
  completing the spreadsheet's `Total` block parity (`metrics_service`,
  `readmodels/overview`, `ui/pages/overview`).
- **Instrument metadata auto-populate.** The Settings "Add instrument" dialog
  gained a *Fetch from market data* button that fills asset class, category,
  expense ratio, name and native currency from yfinance, so those fields are no
  longer hand-typed (`instrument_enrichment_service.suggest_instrument_fields`,
  `adapters/yfinance_client`, `ui/pages/settings`).
- **`transfer_in` / `transfer_out` transaction kinds** are now counted as
  external cash flows (in like a deposit, out like a withdrawal) across metrics,
  deposits and the monthly/yearly aggregation (`metrics_service`,
  `_period_query`, `_deposits_query`).
- **Encryption passphrase onboarding + recovery file.** Settings → Storage and
  the first-run onboarding page now collect the SQLCipher passphrase for the
  synced ledger/config tiers and store it in the OS keychain
  (`store_passphrase_in_keyring`), so the `INV_DASHBOARD_DB_PASSPHRASE` env var
  is no longer the only way to supply it. Both surfaces also offer a downloadable
  **recovery file** (`storage.encryption.build_recovery_file`), closing the
  "encrypted-mode users have no key-recovery path" gap from the v2.0 storage plan.
- **Settings "Move ledger…" picker.** Settings → Storage can now physically
  relocate the ledger and config database files to a folder of your choice. The
  move takes a rolling backup, copies each file with an integrity check, swaps it
  into place atomically, removes the originals (sidecars included), persists the
  new tier paths to `app_config`, and prompts for a restart — implementing the
  v2.0 plan's §4.4 "Move ledger…" flow (`storage/move.py`, `ui/pages/settings`).

### Fixed
- **USD figures no longer silently relabel EUR as USD when an FX rate is
  missing.** Overview instrument/portfolio metrics and the monthly/yearly period
  tables now degrade the USD column to a blank (`—`) instead of showing the EUR
  amount under a USD label (`_overview_query`, `metrics_service`,
  `_period_query`). XIRR/growth/YTD in USD are suppressed alongside the value so
  no metric is computed against a mislabelled terminal value.
- **Per-currency FX conversion.** Positions and cash balances now convert each
  non-EUR account with its *own* EUR→native rate instead of reusing the USD
  rate for every currency (`positions_service`). Harmless today (only EUR+USD
  are live) but correct for any future currency.
- **CAGR of a total loss** (`end_value == 0`) now returns a well-defined −100 %
  instead of `None` (`domain/returns.py`).
- **Future (not-yet-started) periods** report `None` growth instead of running
  Modified-Dietz on forced-zero balances (`_period_query`).
- **Unconvertible cashflows** are left out of a period bucket (`None`) rather
  than folded in as `0`, which had shrunk the Modified-Dietz denominator
  (`_period_query`).
- **Split-DB migrations now stamp every tier.** Boot records the Alembic
  revision in each tier's own `alembic_version` table (not just the ledger),
  so a future config/cache-tier migration is applied instead of silently
  skipped for split-DB users (`boot.py`).

### Changed
- **Default risk-free symbol is `^IRX` again** (13-week US T-bill yield). The
  earlier switch to `^TNX` was a workaround for `yfinance.download` returning
  empty frames for `^IRX`; the real fix is a `Ticker.history` fallback in
  `yfinance_client.fetch_latest_close`, so `^IRX` now fetches reliably and no
  symbol-rewriting deprecation shim is needed.
- **Near-real-time intraday quotes are a documented goal, not a non-goal.**
  ETF/stock prices already refresh roughly every two minutes during market
  hours; the docs/comments that described prices as "end-of-day only" have been
  corrected (`requirements_and_project_overview.md`, `docs/user_guide.md`,
  `models/price_history.py`).

### Removed
- **Dead/uncalled helpers** confirmed unreferenced by the audit: the
  single-file `get_engine` / `get_session_factory` accessors (`db.py`),
  `snapshots_repo.list_snapshots`, `transactions_repo.delete_transaction`,
  `transaction_fx_service.list_accounts_currency_map`,
  `encryption.driver_available`, and `money_format.fmt_pair`. No call sites
  remained, so removing them shrinks the surface without behaviour change.

### Docs
- Brought `README` status, `docs/user_guide.md` (pages, risk-free, editable
  storage folder), `docs/architecture.md` / `CONTRIBUTING.md` (UI may read
  repositories directly), and `requirements_and_project_overview.md` (3-tier
  storage, standalone projection page, historical roadmap) back in line with the
  code. Refreshed the in-app **Help** page so the Storage entry lists the
  sync-folder, move-ledger, passphrase and recovery-file controls instead of the
  stale "nothing here is editable" note (`ui/pages/help`). Marked the
  fully-shipped v2.0/v2.2/v2.8 plan docs as historical.
- Normalised the changelog: every prior `— Unreleased` heading now carries its
  release date.

## [2.9.3] — 2026-05-31

Adds a robust way to stop the local server and release the single-writer lock,
so the packaged desktop build no longer has to be killed from Task Manager (and
no longer strands the writer lock held against a cloud-synced ledger).

### Added
- **Clean shutdown + writer-lock handoff** (`investment_dashboard.shutdown`).
  Settings → **Server** gains three controls: **Shut down server** (releases the
  lock and stops the process), **Release writer lock** (drops this window to
  read-only so another instance — e.g. another device — can take over writes
  without stopping the server), and a **"Quit when I close the last tab"** toggle
  that auto-stops the server a short grace period after the final browser tab
  disconnects (the grace period ignores the brief disconnect from in-app
  navigation). The writer lock is now *always* released on server shutdown via
  an `app.on_shutdown` hook (`boot.release_writer_lock`), regardless of how the
  server stops. The tab-close default is configurable with
  `INV_DASHBOARD_SHUTDOWN_ON_TAB_CLOSE`; the in-app toggle is persisted and
  wins over the env default.

## [2.9.1] — 2026-05-31

Fixes the monthly/yearly value calculations that the v2.8 attempt left broken,
makes the period tables single-currency (matching the overview), and brings the
table typography back down to a readable size.

### Fixed
- **Closing values were `0` for every month and year.** The web UI opens before
  the deferred FX/price backfill finishes, so the first render of `/monthly` and
  `/yearly` computed each period's closing value against an empty price + FX
  cache and persisted those zeros as daily snapshots. Nothing ever invalidated
  them, so the zeros stuck permanently and every downstream figure (growth %,
  Total Growth, the yearly value line) was wrong. Boot now clears the snapshot
  cache after the FX/price refresh (`boot._invalidate_snapshots` /
  `snapshots_service.invalidate_all`), forcing each period to recompute against
  the now-complete history. Portfolio value at a past date is therefore a robust
  function of each holding's quantity, its as-of close, and the trade/period FX
  rate.

### Changed
- **Monthly & Yearly tables now show one currency at a time**, flipped by the
  header currency toggle — the same decision the overview table adopted — instead
  of carrying an EUR+USD pair for every money column. EUR ⇄ USD conversion is
  exercised on every column (money companions in both currencies, period growth
  and Total Growth per currency) so either currency reads correctly and
  completely, with no empty/`0` EUR cells.
- **Period growth is now per currency** and **Total Growth is the last column**
  on both period tables (previously Total Growth sat before a single, shared
  Growth % column).
- **Table typography dialed back** from the oversized v2.8.1 values (18px text /
  62px rows) to a roomy-but-sensible 15px text / 44px rows with 12px headers.
  Long column titles now wrap onto two lines (`wrapHeaderText` /
  `autoHeaderHeight` plus header white-space CSS) so a column's numbers and its
  header both stay fully readable.

## [2.9.0] — 2026-05-31

Makes trade-date FX values **persistent** instead of re-derived on every
render, and flips the stored perspective so the **native** leg (almost always
USD) is frozen verbatim and EUR is derived. Once a transaction is booked its
currency legs never need recomputing — only today's value (and capital gain
derived from it) stays live.

### Added
- **`transactions.net_usd`** column (Alembic migration `0006`): every cash
  movement now stores *both* frozen legs — `net_eur` and `net_usd` — valued at
  the EUR→USD rate on the row's own trade date. For USD-native accounts
  `net_usd` is the booked amount verbatim (no FX round-trip); EUR is derived.
  Existing rows are backfilled by the migration, and on packaged installs (no
  Alembic) a boot-time column guard adds the column and a backfill pass fills
  the legs.
- **Safe-FX import.** The importer now ensures FX history actually covers the
  earliest trade *before* freezing any leg, retrying the refresh so a transient
  network/server glitch can't bake in a wrong or missing rate. Any unresolved
  gap is reported back to the user, and the affected legs stay re-derivable.
- **Settings → "Recalculate FX-derived values"** forces a full rebuild of every
  transaction's frozen legs from current FX history — use it after a partial
  import or once FX data has been corrected.

### Changed
- **Manual transaction entry** now freezes both currency legs on save (it
  previously stored neither), so manual rows match imported ones.
- **Read paths** (overview, deposits, ledger, monthly/yearly periods,
  portfolio KPIs/XIRR) prefer the stored legs and only fall back to live FX
  derivation for rows still missing a value, removing the repeated full
  FX-history load on the common path.

## [2.8.2] — 2026-05-31

Patch fixing the **currency / FX math** that regressed in v2.8 (v2.8.1 is the
parallel UI overhaul). The unifying rule: store the **native** amount (almost
always USD) and always derive the *other* currency from the EUR→USD rate **of
the row's own trade/deposit date** — never current spot, never parity. All
money is rounded to the cent and every percentage is rendered as a rounded
percent.

### Fixed
- **Transactions & Deposits FX.** Both pages now compute the converted value
  from the exchange rate of the transaction/deposit date via the shared
  `domain.currency.dual_currency_amounts` helper. This fixes deposits showing
  USD and EUR at parity and transactions leaving the EUR column empty when a
  manually entered row had no stored `net_eur`.
- **Overview cost basis** is now accumulated **transaction by transaction** at
  each trade's own FX rate (not a single current rate) and rounded to the cent
  in both wallets.
- **Overview capital gain** is rounded to the cent and computed as today's value
  (at today's FX) minus the trade-date cost basis. The redundant "native"
  column was removed — native is USD, shown in the USD view.

### Changed
- **One currency at a time.** Every Overview money/percentage value is computed
  per currency but the table renders only the active display currency; the
  header toggle flips the whole table. This keeps the grid compact.
- **Total Growth and XIRR are now per currency** and shown as rounded
  percentages rather than a single raw decimal.

### Added
- **Per-instrument Daily Growth** column in the Overview positions table, per
  currency (mirroring the top-of-page daily-growth KPI).

## [2.8.1] — 2026-05-31

Follow-up patch tightening the **Overview** page polish that v2.8 set out to
deliver, plus a table-readability and timezone fix that span the whole app.

### Changed
- **Unified Overview KPI grid.** The KPI tiles previously sat in two
  ragged flex-wrap rows that left mismatched sizes and uneven gaps. They now
  share one responsive CSS grid (`.inv-kpi-grid`) so every card is the same
  width, lines up in tidy columns, and keeps a uniform headline size — the
  big value font was trimmed (2rem → 1.6rem) so long figures stay on one
  line instead of wrapping.
- **YTD → MTD → Daily ordering.** The three period-growth cards are now kept
  adjacent and in that order so they read as a consistent group.
- **Modern, larger tables.** Every AG-Grid table (Overview, Transactions,
  Deposits, Monthly, Yearly, Calculator, Projection) was restyled for
  readability: a larger 18px data font, taller rows with vertically-centred
  cells, more cell padding, a tinted uppercase header band over a crisp 2px
  rule, subtle zebra striping on alternating rows, and an accent-tinted row
  hover — so the tables read as crisp, stylish and modern rather than thin,
  flat and faint.
- **Header clock follows your timezone.** The header timestamp no longer
  hard-codes UTC. It defaults to this computer's local timezone and can be
  pointed at any IANA zone (or UTC) from the new **Timezone** picker under
  Settings → Display preferences, persisted via `timezone_service`.
- **Better portfolio-value chart.** The Overview "Value over time" graph now
  renders the way mainstream investing apps do: a soft accent area under the
  line, a money-formatted left axis with a currency prefix and visible tick
  marks, an adaptive date axis, a unified hover read-out, and a horizontal
  spike line for reading a value off any date.

### Removed
- **Duplicate gain line on Total Growth.** The Total Growth KPI no longer
  repeats the capital-gain money as a sub-line — that figure already has its
  own dedicated **Capital Gain** card.

## [2.8.0] — 2026-05-31

This release lands the full **v2.8 whole-app cleanup** — a broad sweep of
correctness and UX fixes spanning Overview, Deposits, Transactions, Monthly,
Yearly, Projection, Analytics, Settings and onboarding. The work was delivered
as one branch / one PR organised into seven themed steps; the step-by-step
plan and root-cause analysis live in `docs/history/v2.8-cleanup-plan.md`.

### Added
- **Standalone Projection page.** The interactive dual-currency projection
  tool — previously embedded *identically* on both `/monthly` and `/yearly`
  — now lives in exactly one place on its own `/projection` route, wired into
  the navigation and router. A Yearly/Monthly granularity toggle rebuilds the
  seed and re-renders the forecast in place, the EUR and USD cones each carry
  proper chart **axis titles**, and the "Total contributed" line was renamed
  to **"Additionally contributed"** to make clear it is future, not
  historical, money.
- **Validated ticker selection (`ticker_validation_service`).** A new service
  confirms that a free-form symbol actually *resolves and prices* on the
  market-data provider before it is written to the ledger — a symbol is only
  accepted when the provider returns recognisable metadata **and** at least
  one recent close. The resolved name / asset class / native currency are
  returned so the UI can pre-fill the add form and the user can eyeball the
  match (e.g. confirm "Global X DAX Germany ETF" rather than a German-listed
  clone). Onboarding and Settings both gate on this so a typo or wrong-exchange
  suffix can no longer seed an instrument that never prices.
- **Cloud / sync link picker in onboarding.** The OneDrive/cloud sync folder
  can now be chosen *during* onboarding alongside the benchmark / portfolio
  ETF, in addition to being editable later in Settings.
- **Editable cloud / sync folder in Settings.** The sync-folder path is now a
  writable field that persists `ledger_path` / `config_path` into the
  config-tier `app_config` table, overriding the auto-detected cloud folder on
  the next launch; clearing it falls back to auto-detection.
- **Transactions summary KPIs.** The Transactions page gained a summary strip
  — total transaction count, buy count, sell count, and dual-currency average
  trade size — via the new `summarize_ledger()` query.
- **Daily growth metric.** `PortfolioMetrics` gained dual-currency
  `daily_growth_pct{,_usd}` plus `daily_growth_as_of`: single-day portfolio
  growth measured on the most recent *completed* trading day (the latest date
  any held instrument repriced), so it skips weekends / holidays and tolerates
  the one-day NAV lag of mutual funds versus ETFs. Backed by a new
  `prices_repo.recent_price_dates()` helper.
- **MTD growth in USD.** `PortfolioMetrics.mtd_growth_pct_usd` adds a USD
  parallel to the existing EUR month-to-date figure, valuing the month's
  external flows at per-trade-date FX, so the Overview MTD card now reports
  both currencies.
- **As-of pricing helper.** `prices_repo.close_as_of()` returns the most
  recent close on or before a given date (forward-filling across weekends /
  holidays / sparse history), the building block that makes historical
  valuations price past dates with past prices.
- Regression tests for historical (as-of) valuation, the Overview value
  series, single-symbol grouped yfinance frames, and ticker validation.

### Changed
- **Overview page redesign.** Cards were reordered to put **Total Value
  first** and **Total Growth second**, and Total Growth now shows actual
  compounded growth % rather than echoing total value; the legacy **Simple
  Growth** KPI was removed. XIRR / YTD / MTD / Daily are rendered as
  dual-currency cards with the display currency large and the other currency
  shown smaller as a secondary line, coloured / arrowed by the primary sign.
  The allocation treemap now rounds values to the cent (`ROUND_HALF_UP`), and
  the positions table exposes numeric per-currency columns so each currency
  sorts independently, alongside per-row growth / XIRR / YTD-growth stats.
- **Equal-height KPI cards and more readable tables.** KPI cards were unified
  to consistent value / label / secondary sizing across the app, and table
  fonts were bumped to a readable-but-compact modern size.
- **Monthly table paginates per calendar year.** The Monthly view now shows
  one whole calendar year per page via `aggregate(fill_gaps=True)`, padding
  the empty Jan/Feb 2023 buckets (investing started March 2023) so each year
  renders complete.
- **Yearly chart is now a cumulative value line.** The per-year **bar** chart
  was replaced with a cumulative **value-over-time line** chart with proper
  axes.
- **Slimmer Monthly & Yearly KPIs.** The redundant top "main" KPIs and the
  "Periods" / "Years" count KPIs were dropped from both pages.
- **Settings layout.** The **Reset data** action was moved to the last
  settings section, and the DAX preset was confirmed as "Global X DAX
  Germany".

### Fixed
- **Benchmark and market-data lookups.** Single-symbol yfinance downloads
  assumed an ungrouped frame, but `group_by="ticker"` returns a column
  `MultiIndex` even for one ticker — so every single-symbol fetch raised a
  silently-swallowed `KeyError`. This single bug was the root cause of all
  Analytics benchmark failures **and** the stale VT ~2.2 "Beating the market"
  number on Overview; `_download_window` now branches on the actual column
  shape so both grouped and ungrouped frames resolve.
- **Historical valuation and period math.** Past-date portfolio values now use
  the close *and* FX history that were actually in effect on each as-of date
  (via `positions_service` + `prices_service.close_as_of`), which corrects the
  YTD sign, the month-to-date / year closing balances, and the Overview
  value-over-time curve — these previously leaked today's price into every
  historical point.

### Removed
- **The "interest" concept on Deposits.** The erroneous interest kind, summary
  fields (`interest_ytd_eur` / `interest_ytd_usd`), readmodel keys and KPI were
  removed — Deposits is a contributions view, not an interest-bearing account.

### Notes
- Several originally-reported items — per-trade-date FX across Deposits /
  Transactions / metrics, the removal of the silent `Decimal(1)` spot
  fallback, and historical share-count closing balances — were already
  corrected by earlier work on this branch (v2.4–v2.5) and are **verified**
  here rather than re-implemented.

## [2.7.2] — 2026-05-31

### Added
- **The installed launcher now writes a diagnostics log so a failed start is
  no longer invisible.** The Start-menu / Desktop shortcut (and the portable
  `.cmd`) run the app via `pythonw.exe`, which has **no console** — so every
  message and crash traceback from the launcher, `pip`, and NiceGUI/uvicorn
  was silently discarded, making "installs fine but never runs" impossible to
  diagnose. Both `installer/launcher.py` and `installer/portable_launcher.py`
  now mirror all output to a `launcher.log` file (in
  `%LOCALAPPDATA%\InvestmentDashboard\` for the installed app, next to the
  portable `.cmd` for the bundle), record the runtime environment (Python
  version/path, platform, install location, installed dashboard version) up
  front, and catch **every** startup failure — failed update checks, import
  errors, and crashes while the web server starts (e.g. port 8080 already in
  use) — writing a full traceback instead of dying with no trace. Set
  `INV_DASHBOARD_LAUNCHER_DEBUG=1` to raise the app log level to `DEBUG`. See
  `docs/windows_install_troubleshooting.md` for the bug-test plan.
- **The release now tests the real Windows installer `.exe`.** PyInstaller
  produces `InvestmentDashboard-Setup.exe` only on the release runner, so
  packaging regressions (a missing bundled wheel, a missing `launcher.py`
  data file, broken frozen imports) were invisible until an end-user ran
  the download — which is exactly how earlier releases shipped broken. The
  bootstrapper gained an offline self-test mode (`INV_DASHBOARD_INSTALLER_SELFTEST`)
  that makes the frozen executable verify it can extract and resolve its
  bundled dashboard wheel and `launcher.py` from its own one-file bundle,
  and the release workflow now runs the freshly built `.exe` in that mode
  immediately after building it. A non-zero result fails the release, so a
  broken installer can no longer be published. Verified locally by freezing
  the exact `installer/installer.spec` and running the frozen binary, which
  resolved the bundled `investment_dashboard-2.7.2` wheel and `launcher.py`
  and reported `SELF-TEST OK`.

### Fixed
- **Installer and portable bundle verified working end-to-end.** The
  Windows one-file installer (`InvestmentDashboard-Setup.exe`) and the
  portable bundle (`InvestmentDashboard-Portable.zip`) were re-tested top to
  bottom against a freshly built wheel: the standalone `launcher.py` /
  `portable_launcher.py` import with **no** `installer` package on
  `sys.path`, boot creates the full schema via the `create_all` fallback
  when Alembic is unavailable, and the dashboard server starts and serves
  `/` and `/overview` successfully. This is the first release in which both
  distribution channels are confirmed fully functional.

### Fixed (carried over from 2.7.1)
- **Installed app now starts (release flow works end-to-end).** Two
  release-only bugs that left the installed program broken on launch are
  fixed:
  - The steady-state `installer/launcher.py` is copied **standalone** into
    the install root, but it imported the `installer` package (`installer.paths`,
    `installer.version`) which is never installed there — so every launch
    died with `ModuleNotFoundError: No module named 'installer'`. The
    launcher is now fully self-contained, depending only on the standard
    library and the installed `investment_dashboard` wheel.
  - A freshly installed app created **no database tables**: the wheel does
    not ship `alembic.ini` or the `migrations/` tree, so boot skipped
    migrations and every page failed with `no such table`. Boot now falls
    back to creating the current schema with `create_all` across all storage
    tiers when Alembic is unavailable (the packaged installer / portable
    bundle), while continuing to run real Alembic migrations in a developer
    checkout. Verified end-to-end by installing the wheel into an isolated
    interpreter and launching exactly as the desktop shortcut does.

### Added
- **Faster startup with a responsive loading experience.** The dashboard
  now serves its UI immediately on launch instead of blocking the console
  while it downloads FX rates and prices. The slow, best-effort network
  refresh runs on a background thread after the server is up; the page
  renders from cached data and updates as fresh figures arrive (the periodic
  live-refresh timer keeps it current). The double-click launcher therefore
  opens the browser in about a second rather than after the network round-trips.
- **Database reset in Settings.** A new *Reset data* section offers three
  confirmation-gated levels so you can start over or re-import cleanly:
  *Reset cached market data* (prices/FX/snapshots — rebuilt on next refresh),
  *Clear all transactions* (wipe the ledger to re-import, keeping accounts,
  instruments, allocations and settings), and *Reset everything* (a factory
  reset back to onboarding, which additionally requires typing `RESET`).
  Backed by a new `services/database_reset_service.py` that deletes rows in a
  foreign-key-safe order across the correct storage tiers.
- **In-app Help page.** New `/help` page and navigation entry providing an
  overview of the dashboard, a section-by-section walkthrough and KPI
  glossary, plus a companion `docs/user_guide.md`. Documentation-only
  addition with no change to portfolio calculations or stored data.
- **Settings explanations.** The Settings page now documents what each
  configurable option does, alongside the existing controls.

## [2.7.0] — 2026-05-31

### Added
- **Spreadsheet-to-dashboard parity comparison.** New
  `docs/spreadsheet_parity_comparison.md` documenting, KPI by KPI, how the
  dashboard reproduces the original tracking spreadsheet and where it
  deliberately diverges.
- **MTD growth KPI.** `PortfolioMetrics.mtd_growth_pct` mirrors the
  spreadsheet's month-to-date block — simple growth since the 1st of the
  current month, net of this month's external cashflows. Surfaced as a new
  Overview KPI card with the `mtd_growth` tooltip.
- **Fund-fee metrics.** `PortfolioMetrics` gained `weighted_expense_ratio`
  (value-weighted average TER, spreadsheet `Total!E15`) and
  `annual_expense_cost_eur` (estimated €/yr fee cost, `Total!E17`), shown
  in a new `Expense Ratio` KPI card with the `expense_ratio` tooltip.
- **Per-instrument return figures.** New `InstrumentMetrics` /
  `compute_instrument_metrics` compute per-holding XIRR, dividend-inclusive
  total growth, YTD growth, capital gain and expense ratio (mirroring the
  spreadsheet's `Lots` block). The Overview positions table gained
  `Expense`, `Capital Gain (native)`, `XIRR` and `YTD Growth` columns; the
  same figures are exposed in the `/overview` read model.
- **"Vs Market" verdict.** New `MarketVerdict` / `compute_market_verdict`
  compare the portfolio's since-inception total growth against a
  buy-and-hold of the benchmark index (spreadsheet `Total!Z23`), rendered
  as a KPI card with the `market_verdict` tooltip.

### Changed
- Overview positions table now colours signed return cells with the
  colorblind-safe `.inv-cell-pos` / `.inv-cell-neg` styles via AG-Grid
  `cellClassRules`.

## [2.6.0] — 2026-05-31

### Added
- **Interactive projection tool (Monthly & Yearly).** The old blank
  "hypothetical projection" grid is replaced by a live forward
  projection. The expected return defaults to the portfolio's own
  historical XIRR ("assuming existing performance continues") with
  adjustable optimistic/pessimistic bands, editable contributions and
  future step-ups, optional inflation-adjusted (real) values, a
  goal-seek (time-to-target / required contribution), and an outcome-cone
  chart. Each currency is projected natively with its own XIRR, so the
  EUR and USD cones — and the implied future EUR→USD drift — fall out of
  the model rather than a single static spot conversion. New tooltip keys
  `projection_*` explain each control.

## [2.5.0] — 2026-05-31

### Added
- **Dual-currency everywhere.** Every monetary KPI, table cell and tile
  on Overview, Monthly, Yearly, Deposits and Analytics now renders both
  EUR and USD side-by-side via the new shared helpers `dual_money`,
  `dual_pct` and `dual_kpi_card`. The Display Currency setting now only
  controls which currency appears first; the other is always shown next
  to it (not hidden behind a toggle).
- **Total Growth headline metric.** A canonical
  `total_growth_pct_compounded = (1 + XIRR) ^ years − 1` (with
  `years = (as_of − first_cashflow_date) / 365.25`) is computed
  independently per currency in `domain/returns.py` and exposed on
  `PortfolioMetrics` as `total_growth_compounded_{eur,usd}`. It is the
  leftmost / headline KPI on every page that reports performance.
- `PortfolioMetrics` gained full USD parallels for
  `total_value`, `total_contributions`, `total_dividends_cash`,
  `capital_gain`, `xirr`, `ytd_xirr`, `ytd_growth_pct` plus the new
  `total_growth_compounded_*` and `first_cashflow_date` fields.
- Monthly / Yearly rows gained cumulative `total_growth_compounded_{eur,usd}`
  plus matching `Total Growth (EUR)` / `Total Growth (USD)` table
  columns. The per-period Modified Dietz is kept as the trailing
  `Growth % (period)` column.
- Overview positions table gained dual `Cost Basis`, `Value` and
  `Capital Gain` columns (inline `$X / €Y`) plus a `Total Growth %` column.
- Tooltip key `total_growth_compounded` explaining the formula.

### Changed
- Deposits drops the `Amount (native)` + `Currency` columns in favour
  of explicit `Amount (EUR)` + `Amount (USD)`; the native amount is now
  surfaced via cell tooltip (matches PR #18 on Transactions).
- Overview KPI strip reorders: `Total Growth` (new) is leftmost and
  shows EUR + USD value with the compounded growth pct underneath.



### Removed
- Dropped DKK from the display-currency picker, FX defaults
  (`DEFAULT_QUOTES`), and the money symbol map. The app now ships with
  EUR and USD only; v2.2's tri-currency rollout regressed the UX
  without delivering anything most users wanted.

### Changed
- **Risk-free rate ticker.** The default switched from `^IRX` (CBOE
  13-week T-bill yield, which yfinance has been returning as empty
  frames since the upstream CSV restructured) to `^TNX` (10-year US
  Treasury yield, a reliably-published series quoted in the same
  percent convention so existing normalisation still works). Existing
  installs that have `^IRX` persisted in `app_config` are silently
  bumped to `^TNX` on read so analytics auto-heal without a Settings
  visit.
- **FX history backfills from the earliest transaction date.** Boot
  previously only refreshed the last 14 days, which left historical
  trade dates without a rate and forced the FX-aware aggregators to
  fall back to EUR — so the "growth shifts with currency" feature
  produced identical numbers for EUR and USD. Boot now caps the
  refresh window at `earliest_transaction_date()` (or 14 days,
  whichever is older), so per-trade-date FX is actually available.
- **Monthly and yearly charts now plot Growth % per period**, not
  contributions/dividends bars (which were redundant with the table).
  Green/orange bars; uses the display-currency growth when available.
- **Overview redesign.** Added a "Total Growth" KPI card and removed
  the "Cost Basis (native)" and "Value (native)" columns from the
  positions grid — the page now shows only EUR and the selected
  display currency, matching the rest of the app.
- **Larger default fonts** (root 18→20 px, KPI value 1.75→2 rem) and
  AG-Grid columns now use `flex` with a `minWidth` floor so wide
  tables scroll internally instead of overflowing the section card.
- **Deposits page is FX-aware per trade date.** The KPI cards and the
  per-row "Amount (USD)" column are computed by walking each
  transaction with the EUR→USD rate that was in force on its own
  date; USD-native deposits short-circuit FX entirely and use
  `net_native`, fixing the v2.3 bug where a $1000 deposit displayed
  as ~$950 after a EUR→USD→EUR→USD round-trip through today's spot.
- **Monthly / yearly aggregation hardened against missing FX.** When
  `Transaction.net_eur` is `NULL` (e.g. importer ran while FX cache
  was cold), the aggregator now converts `net_native` via the
  trade-date EUR→USD rate instead of treating dollars as euros —
  which v2.3 did and which produced the inflated "everything is EUR"
  totals with empty/zero buckets users were seeing.

### Fixed
- Section cards (`.inv-section`) now set `overflow:hidden;
  min-width:0` so AG-Grids inside them scroll horizontally instead of
  pushing the layout sideways (the analytics attribution table no
  longer overhangs the viewport).

## [2.3.1] — 2026-05-31

### Fixed
- Windows installer (`InvestmentDashboard-Setup.exe`) crashed at the end of installation with `FileNotFoundError: [WinError 3]` in `write_launcher`, because `installer/launcher.py` was declared only as a PyInstaller `hiddenimport` (embedded in the PYZ) and was therefore never extracted to `sys._MEIPASS` for `shutil.copy2` to read. The launcher source is now bundled as a PyInstaller data file at `<_MEIPASS>/installer/launcher.py`, matching the path `bootstrap.write_launcher` resolves at install time.

## [2.3.0] — 2026-05-31

### Added
- Shared JSON read-model layer for overview, deposits, transactions, monthly, yearly, analytics, calculator and full mobile snapshots, reusing existing domain/services calculations without adding business logic.
- Optional headless FastAPI `/api` surface and `inv-dashboard-api` entry point for read-only dashboard sections and full snapshot delivery.
- `inv-dashboard-export-snapshot` CLI for atomic JSON snapshot export to a cloud-synced/offline mobile handoff folder.
- Android companion design proposal covering Kotlin/Jetpack Compose, cloud-sync delivery, JSON contract, security model and phased APK packaging.

### Changed
- Deposits and ledger presentation queries now expose raw record fetchers used by both the web UI and read-model serialization, while preserving the existing formatted table row output.
- API access is opt-in via `INV_DASHBOARD_API_ENABLED`; optional bearer-token auth via `INV_DASHBOARD_API_TOKEN` keeps `/api/health` open for local health checks.

## [2.2.0] — 2026-05-31

This release lands the full v2.2 "data-scientist analytics + FX-aware
growth + instrument auto-detect" feature bump, in three slices:

* **(a)** Historical FX in every snapshot/aggregation and **DKK** as a
  first-class display currency.
* **(b)** Instrument auto-detection from imports + per-instrument
  display overrides (name / asset class / TER).
* **(c)** New `/Analytics` page with Calmar, Ulcer, VaR/CVaR, Skew,
  Excess Kurtosis, Beta and Alpha on top of the existing
  CAGR/TWR/XIRR/Sharpe/Sortino/Max-Drawdown grid, plus a configurable
  benchmark (default `VT`) and a **live** risk-free rate sourced from
  the 13-week US T-bill (`^IRX`) with an optional manual override.

### Added — phase (c) "analytics deep-dive"
- **`/analytics` page** registered in `main` and the sidebar nav.
  Renders three rows of KPI cards (returns / drawdown shape /
  benchmark-relative), an equity-curve plot with cumulative
  contributions and a rebased benchmark overlay, and a per-instrument
  attribution table. Lookback selectable from 1M to 5Y.
- **`domain/risk_extras.py`** — pure, strictly-typed implementations
  of `calmar_ratio`, `ulcer_index`, `historical_var`,
  `historical_cvar`, `skewness`, and `excess_kurtosis` (Fisher
  convention).
- **`domain/attribution.py`** — `attribute_portfolio_return` produces
  per-instrument P&L and `% of total return` rows from start / end /
  net-contribution / dividend triples.
- **`services/benchmark_service.py`** — configurable benchmark symbol
  via `app_config['benchmark_symbol']` (default `VT`); fetches closes
  through the existing yfinance adapter and stores them in
  `price_history` like any other instrument. Settings page exposes
  the picker.
- **`services/risk_free_service.py`** — live fetch of the 13-week US
  T-bill yield from yfinance `^IRX`, normalised from percent to
  decimal fraction, cached in `app_config` with a 24h TTL. Supports a
  user-set manual override that wins over the fetched value. Returns
  ``None`` on first-ever failure (no hypothetical fallback —
  Sharpe/Sortino/Alpha simply render as "—" until a real number is
  available). Settings page exposes symbol, last-fetched timestamp,
  manual override and a "refresh now" button.
- **Tooltips** for Calmar, Ulcer, VaR, CVaR, Skew, Kurtosis,
  risk-free rate, benchmark and attribution.

### Added — phase (b) "instrument auto-detect + overrides"
- **`services/instrument_enrichment_service.py`** — override → ledger
  precedence helper (`effective_instrument`) and yfinance-backed
  gap-filler (`enrich_instrument` / `ensure_instrument`). The importer
  now creates instruments via this service so unknown symbols arrive
  with a real `name` / `asset_class` / `native_currency` / TER.
- **`name` / `asset_class` / `expense_ratio` columns on
  `instrument_overrides`** so users can re-label an instrument
  ("VTI" → "US Total Market") and re-bucket it (stock → etf) without
  editing the ledger.
- **"Edit instrument" dialog on the Transactions page** lets users
  apply the overrides interactively with a live preview of the
  effective value.
- **Overview positions table and treemap now use the effective
  values**, so phase-(b) corrections show up everywhere instead of
  only in Settings.
- **CSV importers populate `ParsedTransactionRow.name`** from
  `investment name` (Vanguard), the workbook name (Vanguard XLSX) and
  `security description` (Fidelity), so a freshly-imported instrument
  has a real display name even before yfinance enrichment runs.
- **`instruments.asset_class` CHECK constraint** now accepts
  `'unknown'` and the importer's default; downgrade coerces
  `'unknown'` → `'etf'` to preserve the v2.1 constraint.

### Migrations
- **`0005_v2_2_instrument_enrichment`** (`9e4b3f6c2a17`, parent
  `8d3a2e5b14c6`) widens the asset-class CHECK and adds the three
  override columns via `batch_alter_table`.

### Added — phase (a) "historical FX + DKK"
- **DKK as a display currency.** `display_currency_service.SUPPORTED_CURRENCIES`
  now contains `EUR`, `USD`, `DKK`; the Settings → Display currency
  picker exposes all three. `money_format.currency_symbol` formats DKK
  with a `kr ` prefix.
- **Multi-quote FX backfill.** `fx_service.refresh_fx_history` accepts
  a `quotes` iterable (default `("USD", "DKK")`) and refreshes each
  series independently. Boot calls it with the default, so DKK history
  starts accumulating from the next launch with no configuration.
- **Per-currency snapshot conversion.** New
  `snapshots_service.get_or_compute_in_currency(session, date, ccy)`
  returns the cached EUR snapshot converted at the FX rate **on the
  snapshot date** (forward-filled to the most recent prior business
  day). Drives the FX-aware equity curve.
- **FX-aware period aggregation.** `ui.pages._period_query.aggregate`
  accepts `display_currency=…`. When set to a non-EUR currency, each
  `PeriodRow` carries `contributions_display`, `dividends_display`,
  `interest_display`, `net_flow_display`, `closing_value_display`,
  `opening_value_display`, and `growth_pct_display` computed using
  per-trade-date FX (cashflows) and per-period-end FX (balances). The
  Modified Dietz growth % is then computed in the display currency, so
  USD/DKK readers see the return their wallet actually experienced
  including FX drift.

### Fixed
- **Yearly/Monthly USD and DKK columns and bars previously scaled the
  EUR series by today's spot rate**, making the entire historical
  curve a uniform rescaling that hid FX swings. Both pages now drive
  their primary-currency column and chart bars from the FX-aware
  aggregation above; the secondary EUR column shows the underlying
  ledger value for cross-reference. EUR-display callers see no diff.
- **Overview FX caption was hard-coded to EUR→USD** even when the
  user's display currency was something else; the caption now follows
  the active display currency, and KPI cards convert via the EUR→that
  currency rate rather than re-using the EUR→USD rate.
- **Deposits page KPIs reused the EUR→USD rate to render the user's
  display currency**, producing USD numbers under a "DKK" label once
  DKK is selected. The KPIs now pull the rate for the active display
  currency; the auxiliary EUR/USD ledger column keeps using EUR→USD.

## [2.1.4] — 2026-05-28

### Fixed
- **v1.5 "neo-fintech" facelift CSS never reached page renders, leaving the
  UI looking like raw Quasar defaults.** `ui.style.install()` injected the
  whole stylesheet via `ui.add_head_html(...)` without `shared=True`. In
  NiceGUI 2.x that defaults to `shared=False`, which scopes the snippet to
  the auto-index client at startup time only. Every `@ui.page` route gets
  its own client, so the entire neo-fintech stylesheet was silently dropped
  on every real page render — producing the solid blue header, borderless
  KPI tiles, plain-text version "pill", unstyled currency toggle, squished
  AG-Grid columns and missing sidebar active state shown in the v2.1.3 bug
  report. The stylesheet is now attached with `shared=True` so it reaches
  every page client and the intended chrome actually applies.

## [2.1.3] — 2026-05-28

### Fixed
- **Fresh split-storage startups migrated the wrong SQLite file.** The boot
  sequence correctly injected the resolved ledger database URL into Alembic,
  but `migrations/env.py` overwrote it with the legacy `db.sqlite` URL. On
  first launch with the v2 split ledger/config/cache layout, migrations created
  `transactions` in `db.sqlite` while the `/overview` page queried
  `ledger.sqlite`, producing a 500 `sqlite3.OperationalError: no such table:
  transactions`. Alembic now preserves the boot-provided URL and falls back to
  `settings.ledger_url` for direct migration CLI use, so the active ledger file
  is initialized before the UI queries it.

## [2.1.2] — 2026-05-28

### Fixed
- **`InvestmentDashboard-Setup.exe` "Bad Image" crash on launch (really
  this time).** The 2.1.1 release attempted to fix the
  `ucrtbase.dll` / `0xc0e90002` "Bad Image" dialog by disabling UPX
  compression in the PyInstaller spec, but UPX was never actually
  installed on the GitHub Actions Windows runner, so that flag had no
  effect on the shipped binary and the installer continued to crash.
  The real root cause is that `.github/workflows/release.yml` built the
  installer on `windows-latest`, which now resolves to **Windows Server
  2025**. PyInstaller bundles the build machine's Universal C Runtime
  into the one-file binary, and Windows Server 2025's `ucrtbase.dll`
  plus its api-set forwarder DLLs are incompatible with the loader on
  Windows 10 / 11 client SKUs — when the bootloader extracts them into
  the per-run `_MEI…` temp directory, the client loader refuses the
  image and aborts with `Error status 0xc0e90002`. The
  `build-windows-installer` job is now pinned to `windows-2022`, whose
  UCRT payload is compatible with all currently supported client
  Windows versions, so the installer launches cleanly. `upx=False` is
  retained in the spec as defence in depth.

## [2.1.1] — 2026-05-28

### Fixed
- **`InvestmentDashboard-Setup.exe` "Bad Image" crash on launch.** The
  PyInstaller spec was building the one-file installer with UPX
  compression enabled (`upx=True`), which mangled the bundled Windows
  Universal C Runtime DLLs (notably `ucrtbase.dll`). When the
  bootloader extracted them to the per-run `_MEI…` temp directory,
  Windows refused to load the corrupt image and aborted with
  `Error status 0xc0e90002`. UPX is now disabled in
  `installer/installer.spec` so runtime DLLs are bundled verbatim and
  the installer launches cleanly on end-user machines.

## [2.1.0] — 2026-05-28

### Added
- **Single-file Windows installer (`InvestmentDashboard-Setup.exe`).** New
  `installer/` package builds a tiny PyInstaller one-file binary that, on
  first launch, downloads an embeddable CPython 3.12, installs `pip`,
  pulls the latest `investment-dashboard` release from the GitHub
  Releases API, drops Start-menu and Desktop shortcuts, and launches the
  dashboard — no unzipping or admin rights required. See
  `installer/README.md` for the full design.
- **Self-updating launcher.** After the first install the shortcut runs
  `installer/launcher.py`, which compares the installed version against
  the latest GitHub release and silently `pip install --upgrade`s before
  starting the dashboard. Update failures are non-fatal.
- **Release pipeline.** New `.github/workflows/release.yml` builds the
  wheel, sdist, and `InvestmentDashboard-Setup.exe` on every `v*` tag
  push (and via `workflow_dispatch`) and attaches all three artifacts to
  a GitHub Release. Because the installer is version-agnostic at runtime,
  the same `.exe` keeps working for every future v2.x release without
  being rebuilt.

## [2.0.0] — 2026-05-28

### Added
- **v2.0 plan Phase 3 — cloud-sync-aware storage paths.**
  `investment_dashboard.storage.cloud.detect_cloud_sync_root` recognises
  OneDrive, iCloud, Dropbox (including relocated installs via
  `info.json`) and Google Drive (including the macOS
  `~/Library/CloudStorage` layout).
  `investment_dashboard.storage.paths.resolve_storage_layout` resolves
  ledger / config / cache paths through the precedence chain
  env > persisted `app_config` > cloud default > local default. Boot
  applies the layout before opening engines, and the Settings page
  surfaces the resolved paths plus their source.
- **v2.0 plan Phase 4 — optional SQLCipher encryption.** New
  `[encrypted]` install extra (pysqlcipher3 + keyring).
  `investment_dashboard.storage.encryption.resolve_encryption` resolves
  driver availability and the passphrase (env var → OS keychain) and
  fails fast with a clear message if either is missing.
  `set_active_encryption` on `db.py` rewrites engine URLs to
  `sqlite+pysqlcipher://` and applies `PRAGMA key` on each connect.
  `split_db` gained `--encrypt-ledger`, `--encrypt-config`, and
  `--passphrase` flags that wrap the produced files via
  `sqlcipher_export`.
- **v2.0 plan Phase 5 — sidecar guard, writer lock, integrity, backups.**
  `storage.sidecar.should_use_truncate_journal` flips SQLite to
  `journal_mode=TRUNCATE` for files inside a cloud folder;
  `assert_no_sidecars_in_cloud` blocks boot if stray `-wal` / `-shm`
  files are present. `storage.lock.acquire_write_lock` takes a
  non-blocking `flock`/`msvcrt.locking` advisory lock with a
  read-only fallback (`boot.is_read_only`). `storage.integrity` runs
  `PRAGMA integrity_check` against ledger and config on boot.
  `storage.backup.snapshot` writes rolling backups
  (hourly/daily/monthly with 24/14/12 retention) using
  `sqlite3.Connection.backup`. New CLIs:
  `inv-dashboard-repair-sidecar` and `inv-dashboard-backup --verify`.

## [1.5.0] — 2026-05-27

### Changed

- **Massive UI facelift — "neo-fintech" chrome.** The dashboard now
  reads as a 2026-era professional product (think Linear / Stripe
  Dashboard / Mercury) instead of stock Quasar/Material defaults.
  Strictly cosmetic: no domain, service, repository, query, or import
  logic was touched.
  - New design-token system (`investment_dashboard.ui.theme`):
    brand accent (deep indigo/teal `#0F4C81`), surface palette,
    spacing / radius / shadow / type scales.
  - New global stylesheet (`investment_dashboard.ui.style`) injecting
    CSS custom properties for light **and dark** themes, AG-Grid
    theme overrides, thin styled scrollbars, accessible focus rings,
    flatter toast styling and rounded dialog corners.
  - Header rebuilt: sticky frosted bar with a custom inline brand
    mark, product name + version pill, compact currency segmented
    control, **light / dark toggle**, refresh button, and a subtle
    "as of UTC" timestamp.
  - Sidebar rebuilt: 240 px surface drawer, rounded active-state
    pill with 3 px accent bar, hover state, footer build-version
    line.
  - Page chrome: shared `page_header(title, subtitle=…)`,
    `section(title)` card wrapper, `empty_state(icon, title, hint)`
    placeholder, `chip(...)` pill, and a tabular-num aware
    metric/KPI card with optional sparkline slot.
  - Charts: new `colorblind_modern` and `colorblind_dark` Plotly
    templates (transparent paper, hairline grid, Inter 13 px,
    modern legend). The legacy `colorblind` template is preserved
    as an alias so existing call-sites keep working.
  - Every page (`overview`, `deposits`, `transactions`, `monthly`,
    `yearly`, `calculator`, `settings`, `onboarding`) was rewired to
    use the shared helpers; no copy or behaviour changed.

### Notes

- All financial numbers now render with tabular figures so columns
  visually align without monospacing.
- Gain/loss colours are still the Wong colorblind-safe pair
  (`#0072B2` / `#E69F00`) with redundant ↑/↓ arrows. WCAG-AA contrast
  is preserved in both light and dark modes.

## [1.4.0] — 2026-05-27

### Added

- **Vanguard "Full History" XLSX import.** Vanguard's web "Activity →
  Download" only exposes the last 18 months of transactions; the
  user-facing workaround is to run an *Activity report* in the Reports
  area with a custom date range and export to Excel. The importer now
  accepts that workbook directly — bytes are detected by the standard
  ZIP magic (`PK\x03\x04`) and routed through a new
  `adapters/vanguard/xlsx_parser.py`. Headers are located dynamically
  (the export prepends a "Custom report created on …" banner),
  `Amount` cells like `-$10,000.0000` and `Commission & fees**`
  values like `"Free"` are parsed, sells keep the export's already-
  negative quantity, and sweep rows are dropped with a count.
- **`Stock split` and `Funds Received (adjustment)`** are now mapped
  in the Vanguard action map (split → `split`, adjustment →
  `deposit`); both appear in the Full-History export but are absent
  from the brokerage CSV.
- **Fidelity capital-gain distributions** — `LONG-TERM CAP GAIN`,
  `SHORT-TERM CAP GAIN` and `DISTRIBUTION` Action strings now map to
  `dividend_cash`. These rows previously aborted real-world Fidelity
  imports with `UnknownActionError`.

### Changed

- `services.importer_service.import_csv` now accepts `bytes` as well
  as `str` content so the UI can hand XLSX bytes through unchanged.
- The Transactions page's *Import* dialog accepts `.xlsx` in addition
  to `.csv` (Vanguard only — Fidelity remains CSV).
- `openpyxl` added as a runtime dependency (already a transitive
  dependency of `pandas`'s Excel support).

### Tests

- 16 new tests covering the XLSX parser (synthetic workbook + real
  fixture under `docs/Comparison Files/`), the importer dispatch on
  ZIP magic bytes, the new Fidelity / Vanguard action-map entries,
  and end-to-end re-import deduping. 222 total pass.

## [1.3.2] — 2026-05-27

### Fixed

- Fixed launcher recovery for existing `.venv` environments that do not have
  `pip` installed by bootstrapping pip with `ensurepip` before running package
  install or upgrade commands.

## [1.3.1] — 2026-05-27

### Fixed

- Fixed the Windows launcher release refresh path end to end: it now treats
  stale installed project metadata as needing an editable reinstall and stops
  an already-running same-project server on the configured dashboard port
  before starting, so double-clicking `run_dashboard.bat` serves the current
  release instead of an older in-memory process.

## [1.3.0] — 2026-05-27

### Added

- **Onboarding wizard.** First-run users now land on `/onboarding`, which
  detects an empty database and offers a one-click "Seed default setup"
  action — creating the Vanguard, Fidelity and Savings Bank accounts and the
  19 default instruments from the spec — or a "Set up manually" jump to
  Settings.
- **Display-currency toggle (EUR / USD) on every page.** A header switch in
  the layout flips the dashboard's primary display currency; the value is
  persisted in `app_config` so it survives restarts. Overview, Deposits,
  Monthly, Yearly, Transactions, Calculator and Settings all honour the
  toggle and, where space allows, render both EUR and USD side-by-side
  rather than choosing one.
- **Settings — accounts, instruments and allocations are now creatable
  from the UI.** New "+ Add account", "+ Add instrument" and
  "+ New allocation" dialogs cover the onboarding gap when a user wants to
  add things outside the seed; a "Seed default setup" button re-runs the
  spec defaults idempotently.
- **Calculator currency selector.** The cash-to-invest input accepts EUR
  or USD; the buy plan is shown in both currencies side-by-side.

### Changed

- Transactions page exposes both `Net EUR` and `Net USD` columns.
- `run_dashboard.py` also installs `pytest` into the launcher's virtualenv
  and gates the re-launch check on it, so the project test suite can be run
  straight from the bootstrapped `.venv` without an extra install step.

## [1.2.1] — 2026-05-27

### Fixed

- `run_dashboard.py` now owns first-run setup: it creates/repairs `.venv`,
  installs the app editable, verifies required runtime modules, and re-launches
  through the virtualenv Python before importing NiceGUI.
- `run_dashboard.bat` now delegates setup to the Python launcher so both
  double-click entry points follow the same dependency bootstrap path.
- Pinned NiceGUI to the compatible 2.x line (`nicegui>=2.10,<3`) so the app's
  existing multi-page registration works instead of installing incompatible
  NiceGUI 3.x.
- Fresh installs now create the SQLite database parent directory before Alembic
  migrations run, fixing first-run `unable to open database file` errors.

## [1.2.0] — 2026-05-26

### Added — items deferred from v1.1

- **Daily snapshots cache** (`position_snapshots` table). New
  `snapshots_repo`, `snapshots_service.get_or_compute` reads-through
  the cache: historical days are returned in O(1); today's row is
  always recomputed (intraday prices still move). `_period_query`
  uses it so `/monthly` and `/yearly` close out N periods in O(N)
  cache hits instead of N full-ledger roll-ups.
- **Smart per-symbol refresh** (`price_cache_metadata` table). New
  `prices_service.refresh_due_prices` and
  `instruments_due_for_refresh` consult per-asset-class TTLs
  (`REFRESH_TTL_SECONDS`):
  - `etf` / `stock`: **2 minutes** — near-live during market hours.
  - `mutual_fund`: 6 hours.
  - `cash` / `savings`: opt-out (no yfinance ticker).
  A 60-second `ui.timer` in `main.run()` triggers the refresh; it
  only hits the network for instruments past their TTL.
- **Monthly hypothetical projection block** on `/monthly` —
  `project_monthly` (compound at the per-month equivalent of each
  annual rate) and `project_monthly_from_session`. 36-month default
  horizon at 4 / 7 / 10 % p.a.
- **Per-period growth %** column on `/monthly` and `/yearly` —
  Modified Dietz computed from opening + closing snapshot values and
  the period's net external flow.
- **Settings inline editing expanded**:
  - Instrument: edit `expense_ratio` and toggle `active`.
  - Account: toggle `active` (new column, default `True`,
    migration `0002`).
- **Best-effort `ytd_start_value` fallback** in
  `compute_portfolio_metrics`: walks forward up to 31 days from
  Jan 1 looking for the first non-zero portfolio valuation — closes
  the v1.1 caveat for portfolios opened mid-year.
- **One-click launcher** — `run_dashboard.py` /
  `run_dashboard.bat` / `run_dashboard.sh`. The shell launchers
  bootstrap a venv on first run, install the package editable, then
  start the server and open the browser automatically. No command
  line required.
- 17 new unit tests (snapshots service, smart-refresh TTL logic,
  monthly projection, Modified Dietz, repo updates for the new
  fields). All 188 tests pass.

### Changed
- `main.run` now uses `ui.run(show=True)` so the launcher pops the
  default browser straight at the dashboard, and registers a 60-second
  background `ui.timer` that drives the near-live ETF refresh.

### Known caveats / deferred to v1.3
- TWR-by-period is exposed as a Modified-Dietz approximation only
  (the full daily-snapshot TWR in `domain/returns.py` would need
  daily snapshots — easy follow-up now that the snapshots table
  exists).
- Savings Bank CSV importer is *explicitly out of scope* per user
  request (the broker has no CSV export). Savings deposits remain
  manual via `/transactions`.

## [1.1.0] — 2026-05-26

### Added — deferred items from v1.0

- **Mark-to-market closing balances** on `/monthly` and `/yearly`.
  `PeriodRow.closing_value_eur` is now computed via
  `positions_service.total_portfolio_value` evaluated at the last day of
  each bucket (capped at today). Toggleable via the new
  `with_closing_value` flag on `aggregate()` so unit tests can opt out
  of the per-period roll-up.
- **Hypothetical projection** block on `/yearly`. New
  `ui/pages/_projection_query.py` exposes `project()` (pure math) and
  `project_from_session()`. Renders 10 years of compound growth at
  4 / 7 / 10 % p.a. against the average historical annual contribution,
  with the cumulative contributed column for reference.
- **Inline editing in `/settings`**:
  - Edit account label / type via dialog (broker + currency stay
    immutable — they're keyed by the ledger).
  - Edit instrument name / category / asset class via dialog.
  - Activate a target allocation in one click.
  - Backed by new `accounts_repo.update_account` and
    `instruments_repo.update_instrument` helpers.
- 8 new unit tests (projection math, period closing balance, repo
  update helpers). All 166 tests pass.

### Changed
- `/monthly` and `/yearly` tables gained a "Closing value (EUR)" column.
- `/settings` now renders cards-with-buttons instead of read-only
  AG-Grids for easier inline mutation.

### Known caveats / deferred to v1.2
- The `ytd_start_value` in `compute_portfolio_metrics` still relies on
  having a January-1 price tick; new portfolios may see best-effort
  values until history is backfilled.
- No snapshots table yet (spec §4.1) — every metrics page recomputes
  positions from the full ledger.

## [1.0.0] — 2026-05-26

### First UI-testable release 🎉

Cumulative result of v0.2–v0.9. The app now boots end-to-end:

```bash
uv sync
uv run alembic upgrade head
uv run investment-dashboard   # NiceGUI on http://0.0.0.0:8080
```

All seven pages from spec §8 are live (`/overview`, `/deposits`,
`/transactions`, `/monthly`, `/yearly`, `/calculator`, `/settings`).
CSV import (Fidelity + Vanguard) round-trips through the importer
service into the ledger; the Overview page renders portfolio XIRR,
total gain, YTD growth, per-instrument positions and an allocation
treemap.

### Added in v1.0.0 specifically
- `tests/e2e/test_app_smoke.py`: zero-network smoke that runs the same
  boot + page-registration sequence as `main.run()` so any import-time
  regression is caught in CI.
- README updated to reflect the v1.0 status, capabilities, and roadmap
  position.
- 157 total tests pass; lint, format, mypy (strict on `domain/`) all
  clean.

### Known caveats / deferred to v1.1
- `/monthly` and `/yearly` show contribution/dividend buckets but not
  end-of-period mark-to-market closing balances.
- `/yearly` "Hypothetical projection" sub-table is not yet wired.
- `/settings` is read-only (inline editing of accounts/instruments/
  allocations comes in v1.1).
- The `ytd_start_value` used by `compute_portfolio_metrics` requires
  historical prices on January 1, which may be missing for new
  portfolios — treated as best-effort.

## [0.9.0] — 2026-05-26

### Added — Monthly, Yearly, Calculator, Settings pages
- `ui/pages/_period_query.py`: shared monthly/yearly aggregation
  (`aggregate(session, monthly=…)`) bucketing cashflow ledger rows into
  contributions, dividends, interest, and net-flow. Used by both
  `/monthly` and `/yearly`.
- `ui/pages/monthly.py`: contributions bar chart (Plotly, colorblind
  template) + paginated AG-Grid of monthly buckets.
- `ui/pages/yearly.py`: stacked-bar chart (contributions + dividends +
  interest) + AG-Grid of yearly buckets.
- `ui/pages/calculator.py`: investment calculator using
  `domain.allocation.plan_rebalance`. Reads the **active** target
  allocation, pulls current per-instrument EUR values from
  `compute_positions`, looks up latest prices, supports fractional-share
  toggle, and renders a per-instrument buy plan + residual cash.
- `ui/pages/settings.py`: read-only listing of accounts, instruments and
  target allocations; **Refresh FX** / **Refresh prices** buttons wired
  to the service layer.
- 2 new aggregation tests. 155 total pass.

## [0.8.0] — 2026-05-26

### Added — `/overview` page (the v1.0-critical page)
- `ui/pages/_overview_query.py`: thin layer wrapping
  `metrics_service.compute_portfolio_metrics` /
  `positions_service.compute_positions`, plus `position_rows`,
  `allocation_treemap`, and a `TreemapDatum` dataclass.
- `ui/pages/overview.py` upgraded from stub to a working dashboard:
  - 4 KPI cards (Total Value · Total Gain · XIRR · YTD Growth) with the
    colorblind-safe gain/loss color and ↑/↓ arrow.
  - Per-instrument AG-Grid (10 columns including category, cost basis,
    current value EUR, total growth %).
  - Plotly treemap of allocation by `instrument.category`, using the
    `colorblind` template.
  - Helpful empty-state when no positions exist.
- 3 new tests for the position-row shape and treemap aggregation. 153
  total pass.

## [0.7.0] — 2026-05-26

### Added — `/deposits` page
- `ui/pages/_deposits_query.py`: `DepositSummary` dataclass + helpers
  `compute_summary` and `list_deposit_rows` (cash-flow filter: only
  ``deposit`` / ``withdrawal`` / ``interest`` ledger rows).
- `ui/pages/deposits.py` upgraded from stub to a working page:
  - 4 KPI cards at the top: Total contributed (EUR), YTD contributions,
    MTD contributions, Interest YTD.
  - AG-Grid below with all cash-flow rows (newest first).
- 3 new tests for the deposit aggregation logic (table filter,
  summary totals, empty-data safety). 150 total pass.

## [0.6.0] — 2026-05-26

### Added — `/transactions` page
- `ui/pages/_ledger_query.py`: `LedgerFilters` dataclass + `list_ledger_rows`
  helper that joins `Transaction → Account → Instrument` and formats
  Decimals for AG-Grid. Unit-testable without NiceGUI.
- `ui/pages/transactions.py` upgraded from stub to a functional page:
  - AG-Grid ledger (10 columns: Date · Account · Kind · Symbol · Qty ·
    Price · Fees · Net · Net EUR · Source), paginated, resizable.
  - Filter chips: account dropdown, kind dropdown, symbol text input.
  - **+ New Transaction** modal — manual entry with account/kind/date/
    symbol/qty/price/fees/net/description.
  - **Import CSV** modal — broker dropdown, account picker, file upload
    that pipes content into `services.importer_service.import_csv` and
    reports inserted / duplicates / sweeps / unknown actions.
- 4 new tests covering `list_ledger_rows` filtering + ordering. 147
  total pass.

## [0.5.0] — 2026-05-26

### Added — UI shell
- `ui/theme.py`: Wong colorblind-safe palette (gain=blue `#0072B2`,
  loss=orange `#E69F00`) plus a registered Plotly `colorblind` template
  set as default. `color_for_signed`/`arrow_for_signed` helpers for
  redundant directional cues.
- `ui/layout.py`: `page_frame()` context manager rendering a consistent
  header + sidebar across every page. `NAV_ITEMS` covers the seven
  spec'd pages (Overview / Deposits / Transactions / Monthly / Yearly /
  Calculator / Settings).
- `ui/copy/tooltips.py`: single source of truth for tooltip wording, all
  copy ≤ 3 sentences (spec §10).
- `ui/components/`: `kpi_card` and `tooltip_label` reusable components.
- `ui/pages/`: scaffolded page modules for all seven routes; each module
  exposes a `register()` function and a `PATH` constant.
- `boot.py`: idempotent boot sequence — Alembic upgrade → Plotly template
  registration → best-effort FX refresh → best-effort price refresh.
  `skip_network=True` for offline development.
- `main.py` rewired to run the boot sequence and register all pages
  before `ui.run()`. `/` redirects to `/overview`.
- 11 new tests (palette, tooltip copy length budget, boot offline
  short-circuit, nav coverage). 143 total pass.

## [0.4.0] — 2026-05-26

### Added — CSV importers
- `adapters/importer_types.py`: shared `ParsedTransactionRow` dataclass
  and `UnknownActionError`.
- `adapters/fidelity/`:
  - `action_map.py` mapping Fidelity Action substrings to ledger kinds
    (spec §5.1).
  - `parser.py` reading the Fidelity activity-download CSV, skipping
    disclaimer preamble, recomputing prices to handle the May-2024
    2-decimal change, generating sha256 `external_id` for dedup.
- `adapters/vanguard/`:
  - `action_map.py` mapping Vanguard transaction types, including the
    explicit drop of `Sweep In`/`Sweep Out` rows (spec §5.2).
  - `parser.py` with sweep counting and sign-convention enforcement
    (sells get negated quantity).
- `services/importer_service.py`: parser-agnostic glue that resolves
  symbols via `instruments_repo.get_or_create`, looks up FX with
  forward-fill, and writes via savepoint-aware
  `transactions_repo.insert_transaction` for idempotent re-import.
- `repositories/transactions_repo.insert_transaction` now uses a
  SAVEPOINT so duplicate inserts don't roll back the surrounding
  transaction.
- 36 new tests, two sample CSV fixtures, 132 total tests pass.

## [0.3.0] — 2026-05-26

### Added — repositories + services
- `repositories/`:
  - `accounts_repo`: CRUD + filter by broker.
  - `instruments_repo`: `get_or_create()` for CSV importers.
  - `transactions_repo`: filtered listing (by account / instrument /
    kind / date range) + dedup-on-`external_id` insert.
  - `prices_repo` and `fx_repo`: idempotent SQLite
    `ON CONFLICT … DO UPDATE` upserts.
  - `allocations_repo`: target-allocation CRUD with `set_active()` flip.
- `services/`:
  - `fx_service`: incremental Frankfurter backfill + EUR→quote lookup
    with forward-fill on weekends/holidays.
  - `prices_service`: per-instrument incremental yfinance refresh,
    skipping synthetic cash/savings tickers.
  - `positions_service`: rolls up the ledger into per-instrument
    holdings with cost basis, current price, and EUR-converted value;
    plus `compute_cash_balance` and `total_portfolio_value`.
  - `metrics_service`: assembles cashflow streams from the ledger and
    calls the domain layer for portfolio XIRR, YTD XIRR, total growth
    %, capital gain, and YTD growth %.
- 15 new tests across repos and services; 96 tests pass overall.

## [0.2.0] — 2026-05-26

### Added — Phase 2 domain math layer
- `domain/currency.py`: `native_to_eur`, `eur_to_native`, and
  `lookup_rate_with_forward_fill` (weekend / holiday inheritance) — all
  Decimal-based.
- `domain/returns.py`:
  - `Cashflow` and `DailyValuation` dataclasses.
  - `xirr()` via Newton-Raphson with a bisection fallback on
    `[-0.9999, 100.0]`; handles degenerate same-sign streams (returns
    `None`) and non-convergence.
  - `twr()` daily-snapshot time-weighted return (spec §6.3).
  - `cagr()`, `annualize_return()`, `total_growth_pct()`, `capital_gain()`.
- `domain/risk.py`: `annualized_volatility`, `sharpe_ratio`,
  `sortino_ratio`, `max_drawdown`, `best_worst_month`,
  `monthly_win_rate`, `beta`, `alpha` (spec §6.6).
- `domain/allocation.py`: `plan_rebalance()` — buy-only rebalance planner
  with proportional scaling and floored- or fractional-share modes
  (spec §6.8).
- 60 new unit tests under `tests/domain/`, including a self-verifying NPV
  check on an irregular cashflow stream.
- Ruff config: ignore `RUF002`/`RUF003` (mathematical Unicode in
  docstrings is intentional), and relax `PLR0911`/`PLR0912` in
  `domain/returns.py` (XIRR is inherently branchy).

## [0.1.0] — 2026-05-26

### Added — Phase 0 + 1 scaffolding
- Project bootstrap with `uv`, `pyproject.toml`, `.python-version`, `.editorconfig`,
  `.env.example`, `.pre-commit-config.yaml`, and extended `.gitignore`.
- Layered package skeleton under `src/investment_dashboard/`:
  `domain/`, `adapters/`, `repositories/`, `services/`, `ui/`, `models/`.
- `config.py` (pydantic-settings, Windows-aware default DB path), `db.py`
  (SQLite WAL pragmas + session factory), `logging.py`, and a NiceGUI
  smoke entry point `main.py` bound to `0.0.0.0:8080`.
- All ORM models from spec §4: `accounts`, `instruments`, `transactions`
  (with `kind` and `source` enums, `unique(account_id, external_id)`, and
  date/instrument indexes), `price_history`, `fx_history`,
  `target_allocations`, `target_allocation_items`, `app_config`.
- Alembic configured against the app's `Settings.db_url` with an autogenerated
  baseline migration (`0001_initial_schema.py`) using batch operations for
  SQLite compatibility.
- Frankfurter FX adapter (`adapters/frankfurter_client.py`) with `fetch_rates`
  and `fetch_latest`, typed `FrankfurterError`, Decimal precision preserved.
- yfinance market-data adapter (`adapters/yfinance_client.py`) with
  `auto_adjust=False`, batched downloads, graceful handling of empty frames
  and missing symbols, Decimal returns.
- Pytest test suite: in-memory SQLite fixture, schema round-trip tests, FK
  enforcement check, unique-constraint check, mocked-HTTP tests for both
  adapters via `respx` and `monkeypatch`, plus opt-in `@pytest.mark.network`
  smokes (skipped unless `--run-network`).
- GitHub Actions CI: ruff lint + format check, mypy (strict on `domain/`),
  pytest with coverage.
- Docs: `README.md` (quickstart + architecture diagram), `CONTRIBUTING.md`,
  `docs/architecture.md`.

[2.9.4]: https://github.com/DJH961/Investment-Overview/compare/v2.9.3...v2.9.4
[1.4.0]: https://github.com/DJH961/Investment-Overview/compare/v1.3.2...v1.4.0
[1.1.0]: https://github.com/DJH961/Investment-Overview/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/DJH961/Investment-Overview/compare/v0.9.0...v1.0.0
[0.9.0]: https://github.com/DJH961/Investment-Overview/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/DJH961/Investment-Overview/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/DJH961/Investment-Overview/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/DJH961/Investment-Overview/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/DJH961/Investment-Overview/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/DJH961/Investment-Overview/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/DJH961/Investment-Overview/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/DJH961/Investment-Overview/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/DJH961/Investment-Overview/releases/tag/v0.1.0
