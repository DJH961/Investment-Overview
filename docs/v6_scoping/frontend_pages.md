# v6 frontend page inventory (v5 desktop + v5 web -> v6 React)

Scoping input for `docs/v6_frontend_design.md`. Sources read: NiceGUI pages
`backend/src/investment_dashboard/ui/pages/*.py`, `ui/layout.py`, `ui/components/`,
`ui/copy/tooltips.py`; web companion `web/src/{ui,app,tour,freshness,holding-status,types}.ts`,
`styles.css`. Field names are the v5 web export keys (snake_case, `types.ts`) or the desktop
readmodel names (`PortfolioMetrics`, `HoldingCard`, `PeriodRow`, `MoversView`, `AnalyticsBundle`,
`CalcData`). v6 should expose the same facts from `/api/*`, but after the currency refactor
(plan section 2) as native amounts + a `ccy` param, not `_eur/_usd` pairs.

Legend: **D** = desktop v5 (NiceGUI), **W** = web v5 (phone PWA). "Kit" = component-kit names from
the design brief. Tooltip copy lives in `ui/copy/tooltips.py` (`TOOLTIPS[key]`) and `METRIC_INFO`
in `web/src/ui.ts`; port both into one `lib/copy.ts`.

Cross-cutting facts used by every page:
- Money = display currency large, other currency small underneath ("dual" KPI). Both UIs.
- Sign colour plus an arrow glyph for colour-blind redundancy (D `arrow_for_signed`; W `trendGlyph`). Keep the arrow.
- Freshness is a per-holding and per-page concern (see Global UX).

---

## 1. Login

**D has:** no login (local app). Header only has brand, version pill, power button.

**W has:**
- Lock screen: passphrase input + "Unlock"; "Unlock with fingerprint" (WebAuthn) when enrolled.
- First-run setup form (config, API keys, passphrase) - obsolete in v6.
- Auto-lock after idle (minutes; 0 = never), "Stay unlocked across a page refresh", topbar "Lock" button, version footer.
- Demo mode with guided tour.

**v6 page spec:**
- Single centred `Card`: brand mark + name; password `Field` (show/hide `IconButton`), "Sign in" primary, divider, "Sign in with passkey" secondary; version in footer.
- States: submitting (busy button, inputs disabled); 401 inline "Wrong password" (no toast); 429 rate-limit message with retry-after; passkey cancelled = silent; passkey unsupported = hide button.
- Autofocus password, Enter submits, `autocomplete="current-password"`, WebAuthn conditional UI.
- After login redirect to the originally requested route; any 401 returns here. Idle lock becomes a server session policy; show "Session expired" notice here.
- Kit: Card, Field, Input, Button, IconButton, Icon, Toast (network failure only).
- Data: `GET /api/auth/me {authenticated, passkeys}`; show passkey button always (registration needs a prior login anyway) or only when `passkeys > 0` (owner decision; recommend always).

**Copy:** "Unlock" -> "Sign in"; "Unlock with fingerprint" -> "Sign in with passkey".

---

## 2. Overview

**D has (`pages/overview.py`, in page order):**
- **Hero "Total Value"**: display ccy large, other ccy line under, change badge `arrow +x.xx% today|yesterday|Fri 26 Jun` (label names the real session; never "today" on a frozen weekend).
- **KPI grid 4x2** (dual currency, display ccy primary, tooltip on each):
  - Row 1: Total Invested (`total_contributions_*`), Capital Gain (`capital_gain_*`), XIRR (`xirr`/`xirr_usd`), Vs Market ("Beating the market" / "Trailing the market"; sub `You x% - VT y%`; "Need VT history to compare" when absent).
  - Row 2: Total Growth (`total_growth_compounded_*`), YTD Growth (`ytd_growth_pct*`), MTD Growth (`mtd_growth_pct*`), Today tile (title Today/Yesterday/date, pct + other-ccy pct, absolute money, live/clock stamp top-right).
- **Currency box "Currency - EUR <-> USD"** (below the KPI grid): live spot (USD display shows EURUSD, EUR display shows reciprocal), today's rate move %, currency effect on the USD-booked book (EUR display) or "Investing power" (USD display: `amount_eur * (live_fx - prev_fx)` on the regular investment amount). Diverging bar splits the move into market-hours vs overnight legs. Regimes: live/settled, weekend "Market closed - reopens Sun ..." (frozen Friday view), Sunday-evening spill-over, US-holiday single overnight number; "EOD FX" stamp; anchor-warning badge when prior close missing; phrase "since last open/close".
- Caption lines: weighted expense ratio (`weighted_expense_ratio`, ~annual cost), dividend total return (`dividend_yield_pct`), dividend yield TTM (`dividend_yield_ttm_pct`, last 12 mo cash `dividends_ttm_*`).
- **Value over time** (Plotly): range toggle (`Day`/`Week`/... 1D 1W 1M YTD 1Y All), reload-graph button (tooltip "Reload 1D graph"), other-currency companion line on right axis for ranges >= 1 week, previous-close reference line on Day, weekend/overnight range-breaks on Week, in-place live redraw on Day while market open, range persisted in URL. Empty: "No value history yet".
- **Top movers** collapsible band (open by default): header star + "Top movers" + basis ("today" or "last close - 20 Jun"); up to 2 winners + 2 losers; block = Winner/Loser label, tag "biggest move" (ranked by money) or "top %", symbol + name, ranked figure large then the other.
- Warnings: zero-value symbols ("stale value"), bad history ("bad history").
- **Holdings** section: "N positions - largest first", button "Full table & detail"; card grid. Card: left rail tinted gain/loss; symbol + pills (PAR = money market, "stale value", "bad history"); "as of ..." top-right; name; value, today % + arrow, today money; other-ccy value; mover badge; stats grid (Total Growth, P/L, XIRR, YTD, Price in native symbol, Shares, Cost basis, Expense). Stale daily move greyed, tooltip "Not updated today - last session's move".
- **Allocation** treemap (Plotly) per instrument in display ccy.
- Empty: "No positions yet - Go to Transactions -> Import CSV to load broker data, or seed defaults from Settings."

