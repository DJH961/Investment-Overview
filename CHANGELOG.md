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

## [2.9.1] — Unreleased

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

## [2.8.1] — Unreleased

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

## [2.8.0] — Unreleased

This release lands the full **v2.8 whole-app cleanup** — a broad sweep of
correctness and UX fixes spanning Overview, Deposits, Transactions, Monthly,
Yearly, Projection, Analytics, Settings and onboarding. The work was delivered
as one branch / one PR organised into seven themed steps; the step-by-step
plan and root-cause analysis live in `docs/v2.8-cleanup-plan.md`.

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

## [2.7.2] — Unreleased

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

## [2.7.0] — Unreleased

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

## [2.6.0] — Unreleased

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

## [2.5.0] — Unreleased

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

## [2.3.1] — Unreleased

### Fixed
- Windows installer (`InvestmentDashboard-Setup.exe`) crashed at the end of installation with `FileNotFoundError: [WinError 3]` in `write_launcher`, because `installer/launcher.py` was declared only as a PyInstaller `hiddenimport` (embedded in the PYZ) and was therefore never extracted to `sys._MEIPASS` for `shutil.copy2` to read. The launcher source is now bundled as a PyInstaller data file at `<_MEIPASS>/installer/launcher.py`, matching the path `bootstrap.write_launcher` resolves at install time.

## [2.3.0] — Unreleased

### Added
- Shared JSON read-model layer for overview, deposits, transactions, monthly, yearly, analytics, calculator and full mobile snapshots, reusing existing domain/services calculations without adding business logic.
- Optional headless FastAPI `/api` surface and `inv-dashboard-api` entry point for read-only dashboard sections and full snapshot delivery.
- `inv-dashboard-export-snapshot` CLI for atomic JSON snapshot export to a cloud-synced/offline mobile handoff folder.
- Android companion design proposal covering Kotlin/Jetpack Compose, cloud-sync delivery, JSON contract, security model and phased APK packaging.

### Changed
- Deposits and ledger presentation queries now expose raw record fetchers used by both the web UI and read-model serialization, while preserving the existing formatted table row output.
- API access is opt-in via `INV_DASHBOARD_API_ENABLED`; optional bearer-token auth via `INV_DASHBOARD_API_TOKEN` keeps `/api/health` open for local health checks.

## [2.2.0] — Unreleased

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

[Unreleased]: https://github.com/DJH961/Investment-Overview/compare/v1.4.0...HEAD
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