**W has (`renderOverviewPanel`, order):**
- Hero: "Total value", dual value, change badge (glyph + signed money dual + pct + session word); **value-basis chip** top-right: pulsing green "Live" (NYSE open + same-day quote), else "Today" or the price date ("20 Jun").
- Returns segment row: [Today|Yesterday|date] / This month / This year.
- FX box (same content as D currency box; "Market closed" pill, "Frozen at Friday's close - reopens ...", "EOD FX").
- Value chart: ranges 1D, 1W (live) + 1M, 1Y, All (history slices that fit; 3M/6M behind Settings "Extra ranges"), per-graph refresh-bars button (tooltip "Re-pull 1D price bars for today's session (uses live credits)"), hover/tap crosshair, range remembered per device, chart height remembered, delayed placeholder to avoid flicker, EUR/USD lines diverge on toggle.
- Stats grid (6): Total gain (signed dual), Total growth, XIRR, Div. return, Invested (dual), Dividends YTD.
- Notes: coverage line (live / updating / cached / at last close / awaiting) + `?` legend (`<details>`), degraded-provider warning, "No live price or last-known value for X, so they are excluded from totals.", "Using the last exported value for X", "Missing FX rate for X", "Exported ... last pulled ...", credit budgets (budget lines OBSOLETE in v6).
- Top movers band (same logic).
- Holdings collapsible (state remembered), sorted by value desc, count "N positions"; row = symbol + pills (NAV/PAR price type, "stale value", mover badge), "as of <date>" with green check when current after close, name, value + today %; chips `Px native`, `N sh`, `+x% growth`, `P/L dual`, `XIRR`; per-holding status row (Updated / Updating / Queued with countdown "in 12s" + pulsing dots).
- Allocation: collapsed `<details>` by asset class (bar, %, value).
- Disclaimer: "Read-only. Live figures are computed in your browser from public market data and may differ slightly from your broker."
- Topbar: brand (full on desktop, "Investments" on phone), currency toggle, Refresh (spins; tooltip "Last updated ..."), Settings gear, Lock.

**v6 page spec:**
- **Desktop (12 col):** row A Hero card (c1-4) + Currency card (c5-12: spot, move, effect, diverging bar); row B 8 `KpiTile`s (4x2); row C `Chart` (c1-8) + Top movers (c9-12); row D holdings cards with "Full table" link; row E Allocation treemap (c1-6) + asset-class bars (c7-12).
- **Phone:** hero, 3-segment returns row (Today/MTD/YTD), currency card, chart, KPI 2-col grid, movers (collapsible), holdings list rows, allocation (collapsed).
- **Union features:** all D hero/KPI/currency/caption/chart/movers/holdings/allocation items; W value-basis chip merged into global `Freshness`; info dot (`?`) on every KPI label linking to Help; per-holding Updated/Updating; Vs Market tile; expense + dividend strip as 3 small stats; return decomposition (investment return vs currency effect, plan section 2.4) as hero sub-line; chart ranges 1D/1W/1M/3M/6M/YTD/1Y/All always on (drop opt-in); click legend to toggle other-ccy line.
- **Dropped (obsolete):** provider/credit budgets, "Exported ... last pulled", reload-graph credit tooltips, queue countdowns, Lock, Quit, Plotly.
- **Kit:** PageHeader, Card, KpiTile (+DeltaBadge, sparkline slot), Money, Percent, Chart, Treemap/AllocationBar, Freshness, Tooltip, Skeleton, EmptyState, ErrorState, Sheet, Menu.
- **States:** loading = skeleton hero + 8 tiles + chart block; cached data paints instantly with subtle refreshing state on Freshness; empty = EmptyState "No positions yet" with CTAs "Import transactions" -> /import and "Add manually" -> /transactions; error = inline ErrorState per card (a failed chart never blanks the page); FX missing = base ccy only + chip "FX rate unavailable".
- **Data:** `GET /api/overview?ccy=` -> `{as_of, generated_at, display_ccy, fx_rate, fx_prev, total_value, total_invested, capital_gain, xirr, total_growth_compounded, ytd_growth_pct, mtd_growth_pct, daily_growth_pct, daily_move, daily_label, dividend_yield_pct, dividend_yield_ttm_pct, dividends_ttm, weighted_expense_ratio, annual_expense_cost, market_verdict {beating, portfolio_return, benchmark_return, benchmark_symbol}, currency_box {spot, rate_move_pct, effect, regime, reopen_at, legs[], investing_power}, movers {basis_date, winners[], losers[]}, warnings {zero_value[], bad_history[], missing_fx[]}, price_observed_at, price_market_at, is_live}`; chart `GET /api/graphs/{range}?ccy=` (points, `prev_close`, `secondary_series`, `session_breaks`); holdings/allocation from their endpoints.

**Copy:** "Total Value"; "Capital Gain"; "Vs Market"; "Beating / Trailing the market"; "Need VT history to compare"; "Currency - EUR <-> USD"; "Top movers" with tags "biggest move" / "top %"; basis "last close - 20 Jun"; TOOLTIPS keys `total_value, total_invested, total_gain, xirr, total_growth_compounded, ytd_growth, mtd_growth, daily_growth, expense_ratio, dividend_return, dividend_yield, fx_rate, market_verdict`; stale move: "Not updated today - last session's move".

---

## 3. Holdings

**D has (`pages/holdings.py`, "Every position in full detail"):**
- KPI strip (dual): Total Value, Total Growth, XIRR, Capital Gain.
- "Portfolio shape" stats: Holdings (`N up - M down`), Best performer, Worst performer, Most concentrated, Dividend return, Dividend yield, Weighted expense, Current FX (tooltip `fx_rate`).
- "All holdings" AG-Grid: pinned Symbol, resizable/sortable, auto height, horizontal scroll, gain/loss row tint. Columns: Symbol, Name, Category (filter), Shares, Avg Price, Current Price, As Of, Expense, Cost Basis, Value (default sort desc), Capital Gain, XIRR, Total Growth, YTD Growth, MTD Growth, Today, Weight (% of portfolio).
- Zero-value / bad-history warnings; empty "No positions yet".

**W has:** only the Overview holdings list (rows above). No table, no weight, category, avg price, MTD or expense per holding.

**v6 page spec:**
- Desktop: KPI strip -> shape summary -> `DataTable` (sticky header, sortable, column menu, `/` search, category filter chips, "Show closed positions" switch). Columns = D set + Day move (money) + P/L % + weight bar inside Weight cell + freshness dot in As Of. Row click opens a right `Dialog` drawer with holding detail (its transactions, native + display values, cost basis, XIRR/TWR, dividends, expense, price history sparkline).
- Phone: list rows like W (symbol, name, value, today %; chips Px / sh / growth / P/L / XIRR), sort `Select` (Value, Today, Growth, Weight, Symbol), tap opens `Sheet` detail.
- New: group-by switch (None / Asset class / Category / Account) unifying D Category and W asset class.
- States: skeleton rows; EmptyState + import CTA; row chips "stale value", "bad history", "no price"; partial failures keep the table.
- Kit: PageHeader, KpiTile, DataTable, SegmentedControl, Select, Dialog/Sheet, Badge, Freshness, Money, Percent, EmptyState.
- Data: `GET /api/holdings?ccy=` -> `[{symbol, name, category, asset_class, account, native_currency, shares, avg_price_native, price_native, price_as_of, price_type (market|nav), is_money_market, expense_ratio, cost_basis, value, capital_gain, xirr, total_growth, ytd_growth, mtd_growth, today_pct, today_move, weight_pct, value_warning, price_data_warning, daily_is_stale}]` + `summary {best, worst, most_concentrated, gainers, losers}`.

**Copy:** "Every position in full detail"; pills "PAR", "NAV", "stale value", "bad history"; "Most concentrated"; "Best/Worst performer".

---

## 4. Periods (monthly / yearly)

**D has:** two pages.
- **Monthly Growth** ("Aggregated cashflows and mark-to-market"): bar chart "Monthly growth % (ccy)" (colour by sign) + paginated (12/page) newest-first grid: Month, Contributions, Dividends, Interest, Net flow, Closing value, Growth % (period) (chained daily TWR, Modified-Dietz fallback), Total Growth (`(1+XIRR)^years - 1`). Empty months before first investment are padded. Long footnote explains each column.
- **Yearly Growth** ("Annual aggregation and growth over time"): line chart of value (with other-ccy secondary line) + same table with Year; Growth % (period) = per-year XIRR.
- One currency at a time (follows header toggle).

**W has (Periods tab, two columns):** left = year groups, collapsible, current year open; each period row: label + "live"/"current" pill, `Value dual`, growth % large + "growth", chips Net flow / Contrib / Div / Int. Right = Contributions panel (see 5) then Projection (see 7). Disclaimer: "The current month and year are recomputed live; completed periods are frozen as of the last export. Projected years are hypothetical and assume constant returns."

**v6 page spec:**
- `Tabs` **Monthly | Yearly** at `/periods/monthly|yearly`, remembered.
- Desktop: top `Chart` (monthly = signed growth bars; yearly = value line + contributions + other-ccy line), then `DataTable` newest-first. Monthly view groups by year with expandable year subtotal rows; "live"/"current" row badge; sticky totals row; Opening value column (web export has `opening_value_*`); Export CSV button (new).
- Phone: year-grouped list (W), tap opens `Sheet` with all columns; chart collapsible.
- Contributions move to Activity (5); Projection to Plan (7).
- Currency: table in active ccy; secondary ccy via second line / tooltip on wide screens.
- States: skeleton; EmptyState "No periods yet"; live row has pulsing "live" badge; padded empty months muted.
- Kit: Tabs/SegmentedControl, Chart, DataTable, Percent, Money, Badge, Sheet.
- Data: `GET /api/periods?granularity=month|year&ccy=` -> `[{label, is_current, is_live, opening_value, closing_value, contributions, dividends, interest, net_flow, growth_pct, total_growth_pct}]`; growth method note (monthly chained TWR, yearly XIRR) as column info dot.

**Copy:** "Growth % (period)", "Total Growth"; "live", "current" pills; "Empty months before your first investment are padded so the history is contiguous."

---

## 5. Activity (deposits + dividends)

**D has (`pages/deposits.py`, "Deposits and withdrawals"):** KPIs (dual): Total contributed, YTD contributions, MTD contributions; "Cash-flow ledger" grid (auto page size): Date, Account (filter), Kind (filter), Amount (EUR), Amount (USD) (native amount in tooltip), Description. Empty: "No deposits recorded - Import a broker CSV from Transactions, or add manual rows there." Dividends exist only as Monthly/Yearly columns and Overview captions.

**W has:** Contributions panel in Periods (stat triplet total / this year / this month; per-year `<details>` with row count + year total; rows: kind label, `date - account`, dual amount). "Activity" tab is the transactions ledger (section 8). "Dividends YTD" stat on Overview. Empty "No contributions yet."

**v6 page spec:**
- `Tabs`: **Contributions | Dividends & interest** (new view from `dividends_*`/`interest` period columns and ledger kinds `dividend_cash`, `dividend_reinvest`, `interest`).
- KPI row: Total contributed, YTD, MTD, Net of withdrawals; after FX refactor also "Effective rate you paid" and "USD pool balance".
- Contributions: monthly bars + cumulative line `Chart`; ledger `DataTable` grouped by year with year totals; filters Account / Kind / date range; each row shows native amount, display amount, rate used (badge "actual rate" or "ECB fallback", plan 2.5).
- Dividends: table per holding (TTM, YTD, lifetime, yield) + monthly bars.
- Phone: year accordions (W), rows kind + `date - account` + dual amount.
- States: skeleton; EmptyState "No deposits recorded" with Import / Add CTAs.
- Kit: Tabs, KpiTile, Chart, DataTable, Badge, EmptyState, Money.
- Data: `GET /api/deposits?ccy=` -> `{summary {total_contrib, ytd_contrib, mtd_contrib}, rows [{id, date, account, kind, amount_native, currency, amount, rate_used, rate_source, description}]}`; `GET /api/dividends?ccy=`.

**Copy:** "Total contributed", "YTD contributions", "MTD contributions", "No deposits recorded".

---

## 6. Risk (Analytics)

**D has (`pages/analytics.py`):**
- Lookback toggle 1M / 3M / 6M / 1Y / 3Y / 5Y + `start -> as_of`.
- KPI groups: *Overview* (Portfolio value dual, Total Growth dual pct, Capital gain dual); *Returns* (CAGR, TWR, XIRR); *Risk & volatility* (Volatility, Sharpe, Sortino, Skew, Excess Kurtosis); *Drawdown & tail risk* (Max Drawdown, Calmar, Ulcer Index, VaR (95%), CVaR (95%)); *Benchmark & market* (Beta, Alpha, Risk-free rate with source sub, Benchmark symbol, "vs VT (funded)" money diff + pct "vs same contributions in the index"). Tooltips on all.
- Equity curve (Plotly): Portfolio vs Net invested vs Benchmark. Empty "Not enough history yet - Import some transactions or wait for the daily snapshot to populate."
- "Currency (EUR <-> USD)" section with explainer + KPIs: EUR/USD now (sub `avg when you invested`), Euro move since investing (coloured by favourability; sub "euro weaker -> tailwind for you" / "euro stronger -> headwind"), Currency effect on return (EUR return minus USD return, pp), FX gain / loss (EUR), If you transfer back now.
- Per-instrument attribution grid: Holding, Start, End, Net added, P&L, % of return, Total row. Empty "No attribution data".

**W has (Risk tab):** cards *Returns* ("as of <date>") and *Risk* ("vs VT"), each stat with info dot (tap-to-pin, Esc / tap-away dismiss, `METRIC_INFO`); Equity curve (portfolio vs benchmark, rebased, legend, hover); Currency-effect card (both currencies, "avg in", "value back in EUR", "at 1.0850"); Attribution list (8 per page, prev/next pager, Total row); Drawdown chart; no lookback selector (fixed export window); disclaimer "Risk metrics are as of the last desktop export ... don't move intraday." Metric `kind`: pct | ratio | money; per-ccy values (`*_usd`).

**v6 page spec:**
- Page-level `SegmentedControl` lookback 1M/3M/6M/1Y/3Y/5Y/All (default 1Y), remembered.
- Desktop 2-col grid (phone 1-col): Returns, Risk & volatility, Drawdown & tail, Benchmark cards (small `KpiTile` with info dot); Equity curve `Chart` (portfolio, net invested, funded benchmark, series toggles, rebase-to-100 switch); **Drawdown chart** (underwater plot, from W); Currency card (D 5 KPIs + W avg-in); Attribution `DataTable` (phone paged like W; % of return as bar).
- Colour only signed metrics (returns, alpha, excess, vs index); ratios neutral.
- States: skeleton tiles; chart EmptyState "Not enough history yet"; null metric shows `—` with tooltip "Needs more history"; risk-free source badge ("^IRX live" vs "manual").
- Kit: SegmentedControl, KpiTile, Tooltip, Chart, DataTable, EmptyState, Percent, Money.
- Data: `GET /api/analytics?ccy=&lookback_days=` -> `{start, as_of, cagr, twr, xirr, volatility, sharpe, sortino, max_drawdown, calmar, ulcer, var_95, cvar_95, skew, kurtosis, beta, alpha, risk_free_rate, risk_free_symbol, risk_free_source, benchmark_symbol, benchmark_is_funded, curve [{date, portfolio_value, cumulative_contributions, benchmark_value}], drawdown [{date, dd}], attribution [{symbol, start_value, end_value, net_contribution, absolute_pnl, pct_of_total_return}], currency_effect {current_rate, avg_invest_rate, rate_change_pct, currency_effect_pp, fx_pnl_eur, repatriation_value_eur}}`.

**Copy:** all risk keys in `TOOLTIPS` (D) and `METRIC_INFO` (W) overlap - keep D wording for Sharpe/Sortino/VaR/CVaR, W wording for CAGR/TWR/Alpha; "You fund in EUR, hold USD assets, and would convert back to EUR - so the EUR/USD move between paying in and cashing out is its own gain or loss on top of the assets"; "euro weaker -> tailwind for you"; "same contributions in the index".

---

## 7. Calculator / Projection

**D has:** two pages.
- **Projection** (`/projection`, "Project your portfolio forward in both currencies"): Yearly/Monthly toggle (persisted). Inputs: Expected return % p.a. (seeded from XIRR; tooltip `projection_expected`), +/- band (pp, default 3), Contribution per period, Annual step-up % (0), Inflation % (2), Target value, Horizon slider, switch "Show in today's money (real)". KPIs: Expected value, Optimistic, Pessimistic, Additionally contributed, Projected growth (real|nominal). Chart: three scenario lines "Projected value over the next N years". **Goal card**: "Reaching X: Pessimistic/Expected/Optimistic: <label (n yr)> | not within horizon"; "To reach it by the end of the horizon at the expected return, contribute about X per year." or "Even large contributions can't reach this target within the horizon - extend the horizon or raise the expected return." Table "Year-by-year detail": Period, Contributed, Pessimistic, Expected, Optimistic.
- **Calculator** (`/calculator`): summary KPIs (Portfolio value dual, Holdings, Categories). Step "1 - How much are you investing?": Cash to invest, EUR/USD toggle, checkboxes "Allow fractional shares", "Rebalance (allow selling)" (tooltip "Off = buy only. On = sell over-weight funds to balance precisely."), prefs persisted. Step "2 - Set your target mix": By category / By fund toggle; presets Match current mix, Equal weight, Load saved target, Clear; helper "Enter a target % per row. Totals are normalised to 100 % when you compute, so you can sketch freely."; total progress bar + label; per category: now % and value, current-vs-target bar, Target % input, expansion "Funds in this category" with Split toggle "Fair by value / Even" and per-fund checkboxes ("Untick a fund you don't invest in ..."). Buttons Compute plan, Save as target... (dialog: Name, "Activate (drive allocation-drift views)", "N funds - sums to 100 %"). Result: "Plan summary" KPIs (Investing with "% of wealth", Buying, Selling, Left over - all dual) then "Buy plan"/"Rebalance plan" (category-grouped or flat sorted by add amount, before/after %). Toasts: "Set at least one fund target", "Cannot rebalance: ...".

**W has:** Calculator tab (`panel-calc2`) with the same builder (category/fund modes, presets, Compute plan, Plan summary, "Load saved target...", Split Fair by value/Even, fractional + rebalance prefs persisted). Projection form lives in Periods (monthly/real/rate/band/step-up/inflation/horizon/contribution/target persisted in EUR; KPIs, goal output, table; sub-label "forward outlook"). Tour caption: "A what-if calculator projects future value from your current mix, contributions and an expected return band - all offline."

**v6 page spec:**
- One **Plan** page with `Tabs`: **Projection | Rebalance calculator** (`/plan/projection`, `/plan/calculator`). Saving a target belongs to Allocations (11); calculator links there.
- Projection: assumptions `Card` (sticky left on desktop; "Edit assumptions" `Sheet` on phone): Expected return (prefilled XIRR + "reset"), band, Contribution/period (prefilled `investment_amount`), Step-up, Inflation, Target, Horizon slider, Monthly|Yearly, Real|Nominal switch. Right: 5 KPI tiles, `Chart` fan (pessimistic-optimistic band, expected line, contributions line), Goal card, detail `DataTable` (collapsible on phone). Server computes (`POST /api/projection`, debounced 300 ms); params persisted via `/api/settings`; no client maths.
- Calculator: vertical steps 1 Cash, 2 Target mix, 3 Plan; same controls; plan table shows before/after allocation bars; "Copy plan" and "Export CSV" (new); phone: sticky "Compute plan" bar, category accordions.
- Persist: fractional/rebalance prefs, mode, cash, split choices.
- States: chart dims (not blank) while recomputing; inline Field errors instead of toasts; total pill turns warn when != 100 ("will be normalised"); no accounts/instruments -> EmptyState "Add an account and an instrument in Settings, then come back"; infeasible goal text as D.
- Kit: Card, Field, Input, Select, SegmentedControl, Switch, Slider (Radix), Chart, KpiTile, DataTable, Dialog, Sheet, Tooltip, Toast, EmptyState.
- Data: `GET /api/projection/seed?granularity=&ccy=`; `POST /api/projection {granularity, expected_return, band_pp, contribution, step_up_pct, inflation_pct, target, horizon, real}` -> `{points [{label, years, contributed, pessimistic, expected, optimistic, *_real}], total_contributed, hits {scenario: {label, years}|null}, required_contribution}`; `GET /api/calculator` -> `{display_ccy, total_value, instruments [{instrument_id, symbol, name, category, current_value, current_pct}], categories [{name, current_pct, current_value, members[]}], saved_target?}`; `POST /api/calculator/plan {cash, ccy, mode, weights, allow_fractional, allow_sell, selected, split}` -> `{rows [{instrument_id, current_value, add_value, shares_delta, after_pct}], residual_cash}`.

**Copy:** "How much are you investing?", "Set your target mix", the helper and Split texts above, "Rebalance (allow selling)" tooltip, goal-card sentences, `projection_expected` tooltip ("default growth assumption is your portfolio's own historical XIRR").

---

## 8. Transactions

**D has (`pages/transactions.py`, "Master ledger"):**
- KPIs: Transactions, Buys, Sells, Avg trade size.
- Filters: Account ("All accounts"), Kind ("All kinds"), Symbol (upper-cased), switch "Show settlement sweeps" (tooltip: auto-generated VMFXX legs hidden by default, still count toward balance).
- Buttons: New transaction, Edit instrument, Import.
- Grid columns: edit pencil (header tooltip "Edit transaction"), Date, Account, Kind, Symbol, Qty, Price, Fees, Net EUR, Net USD, Source.
- **New/Edit Transaction dialog**: Account, Kind, Date (text "YYYY-MM-DD"), Symbol, Quantity, Price, "Total cost / amount (native)", Fees, Description, checkbox "Auto-fill the money-market fund for cash transfers" (tooltip: deposits / withdrawals / transfers also buy or sell the account's settlement fund so you don't log it twice), live reconcile hint, validators (non-negative decimals), Cancel / Delete (confirm) / Save; toasts "Saved", "Updated", "Deleted", "Bad date - use YYYY-MM-DD", "Fix the highlighted fields first", "Pick an account", "Transaction not found - it may have been deleted".
- **Edit instrument** dialog: Symbol, "Display name override", "Asset class override", "Expense ratio override (e.g. 0.0003)", effective-value readout; "Overrides only affect what's shown - the ledger row is untouched."
- Kinds: buy, sell, dividend_cash, dividend_reinvest, deposit, withdrawal, interest, fee, transfer_in, transfer_out, split.

**W has (Activity tab, opt-out in Settings, read-only):** "Activity" + count; search "Search symbol, account, kind..."; selects: All types, time range (All time / Last 30 days / Last 90 days / Last 12 months / This year), sort (Newest first / Oldest first); rows grouped by calendar month; row = kind label (kind class colour), date label, symbol, account, qty x price, fees, net (picked ccy + other), source. Empty "No transactions recorded yet."; filtered-empty "No transactions match your filters."; "not included in this export" state.

**v6 page spec:**
- Desktop toolbar: search (`/`), Account, Kind multi-select, date range, Symbol, "Show settlement sweeps" switch, "New transaction" primary, "Import" link. `DataTable` (sticky header, right-aligned numbers, 50/page or virtualised): Date, Account, Kind (coloured chip), Symbol, Qty, Price (native), Fees, Net (native), Net (display), Source badge, row `Menu` (Edit, Duplicate, Delete). KPI chips: Transactions, Buys, Sells, Avg trade size.
- Phone: month-grouped list rows (W), filters in `Sheet`, FAB "+" opens form `Sheet`.
- **Form** (`Dialog` desktop / `Sheet` phone): Account, Kind (field set adapts: trades = symbol/qty/price/fees; cash kinds = amount), Date picker, Symbol with ticker validation, Quantity, Price, Total (native), Fees, Currency (default from instrument), Description; money-market auto-fill checkbox + tooltip; inline reconcile hint; Delete via confirm `Dialog`; unsaved-changes guard.
- Instrument override form reachable from Holdings row menu and Settings.
- States: skeleton rows; EmptyState "No transactions yet" with Import + Add; filtered-empty; delete shows Toast with Undo (8 s); server validation errors mapped to Field errors.
- Kit: DataTable, Input, Select, Field, Dialog, Sheet, Menu, Toast, EmptyState, Switch, Badge.
- Data: `GET /api/transactions?account=&kind=&symbol=&from=&to=&sweeps=&q=&cursor=` -> `{summary {count, buy_count, sell_count, avg_trade}, rows [{id, date, account, account_id, kind, symbol, quantity, price_native, fees_native, gross_native, net_native, currency, net, source}], next_cursor}`; `POST/PUT/DELETE /api/transactions[/id]`; `PUT /api/instruments/{id}/override`.

**Copy:** the settlement-sweep and money-market tooltips; "Overrides only affect what's shown - the ledger row is untouched."; kind labels via Title Case but prefer "Dividend (cash)", "Dividend (reinvested)".

---

## 9. Import

**D has:** dialog inside Transactions, "Import broker CSV / XLSX": "Drop your file first, then pick the broker and account - the import only runs when you press Import." Broker select (Fidelity default, Vanguard), Account select, upload (`.csv,.xlsx`, auto-upload stashes bytes), status line, Close / Import; result toast with counts and notes; "Upload a file first", "Pick an account first", "Import failed: ...". Parsers are broker plugins emitting `ParsedTransactionRow`.

**W has:** nothing (read-only).

**v6 page spec (`/import`, upload -> preview -> confirm):**
1. **Upload**: drag-and-drop + picker (csv/xlsx), Broker `Select` (auto-detected from headers, overridable), Account `Select` (or inline "Create account").
2. **Preview** (server dry-run, nothing written): chips New N / Duplicate N / Skipped N / Errors N; `DataTable` of parsed rows with status (new / duplicate / error + reason), per-row include checkbox; warnings banner (unknown symbols, missing currency, FX gaps).
3. **Confirm**: "Import N transactions"; progress; success summary with links "View transactions" and "Run data health check"; idempotent (dedupe key) so re-upload is safe; "Undo this import" by batch id (new).
- Stepper header (Upload / Preview / Done), Back / Cancel. Phone: single column, rows as list.
- States: parse failure = ErrorState with parser message + "Download sample format"; empty file; partial success.
- Kit: Card, Select, Field, DataTable, Button, Badge, Toast, EmptyState/ErrorState, Skeleton.
- Data: `POST /api/imports/preview` (multipart file, broker, account_id) -> `{batch_id, rows [{line, date, kind, symbol, quantity, price, currency, amount, status, reason}], counts, warnings[]}`; `POST /api/imports/{batch_id}/confirm {exclude_lines[]}`; `DELETE /api/imports/{batch_id}`; `GET /api/imports/brokers`.

**Copy:** "Drop your file first, then pick the broker and account - the import only runs when you press Import."

---

## 10. CurrencyConversions (new in v6)

**D / W have:** nothing. Only frozen `net_eur/net_usd/fx_rate_to_eur` on transactions. Related: Analytics Currency section ("avg when you invested", "If you transfer back now"), `investment_amount_eur` setting, Overview Investing-power panel.

**v6 page spec (plan section 2.5):**
- KPI row: USD pool balance, Average rate paid (blended), Total EUR sent, Total USD received, Fee total, Spread vs ECB (%).
- `DataTable` of batches: Date, EUR sent, USD received, Effective rate (`USD/EUR`), Fees, Note, Remaining in pool, ECB rate that day, Spread; row `Menu` (Edit, Delete). "Add conversion" `Dialog`/`Sheet`: Date, EUR sent, USD received, Fees (optional), Note; live effective-rate readout; warn when > 3 % off ECB.
- **Matching panel**: each USD deposit with the batches it consumed (FIFO), blended rate, "ECB fallback" badge for uncovered remainder (links to Diagnostics).
- Phone: batch list rows, KPI 2x2.
- States: EmptyState "No conversions yet - until you add them, EUR returns use the ECB daily rate" + Add CTA; skeleton; inline validation; delete confirm warns EUR returns will be recomputed.
- Kit: KpiTile, DataTable, Dialog/Sheet, Field, Input, Badge, Tooltip, EmptyState.
- Data: `GET /api/fx-conversions` -> `{conversions [{id, date, eur_sent, usd_received, fees, note, effective_rate, ecb_rate, remaining_usd}], pool {balance_usd, avg_rate}, matches [{deposit_id, date, usd_amount, parts [{conversion_id, usd, rate}], fallback_usd, fallback_rate}]}`; `POST/PUT/DELETE /api/fx-conversions[/id]`.

**Copy (new):** "Your real conversion rate"; "Each USD deposit uses the oldest conversions first (FIFO)"; "Any uncovered part uses the ECB rate".

---

## 11. Allocations

**D has:** Settings -> "Target allocations" (list, activate one). Real builder is the Calculator (target mix + "Save as target..."; "Activate (drive allocation-drift views)"). Tooltip `drift`: "Difference between current allocation and target allocation. Positive means over-allocated; negative means under-allocated." Overview treemap. Repo items: instrument, `weight_pct`, `no_buy`, `allow_sell`.

**W has:** Overview "Allocation" by asset class (collapsed bars + % + value); Calculator "Load saved target...". Export `target_allocations` = `{name, active, allow_sell, items [{instrument_id, symbol, weight_pct, no_buy}]}`.

**v6 page spec (`/allocations`):**
- Top: current vs target `AllocationBar` pair; Treemap toggle (instrument / category / asset class).
- **Drift table** (`DataTable`): Group/Instrument, Current %, Target %, Drift pp (coloured + bar), Current value, Amount to buy/sell to hit target; sort by |drift|; group-by Instrument / Category.
- **Target editor** `Card`: saved targets `Select` + "New target", name, active switch, weights table with `no_buy` and `allow_sell` flags, total badge (100 or "normalise on save"), presets Match current / Equal weight / Clear, Save / Duplicate / Delete.
- **Rebalance plan** panel: cash input (or rebalance only), fractional switch, allow-selling switch, "Compute plan" -> shared result table (shares, amount, residual cash), "Copy as text" / "Export CSV", link "Open in calculator".
- Phone: tabs inside page Drift | Targets | Plan; drift as list with progress bars.
- States: EmptyState "No target yet - build one"; unsaved-changes banner; infeasible plan as inline ErrorState with reason; skeleton.
- Kit: AllocationBar, Treemap, DataTable, Select, Field, Switch, Tabs, Card, Dialog, Toast.
- Data: `GET /api/allocations` -> `{targets [{id, name, active, allow_sell, items [{instrument_id, symbol, category, weight_pct, no_buy}]}], drift [{key, label, current_pct, target_pct, drift_pp, current_value, delta_value}], current_by_category[], current_by_asset_class[]}`; `PUT /api/allocations`; `POST /api/allocations/plan`; `POST /api/allocations/{id}/activate`.

**Copy:** `drift` tooltip; "Activate (drive allocation-drift views)"; "Totals are normalised to 100 % when you compute, so you can sketch freely."

---

## 12. Settings

**D has (`pages/settings.py`, ~2.4k lines, collapsible groups):**
- *Preferences*: **Display preferences** - Primary display currency toggle ("Switches every page's KPIs, tables and charts."), Timezone select, Clock format (12/24) toggle, "Auto-update prices every" N min, "Regular investment amount" (EUR sent regularly; feeds Investing power). **Analytics preferences** - Benchmark symbol (+Save; "Default: VT (Vanguard Total World)."), Risk-free symbol (+Save, "Refresh now", cached value), Manual override ("Pins Sharpe / Sortino / Alpha to your chosen rate. Leave blank to use the live ^IRX feed."). Theme cycles in header (system/light/dark).
- *Data & connectivity*: **Data refresh** buttons - Refresh FX rates, Refresh prices, Reload 1D graph, Reload 1W graph, Reload all graphs, Refresh via Tiingo, Recalculate FX-derived values (confirm), Seed default setup (confirm); busy states. **Connectivity** - provider status chips (yfinance, Frankfurter, Tiingo) with last call result, "Recent activity" expansion, "Probe a price service", Tiingo fallback controls + hourly/daily caps + usage panel.
- *Portfolio setup*: **Accounts** (list; Add/Edit: Label, Account type, Active); **Instruments** (Add: Symbol, Name, Asset class, Category, Native currency, Expense ratio, "Fetch from market data" auto-fill; edit; overrides); **Target allocations**.
- *Storage & sync*: Storage (db paths, sync folder, SQLCipher passphrase, recovery file, move ledger), Server (auto-shutdown, hand-off lock, Shut down), Live web companion (publish passphrase, GitHub token, Tiingo token, "Publish now", last published).
- *Diagnostics & logging*: log level, support bundle, audit export, Developer tools.
- *Reset data*: levels cache / transactions / everything, confirm dialog. Help & documentation link.

**W has:** Appearance (theme system/light/dark, time format 12/24, timezone device/market); Security (auto-lock minutes, "Stay unlocked across a page refresh", fingerprint enrol); Backup (export/import portable config "Keep the file private - it holds your API key"); Graphs ("Extra ranges": adds 3M & 6M); API key/provider settings, refresh interval, "reset & re-pull everything", "Probe a price service", provider usage meter. Currency toggle is in the topbar only.

**v6 page spec (`/settings`, left sub-nav on desktop, stacked list on phone; autosave with inline "Saved" or explicit Save):**
1. **General**: Reporting currency (`SegmentedControl`), Theme (System/Light/Dark), Timezone (`Select`; default browser; market-time option), Clock 12/24, Number locale (new), Regular investment amount (EUR) with help text.
2. **Analytics**: Benchmark symbol (validated), Risk-free: auto (^IRX) / manual %, cached value + "Refresh now".
3. **Portfolio**: Accounts table (Add/Edit/Archive: label, type, broker, base ccy, active); Instruments table (Add with "Fetch from market data", overrides: name, asset class, category, expense ratio, native ccy; ticker validation). Targets link to Allocations.
4. **Security**: Change password; Passkeys list (name, added, last used, Remove, "Add passkey"); sessions + "Sign out everywhere" (new).
5. **Data & backup**: "Download backup", audit CSV export, support bundle, Reset data (three levels; `Dialog` requiring typed confirmation), "Recalculate FX-derived values", "Load example data".
6. **Data providers**: read-only status + link to Diagnostics (refresh buttons live in Diagnostics only, not duplicated).
7. **About**: version, build, server time, links to Help.
- Removed (obsolete): sync folder, move ledger, SQLCipher passphrase, server shutdown/hand-off lock, live web companion publish, GitHub/Tiingo tokens + budgets, fingerprint-with-passphrase, auto-lock/resume, portable config, extra-ranges toggle, API keys, dev tools.
- States: dirty/saving/saved indicator per form; invalid symbol inline error; destructive actions list consequences; skeleton tables.
- Kit: Card, Field, Input, Select, SegmentedControl, Switch, Button(danger), Dialog, DataTable, Toast, Tooltip, Badge, Menu.
- Data: `GET/PUT /api/settings {display_ccy, theme, timezone, clock_format, locale, investment_amount, benchmark_symbol, risk_free_symbol, risk_free_manual}`; `/api/accounts`, `/api/instruments` CRUD; `/api/auth/passkeys`; `GET /api/backup`; `POST /api/admin/reset {level}`.

**Copy:** "Switches every page's KPIs, tables and charts."; "The euros you regularly send to the US to keep investing. In USD ..." (Investing power); "Pins Sharpe / Sortino / Alpha to your chosen rate. Leave blank to use the live ^IRX feed."; "Default: VT (Vanguard Total World)."

---

## 13. Diagnostics (Data health)

**D has (`pages/diagnostics.py`, "Data Health - Silent data problems, surfaced in one place."):** intro "This page never changes your data. Fix anything flagged from Settings -> Data refresh (prices/FX) or Settings -> Instruments (tickers)."; header shield button tinted ok / warning / error, tooltip "Data Health - N item(s) need attention" (`quick_status`); "All clear" EmptyState; "Needs attention (N)" list; "All checks" list ("Every probe and its current status. Green means nothing to do."); item = severity icon, title, detail, example chips. Checks (`diagnostics_service`): Transaction currency legs, Instruments with no price, Stale prices, Corrupt price history, Holdings without a value, Data providers, Intraday graph coverage. "Recent problems (N)" (source, UTC time, message, dismiss, "Dismiss all"). "Report an issue" -> "Download support bundle".

**W has:** no page. Scattered Overview notes (missing price symbols, stale values, missing FX, degraded reason), Settings "Probe a price service", provider usage meter.

**v6 page spec (`/diagnostics`):**
- Header: overall status pill (OK / N warnings / N errors), `Freshness` last refresh, "Run checks now".
- Grouped check cards: Prices & FX (no price, stale, corrupt history, provider health, rate-limit state), Ledger (currency legs, "deposits using ECB fallback" from plan 2.5, duplicates, negative positions, unmatched sells), Holdings (without a value), Graph coverage. Each: severity icon, title, detail, example chips deep-linking to Holdings / Transactions filtered, and a **Fix** action where safe ("Refresh prices", "Refresh FX", "Recalculate", "Edit instrument").
- Provider table: provider, last call, result, latency, calls today vs budget (supports the yfinance spike).
- Recent problems log with dismiss; "Download support bundle".
- Status dot on the sidebar item (replaces header shield) and on the phone "More" tab.
- States: skeleton; "All clear" EmptyState; load error -> ErrorState with Retry.
- Kit: Card, Badge, DataTable, Button, EmptyState, Tooltip, Icon.
- Data: `GET /api/diagnostics` -> `{status, count, checks [{id, title, severity, detail, examples [{label, href}], fix_action?}], providers [{name, last_ok_at, last_error, latency_ms, calls_today, budget}], problems [{id, source, at, message}]}`; `POST /api/diagnostics/run`; `POST /api/refresh/{prices|fx}`; `DELETE /api/diagnostics/problems[/id]`; `GET /api/support-bundle`.

**Copy:** "No data-health problems detected."; "Needs attention (N)"; "Every probe and its current status. Green means nothing to do."; "Problems the app recorded recently - background refresh failures, ..."; revise "never changes your data" now that Fix buttons exist.

---

## 14. Onboarding

**D has (`pages/onboarding.py`, "Welcome to Investment Dashboard" / "Looks like this is a fresh database. Pick a starting point ..."):** auto-redirect ("Redirecting to setup...") when no accounts. Options: **Seed default setup** (creates Vanguard, Fidelity and Savings Bank accounts plus N default instruments, listed; "Re-seeding is safe"), **Open Settings**, **Skip - go to Overview**. Extras: custom ticker (Ticker symbol, Category optional, Validate, "Add instrument"; "Added X - Name."), cloud sync-folder step (auto-detected provider, "Save sync folder"), SQLCipher passphrase step ("Save to keychain", "Download recovery file").

**W has:** first-run setup form + Demo mode with spotlight tour (`tour.ts`, 5 steps: ".hero-value" "Your portfolio at a glance"; ".fx-box" "FX-aware currency box"; ".value-chart" "Live value over time"; ".panel-analytics" "Institutional-grade risk metrics"; ".panel-calc2" "Plan ahead"). Mechanics: dimmed backdrop + focus ring + caption card, Back / Next / Done, Esc closes, Left/Right arrows, backdrop click closes, switches tab per step, card flips above target if no room, reduced-motion aware, "don't auto-open again" flag.

**v6 page spec (`/onboarding`, shown when `accounts == 0` after first login; skippable):**
- `Stepper`: **1 Welcome** (3 bullets + reporting currency) -> **2 Accounts** (add broker accounts, or "Use example setup" with preview list) -> **3 Data** (Import CSV -> /import, Add a transaction, or Load demo data) -> **4 Preferences** (benchmark, timezone, regular investment amount, optional passkey registration) -> **Done** (summary + "Take the tour").
- Replaces seed defaults, custom-ticker validate flow (reuse Settings instrument form); drops sync-folder and SQLCipher.
- **Product tour** (replayable from Help): spotlight steps on Overview hero, currency box, chart, KPI tiles, Risk, Plan, plus Holdings, Import, Allocations; keep v5 mechanics (Esc/arrows, focus trap, aria-modal, reduced motion) as a `Tour` component using stable `data-tour` hooks (not CSS classes); completed flag stored server-side.
- "Skip for now" on every step; progress saved; other pages' EmptyStates point back here.
- States: step validation inline; Toast on completion.
- Kit: Card, Stepper (new, small), Field, Select, Button, Toast, Dialog (tour card), EmptyState.
- Data: `GET /api/onboarding` -> `{needs_setup, accounts_count, has_transactions, seed_preview {accounts[], instruments[]}}`; `POST /api/onboarding/seed`; `POST /api/accounts`; `POST /api/instruments/validate {symbol}`; `PUT /api/settings`.

**Copy:** "Welcome to Investment Dashboard"; "You already have accounts set up. Re-seeding is safe"; the five tour titles and bodies verbatim (they are good): e.g. "For a euro investor holding dollars, part of today's move comes from the EUR/USD swing. This box splits that out."

---

## 15. Help

**D has (`pages/help.py`, also under Settings): ** intro "New here, or unsure what a setting does? This page explains every ..."; per-page descriptions (Overview, Deposits, Transactions, Monthly/Yearly, Analytics, Calculator, Settings, Data Health); per-setting explanations (Display currency, Benchmark symbol, Risk-free symbol + Manual override, Storage, Data refresh, Connectivity, Accounts, Instruments, Target allocations); FAQ expansions ("A number looks wrong or out of date", "I want to start over with example data", "What is the difference between XIRR, TWR and CAGR?", "Where is my data stored, and is it private?"); quick-start steps. Header help icon, tooltip "Help & user guide".

**W has:** no help page. Freshness `?` legend (live / updating / cached / at last close / awaiting / "FX live / recent / end of day"), metric info dots, demo tour, version footer.

**v6 page spec (`/help`):**
- Desktop TOC left + content; phone accordion list; search box (`/`) filters entries.
- Sections: Getting started, Page guide, Metrics glossary (TOOLTIPS + METRIC_INFO merged; every info dot links to `/help#<metric>`), Currency & FX (reporting ccy, cashflow-date vs valuation-date rate, actual conversion rate pool), Freshness & market hours (rewritten W legend; mutual-fund NAV timing ~18:30 ET), Import guide (supported brokers and formats), FAQ, Keyboard shortcuts, "Replay tour", "Report an issue", About/version.
- Static content, no spinner; kit: Card, Accordion (Radix), Input, Tooltip, Button.
- Data: static `lib/copy.ts` + `GET /api/version`.

**Copy:** reuse the FAQ answers; "XIRR is your personal return accounting for when you deposited money; TWR ignores deposit timing and is best for comparing to an index; CAGR ..."; freshness legend wording ("live: freshly confirmed within your refresh window while the market is open"; "at last close: the market is shut; this is the latest settled closing price").

---

# Global UX

**Navigation:** D sidebar is flat (Overview, Holdings, Deposits, Transactions, Monthly, Yearly, Projection, Analytics, Calculator, Data Health, Settings); W tabs are Overview, Periods, Activity, Risk, Calculator (+ Settings gear, Lock). v6: grouped sidebar per brief; phone tabs Overview / Holdings / Activity / Periods + More sheet (Risk, Plan, Transactions, Import, Conversions, Allocations, Diagnostics, Settings, Help). Remember last section per device (W `iv.web.tab`) and scroll per route (D `scroll_restore`).

**Top bar to carry over:** page title; currency toggle EUR|USD (D header toggle, W topbar button); theme (D icon cycle, W settings toggle) -> TopBar `Menu`; help icon; Data Health dot (D shield tinted ok/warn/error); refresh indicator (D chip: spinner + "Updating...", idle shows last auto-update time, click forces refresh; thin top progress bar and "n/total" history progress while pulling); connection dot (D websocket green/amber/red) -> SSE state; clock label. Drop Quit/power and Lock buttons; version moves to About/sidebar footer.

**Freshness / market state:** D shows per-holding `as of <date>` plus "stale value" / "bad history" pills and greyed stale daily move. W is richer: hero value-basis chip (pulsing "Live" vs "Today"/date), per-holding status row (Updated / Updating / Queued, check when current after close), coverage line + `?` legend, FX freshness ("FX live / recent / end of day"), "Market closed" / "Frozen at Friday's close - reopens Sun ..." on the FX box, `price_type` nav vs market ("NAV" pill; NAV publishes ~18:30 ET). v6 `Freshness` states: **Live** (open + same-day quote, pulse), **Delayed** (open, quote older than N min), **Closed - prices as of Fri 22:00**, **Stale** (warn), **Offline** (SSE down, showing cached). Show in TopBar (tooltip lists per-provider last ok) and in small text on data card headers. One helper in `lib/format.ts` driven by server `daily_label`: "Today" only when the session is today, else "Yesterday" or "Fri 26 Jun" (both v5 UIs already do this).

**Currency toggle:** D persists server-side and flips every page (display ccy primary, other secondary on dual KPIs; tables single ccy; charts add other-ccy line). W is device-local and re-renders in place. Fix/keep: USD display makes the FX effect exactly $0 and swaps in "Investing power" (explain via title/tooltip); EUR returns stay FX-aware per AGENTS.md (never rescale USD return); query keys include `ccy`; toggle keeps scroll position and chart range; native prices keep native symbol on holdings.

**Number / sign / colour:** money = symbol/ISO prefix, thousands separators, 2 dp (compact only in tight tiles); percent signed 2 dp; shares up to 4-6 dp; deltas get explicit `+` and an arrow; null = `—`; tabular figures, right-aligned in tables; secondary ccy smaller and muted. D charts use colour-blind-safe blue `#0072B2` / orange `#E69F00`; W CSS uses green/red - unify on `--color-pos/--color-neg` with arrow redundancy. Rounding display only; Decimal strings from API.

**Keyboard shortcuts:** v5 has none (only tour Esc/arrows, info-dot Esc). v6: `g o` Overview, `g h` Holdings, `g p` Periods, `g a` Activity, `g r` Risk, `g t` Transactions, `g s` Settings, `/` focus search, `?` shortcut help, `c` toggle currency, `t` cycle theme, `r` refresh, `Esc` closes Dialog/Sheet/Tooltip/Tour; chart range keys `1..6` when chart focused.

**Mobile interactions:** W has none beyond refresh button, tap-to-pin info dots, collapsible sections (state remembered), sticky tab nav, remembered chart height/range, safe-area. v6 adds pull-to-refresh (refetch + Freshness feedback), bottom `Sheet` for filters/forms/detail with swipe-down dismiss, 44px targets. No swipe between tabs (conflicts with chart scrubbing).

**Loading / empty / error:** D `deferred()` renders shell then computes off-loop (label e.g. "Projecting..."), `empty_state(icon, title, hint, CTA)`, `ui.notify` for success/warning/error. W uses `<p class="note">` and "not included in this export". v6: Skeleton per card, instant paint from persisted cache, `EmptyState` with one CTA, inline `ErrorState` with Retry, Toasts only for completed actions (never validation).

**Inconsistencies / unpolished items to fix:**
1. Naming drift: D "Deposits" vs W "Activity" (= transactions) / "Periods"; D "Analytics" vs W "Risk"; "Data Health" vs brief "Diagnostics". Use brief names.
2. Metric labels differ: D "Total Invested" vs W "Invested"; D "Capital Gain" vs W "Total gain"; D "Dividend total return" vs W "Div. return"; W lacks dividend yield TTM, expense ratio, Vs Market. One glossary.
3. Dual-currency: D dual KPIs everywhere, W only some. `Money` supports `secondary` uniformly.
4. Chart ranges differ (D includes YTD and 3M/6M; W hides 3M/6M behind a setting).
5. Holdings: D grid has weight/category/avg price/MTD; W chips lack them. DataTable + detail Sheet unifies.
6. D grids: `paginationAutoPageSize` with fixed vh heights, Plotly palette not tokenised.
7. D Settings is a wall of collapsibles mixing infra and prefs; v6 groups by task and drops infra.
8. Tooltip copy duplicated (TOOLTIPS vs METRIC_INFO) with slightly different wording.
9. D date inputs are free-text "YYYY-MM-DD"; use a date picker.
10. Validation via toasts (D) vs inline (W); standardise on inline Field errors.
11. Market-regime logic (weekend, spill-over, holiday, overnight legs) reaches the user as dense prose; keep it server-side and send `regime`, `label`, `legs[]`.
12. `_by_ccy` / `pickByCurrency` hard-code EUR/USD; v6 data shape must be currency-generic (AGENTS.md currency rule).
13. W per-holding queue/countdown only exists because of provider rate limits; v6 shows Updated / Updating.
14. Mixed icon sets (Material in D, unicode glyphs in W); `lucide-react` only.
15. D has no phone layout; W has no keyboard/desktop density; the two-density shell resolves both.
