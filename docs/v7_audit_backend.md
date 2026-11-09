# v7 pre-plan audit: backend

Read-only audit of `backend/src/investment_dashboard/` (v6 live), done 2026-11-09 before
the v7 bug-fixing round. Nothing was changed except this file. v5-only code (NiceGUI
`ui/`, `web/`) is out of scope except where it still affects v6 behaviour. Items that
`docs/v7_plan.md` already plans to replace are flagged as "v7 overlap".

## Coverage

- [x] api routers (+ interplay with `frontend/src/lib/`): app/middleware, deps, overview, graphs, transactions, live, stream, security/auth checks, activity labels; route usage checked against `frontend/src` by grep
- [x] scheduler / SSE / live bus / read cache (ETags)
- [x] services: metrics, cashflows, positions, ledger walk, fx, fx conversions, snapshots, prices (due checks, refresh round), transaction edits, import undo, backup scheduling. **Partial:** `intraday_snapshots_service` (2,964 lines) only sampled; `tiingo_fallback*`, `benchmark_service`, `diagnostics_service` not read
- [x] readmodels: overview (full), period_query, overview_query instrument metrics. **Not read:** deposits, allocations / rebalance, projection, analytics, mobile_export, live_graphs internals
- [x] domain: returns, currency, fx_pool, kinds, market_hours. **Not read:** session_fx, late_data internals, risk, tiingo_fallback
- [~] adapters: yfinance client (closes, spot), frankfurter usage via fx_service. **Not read:** importer parsers (vanguard, fidelity, generic, tabular), tiingo client
- [~] repositories: fx_repo, the snapshot usage. Others not read
- [x] storage / config / boot / activity log / `.env.example` (storage encryption and restore tools not read)

Tooling run (read-only): `ruff check` clean, `lint-imports` 3/3 contracts kept, `mypy domain` clean. No tests run.

## Findings

### Area 1: request pipeline, read cache / ETags, SSE, scheduler

**B-001, Writes are committed after the response has been sent**
- Severity: High
- Category: bug
- Confidence: confirmed (mechanism traced); data loss itself suspected (needs a failing commit)
- Where: [`api/deps.py:28`](../backend/src/investment_dashboard/api/deps.py#L28), [`db.py:250`](../backend/src/investment_dashboard/db.py#L250), [`api/app.py:172`](../backend/src/investment_dashboard/api/app.py#L172); FastAPI 0.136 runs a `yield` dependency's exit on the *request* stack, i.e. after `await response(...)` (`.venv/.../fastapi/routing.py:116-121`).
- What happens: `get_session` commits in its teardown, which FastAPI runs only after the body has gone out. No API write path commits explicitly (grep: the only `session.commit()` is in `db._scope`). Three consequences:
  1. If the commit fails (for example `database is locked` after the 5 s busy timeout while the scheduler's EOD/snapshot warm holds the write lock), the client has already received 200/201 and the activity log has already written "ok". The edit is rolled back silently and disappears on the next reload.
  2. `drop_read_cache_on_write` bumps the cache generations when the response *starts*, before the commit. A refetch that lands in that gap (the client refetches right after a mutation; other devices refetch on SSE) computes from the old data and stores it under the *new* generation. The `/both` ETag is derived from the generations only, so that stale body is then served with 304 until the next bump (on a weekend, possibly hours).
  3. Services publish SSE `refresh` events from inside the request, also before the commit (`import_undo_service.py:212`, `instruments_service.py:344,365`, `fx_service.py:1030`), which widens window 2 for every other open device. The scheduler path does the same thing: `prices_service.rebuild_settled_snapshots` (`prices_service.py:1042`) publishes `refresh` while the tick's session still holds the rebuilt snapshot rows uncommitted. It is usually rescued by the tick event that follows, unless that tick is `unchanged`.
- Fix direction: commit before returning (declare the session dependency with `Depends(get_session, scope="function")`, or commit explicitly in write routes), and publish live events from an `after_commit` hook rather than mid-request. Size S-M.

**B-002, `/both` ETags never expire, but the payloads are time-dependent**
- Severity: Medium
- Category: interplay
- Confidence: confirmed
- Where: [`services/read_cache.py:216`](../backend/src/investment_dashboard/services/read_cache.py#L216), payload fields at [`readmodels/overview.py:650`](../backend/src/investment_dashboard/readmodels/overview.py#L650); client side `frontend/src/lib/api.ts:204-248`.
- What happens: the digest covers boot nonce + route + params + generations, nothing time-based. The 60 s `TTL_SECONDS` only applies inside `cached_read`; `conditional_both` answers 304 *before* calling it. The overview payload contains `generated_at`, `is_live`, `freshness.market_state` / `prices_live`, the `daily_caption` texts ("Updated ...", "Today" against the local date), `default_range`, `as_of` and the last-session vs today split. Whenever no generation is bumped (weekend after Friday's EOD, the overnight gap with an unchanged FX rate, ticks with `unchanged: true`), a long-open tab or PWA keeps getting 304s and shows Friday evening's "live"/"today" wording on Saturday, or yesterday's `as_of` after midnight. The same applies to `/holdings/both`, `/graphs/.../both` and the other conditional routes.
- Fix direction: put a coarse time component into the digest (exchange date + `market_state` + the cache entry's TTL bucket), so a 304 can never outlive the server-side TTL. Size S.

**B-003, Pure-calculation POSTs drop the whole read cache (and every client's ETags)**
- Severity: Medium
- Category: inefficiency
- Confidence: confirmed
- Where: [`api/app.py:136`](../backend/src/investment_dashboard/api/app.py#L136) (`_CACHE_NEUTRAL_WRITES`) vs [`api/activity.py:21`](../backend/src/investment_dashboard/api/activity.py#L21) (`_READ_ONLY_WRITES`)
- What happens: `POST /api/calculator` (the frontend runs it as a *query* on every projection input change, `frontend/src/lib/queries/reports.ts:76-84`), `POST /api/allocations/plan` (live builder), `POST /api/transactions/reconcile` (the transaction form) and `POST /api/maintenance/probe` change no data, but the cache middleware only exempts `/api/graphs/range` and `/api/settings/values`. Each call bumps all generations, so the next overview/holdings/graphs request on *every* device recomputes from scratch (seconds on the encrypted DB) and re-downloads the full body. In addition, `/api/transactions/reconcile` is missing from `_READ_ONLY_WRITES`, so every reconcile call writes a `changes.log` line ("POST /api/transactions/reconcile").
- Fix direction: one shared "read-only POST" set used by both middlewares (or a route-level marker). Size S.

**B-004, Scheduler state lives only in memory: every restart while the market is closed re-runs the full EOD**
- Severity: Low
- Category: inefficiency
- Confidence: confirmed
- Where: [`services/scheduler.py:547`](../backend/src/investment_dashboard/services/scheduler.py#L547), [`services/scheduler.py:289`](../backend/src/investment_dashboard/services/scheduler.py#L289)
- What happens: `State.last_eod_session` starts as `None`, so every deploy outside market hours (every green `main` commit deploys) runs live FX, ECB FX, the full-history price refresh, splits, benchmark, the 1D reconstruct, a forced snapshot re-warm of the recent tail and the janitor. These are mostly incremental, but they add provider calls and DB write-lock time right after each restart, which is also when clients reconnect and refetch everything. A restart *during* market hours means the previous session's ECB fixing, splits and benchmark wait until after the close.
- Fix direction: persist `last_eod_session` in `app_config` (the pause state already is), or check "anything missing" instead of re-running the whole chain. Size S.

**B-005, The EOD job can never report failure; its failure flag is always false**
- Severity: Low
- Category: ux
- Confidence: confirmed
- Where: [`services/scheduler.py:289-306`](../backend/src/investment_dashboard/services/scheduler.py#L289), the `boot._refresh_*` steps (`boot.py:811-1036`)
- What happens: each step catches and logs its own exception, so `default_eod_job` always returns normally. The scheduler marks `eod` as not failed, stamps `last_eod_session` and publishes `refresh`. The Health & Repair scheduler card (`last_failed`) shows a green EOD even when the ECB fetch, the price refresh and the snapshot warm all failed. Missing closes are retried by the `prices_due` check, but a missed ECB fixing is not retried until the next session's EOD (the FX job only fetches the live spot).
- Fix direction: have the steps return ok/failed and set `last_failed` when any step failed. Add the ECB-fixing gap to the "anything missing?" check. Size S.

### Area 2: services (metrics, cashflows, positions, ledger walk, FX)

**B-006, MTD / YTD start value includes the first day's own flows, which are then counted again**
- Severity: High
- Category: bug
- Confidence: confirmed (traced)
- Where: [`services/metrics_service.py:1081-1114`](../backend/src/investment_dashboard/services/metrics_service.py#L1081) (portfolio MTD), [`services/metrics_service.py:423-485`](../backend/src/investment_dashboard/services/metrics_service.py#L423) (portfolio YTD growth and YTD XIRR), [`readmodels/queries/overview_query.py:869-1000`](../backend/src/investment_dashboard/readmodels/queries/overview_query.py#L869) with [`services/ledger_walk.py:156-161`](../backend/src/investment_dashboard/services/ledger_walk.py#L156) (per-holding YTD/MTD)
- What happens: `V_start = total_value(as_of=month_start)`. That is the value at the *close* of the 1st, and `compute_positions` includes every transaction dated `<= as_of`. The flows are then summed over `t.date >= month_start`. A deposit (or a buy, at holding level) dated on the 1st is therefore inside `V_start` **and** inside `net`, so `(V - V_start - net) / (V_start + net)` subtracts it twice. Example: €50k portfolio, €1k deposit on the 1st, flat market: MTD shows about -2 %. The 1st's own market move is also left out of MTD. The domain layer already knows the right convention (`domain/returns.py:385-391`: "a flow dated on the opening day is already inside the opening value"), and the Periods table uses the previous day's close as its opening (`period_query.py:491`). So the Overview "MTD" tile and the current month on the Periods page disagree even without the bug, and the bug makes the gap large on deposit-on-the-1st months. YTD is affected by flows dated 1 January (rare), and by `_best_effort_ytd_start_value` (`metrics_service.py:1153-1188`): for a portfolio whose first deposit falls between 2 and 31 January, the start value *is* that first deposit, which is also in the YTD flows, so the first-year YTD reads close to -50 %. MTD is affected whenever the 1st is a trading day with a flow.
- Fix direction: value the start at `month_start - 1 day` (and `year_start - 1 day`), keep flows `>= start`. Add a golden test with a deposit on the 1st. This is money maths, so it needs the parity note. Size S.

**B-007, "Today's move" is a raw value difference: deposits, withdrawals and same-day buys count as gain**
- Severity: High
- Category: bug
- Confidence: confirmed (traced); impact depends on the account's cash model
- Where: [`services/metrics_service.py:688-695`](../backend/src/investment_dashboard/services/metrics_service.py#L688) (`_compute_daily_growth`), [`services/metrics_service.py:906-913`](../backend/src/investment_dashboard/services/metrics_service.py#L906) (`last_session_split`), [`services/metrics_service.py:1033-1036`](../backend/src/investment_dashboard/services/metrics_service.py#L1033) (`day_move_split`)
- What happens: the day move is `total_value(last_session) - total_value(prev_session)`, and the split is `book(session) - book(prev)`, with no external-flow term anywhere (grep for flow/deposit in `late_data.py` finds nothing). A deposit swept into the money-market settlement fund, or a buy funded from cash the valuation does not see (brokerage cash outside a money-market fund is not valued; only `savings`/`cash` accounts are), lands in "today's move", its % and the price part of the price/currency split. The user sees a "+4 % today" spike on the day they add money, and the Daily Brief planned for v7 would narrate it as performance.
- Fix direction: subtract the session's net external flows (the same `cashflows` legs XIRR uses, at their own date's rate) from the move, or value the previous session with today's share counts. Add a deposit-day golden test. Size M.

**B-008, Frozen `net_eur` / `net_usd` legs are still read on hot paths (holding EUR figures, dividend income)**
- Severity: Medium
- Category: inconsistency (currency rule)
- Confidence: confirmed
- Where: [`domain/currency.py:152-154`](../backend/src/investment_dashboard/domain/currency.py#L152) (`dual_currency_amounts` fast path returns the frozen legs verbatim), used by [`domain/dividends.py:113-120`](../backend/src/investment_dashboard/domain/dividends.py#L113) (portfolio and Periods dividend income, realised dividends inside capital gain), [`services/metrics_service.py:207`](../backend/src/investment_dashboard/services/metrics_service.py#L207) (per-holding XIRR flows), [`readmodels/queries/overview_query.py:811-821`](../backend/src/investment_dashboard/readmodels/queries/overview_query.py#L811) (per-holding cost basis, dividends, YTD/MTD invested), [`readmodels/queries/ledger_query.py:293`](../backend/src/investment_dashboard/readmodels/queries/ledger_query.py#L293)
- What happens: AGENTS.md says to derive legs from `net_native` + that date's FX, and to treat the frozen legs only as a cross-check. `cashflows.py` does this, so the portfolio XIRR / invested figures follow the rule. Holding-level figures and dividend income still trust the frozen legs. The frozen legs drift for an ordinary reason: `transaction_fx_service.compute_legs` (`:84`) freezes with `get_rate_eur_to_quote`, which overlays the **live intraday spot** for today and forward-fills when the day's ECB fixing is not yet published. Every transaction entered on its own trade day is therefore frozen at a rate the derived path will never use. Results: holding EUR cost/gain/XIRR do not add up to the portfolio's, portfolio "dividends" (frozen) and XIRR flows (derived) mix two bases inside one capital-gain formula, and the Data Health leg-drift check (`diagnostics_service.py:285`) flags rows the app itself just wrote. Second, smaller issue: for EUR-native rows with no rate on file, `dual_currency_amounts` / `_convert_native` fall back to **today's** spot (`fallback_rate=today_rate`), which `cashflows.py` explicitly refuses to do.
- Fix direction: route `income_dual`, `build_instrument_cashflows` and `compute_instrument_metrics._legs` through `cashflows.txn_eur_amount` / `txn_usd_amount` and drop the spot fallback. v7 overlap: 7.5c rewrites the holding-level EUR cost (pool rate) and wires `ledger_query`. Do the dividend path and the XIRR flows here, or explicitly as part of 7.5c. Size M.

**B-009, Position value converts with the account's currency, while tick prices are labelled with the instrument's**
- Severity: Low
- Category: inconsistency
- Confidence: confirmed (code); impact only with a currency mismatch
- Where: [`services/positions_service.py:275-289`](../backend/src/investment_dashboard/services/positions_service.py#L275) vs [`services/scheduler.py:143`](../backend/src/investment_dashboard/services/scheduler.py#L143), `readmodels/holdings.py:689`, `readmodels/queries/calculator_query.py:146`, `services/intraday_snapshots_service.py:2416`
- What happens: valuation does `shares x price` and converts with `account.native_currency`. The SSE tick tells the client `ccy = instrument.native_currency` for the same price, and the calculator converts with the instrument currency. `instrument_enrichment_service` (`:241`, `:285-288`) can set the instrument currency from yfinance (for example `GBp`, or EUR for a UCITS line), so it can differ from the account. Then the server value and the client's `qty x px x fx_now` patch disagree, and the number flickers between the tick patch and the next REST refetch. No guard or warning exists for instrument currency != account currency.
- Fix direction: pick one rule (price currency = instrument currency, converted explicitly to the account currency when they differ) and flag the mismatch in Data Health. Size M.

**B-010, Native and dual-currency average cost diverge after a priceless reinvest**
- Severity: Low
- Category: inconsistency
- Confidence: confirmed (code)
- Where: [`services/ledger_walk.py:109-130`](../backend/src/investment_dashboard/services/ledger_walk.py#L109)
- What happens: a `dividend_reinvest` without `price_native` adds to `lot.shares` (native walk) but not to `lot.shares_dual`. A later partial sale then releases `qty/shares` of the native cost but `qty/shares_dual` of the EUR/USD cost. For a USD account `cost_usd` should equal `cost_native` exactly, but they drift apart, so the holding's native cost basis and its USD cost basis disagree. Also, the `Lot` docstring says reinvested income "joins `cost_*` except for money-market funds", but the code adds it for every instrument (overview_query's comment says that is intended). Fix the docstring.
- Fix direction: use one share count for both fractions (or price the reinvest from the close). Size S.

**B-011, Live-spot overlay leaks into "ECB" values: frozen legs and the conversion-pool fallback**
- Severity: Low
- Category: inconsistency
- Confidence: confirmed
- Where: [`services/fx_service.py:872-876`](../backend/src/investment_dashboard/services/fx_service.py#L872) (`get_rates` adds today's live spot), consumers [`services/fx_conversion_service.py:117-119`](../backend/src/investment_dashboard/services/fx_conversion_service.py#L117), [`services/transaction_fx_service.py:84`](../backend/src/investment_dashboard/services/transaction_fx_service.py#L84)
- What happens: anything that asks "the ECB rate for date D" through `get_rates` / `get_rate_eur_to_quote` gets the live intraday spot when D is today. So an unmatched USD deposit dated today is valued at the live spot and labelled "ECB fallback", and its EUR cost (Invested, XIRR flow) changes overnight when the real fixing replaces it. Frozen legs written today keep the spot permanently (see B-008). `get_settled_rate` exists for exactly this distinction but is used only by the intraday freeze.
- Fix direction: use `get_settled_rate` (or a settled-only series) wherever a *dated* rate is meant (cashflow legs, pool fallback), and keep the overlay for valuations only. Size S.

### Area 3: front/back interplay and read models

**B-012, Tab catch-up (`GET /api/live`) only knows about ticks; missed refresh, job and settings events are lost**
- Severity: Medium
- Category: interplay
- Confidence: confirmed (both halves read)
- Where: [`api/live.py:21-30`](../backend/src/investment_dashboard/api/live.py#L21), [`services/live_state.py:51-77`](../backend/src/investment_dashboard/services/live_state.py#L51); client `frontend/src/lib/live.ts:99-110,277-280`, `frontend/src/lib/queries.ts:14` (`refetchOnWindowFocus: false`)
- What happens: when a hidden tab or phone PWA comes back, the client calls `/api/live?since=N` and, if that succeeds, does **not** refetch. The response carries only the latest tick and the missed 1D points. If an EOD `refresh` (official closes, late NAVs, splits), an import undo, a transaction edit on another device or a settings change happened meanwhile, the tab keeps its old overview / holdings / periods until the next tick-driven refetch. On a weekend or overnight no further tick comes. Second issue: `seq` restarts at 0 on every server restart, but the client keeps its old `lastSeq`. After an unannounced restart (crash or OOM, no `server` event), `since=<old seq>` returns no points and `res.seq > lastSeq` is false, so the 1D line misses every point until the new seq passes the old one.
- Fix direction: return the read-cache generations (or a "reports changed" counter) plus a boot id from `/api/live`. The client refetches when either changed and resets `lastSeq` on a new boot id. Size S.

**B-013, `/overview/both` and `/graphs/{range}/both` compute the whole read model twice**
- Severity: Medium
- Category: inefficiency
- Confidence: confirmed
- Where: [`api/overview.py:27-35`](../backend/src/investment_dashboard/api/overview.py#L27), [`readmodels/overview.py:572-600`](../backend/src/investment_dashboard/readmodels/overview.py#L572)
- What happens: `_overview_both` calls `build_overview(ccy="EUR")` and `build_overview(ccy="USD")`. Each call runs `compute_portfolio_metrics` (which already computes both currencies), `with_last_session_daily_growth`, `last_session_split`, `day_move_split`, `compute_instrument_metrics` (two per-holding XIRRs each), `twin_estimates`, the market verdict and the currency block again. Only `compute_positions` and the FX series are memoised per session. Every FX tick (24/5, every minute) bumps the FX generation, so the warmer and every refetch pay this double cost once a minute.
- Fix direction: build the currency-independent parts once and project both currencies from one `PortfolioMetrics` / instrument-metrics pass. Measure with the existing `Server-Timing` header. Size M.

**B-014, Single-currency GET twins and one route are unused by the frontend**
- Severity: Low
- Category: hygiene
- Confidence: confirmed (grep of `frontend/src`, tests excluded)
- Where: [`api/overview.py:21`](../backend/src/investment_dashboard/api/overview.py#L21) `GET /overview`, `GET /holdings`, `GET /graphs/{range}`, `GET /periods/monthly|yearly`, `GET /analytics`, `GET /deposits`, `GET /deposits/both`'s single twins, `GET /deposits/dividends`, `GET /instruments/twin-suggestions`
- What happens: the SPA calls only the `/both` variants (plus `/calculator/both`). The single-currency routes are still cached, documented in `openapi.json`, regenerated into `api-types.ts`, and they keep the code paths (`ccy` cache keys, separate `cached_read` entries that compete for the 64-entry LRU) alive. `twin-suggestions` has no caller at all.
- Fix direction: drop the unused twins (or mark them internal/test-only) and either wire or delete `twin-suggestions`. Size S.

**B-015, The 30-minute idle timeout never fires for an open tab: tick-driven refetches count as activity**
- Severity: Low
- Category: interplay (security posture)
- Confidence: likely
- Where: [`services/auth_service.py:168-183`](../backend/src/investment_dashboard/services/auth_service.py#L168) (`validate_session` slides `last_seen_at`), [`api/stream.py:32-34`](../backend/src/investment_dashboard/api/stream.py#L32) (the stream deliberately does *not* slide); client refetch on every `tick`/`fx` (`frontend/src/lib/live.ts:218-223`)
- What happens: the stream's re-validation uses `peek_session` so that it does not keep a session alive. But every SSE `tick` or `fx` event (FX every minute, 24/5) makes the client refetch active queries, and each GET goes through `validate_session`, which slides the session. An unattended open tab therefore stays signed in all week, and only the 30-day absolute cap applies. The weekend FX pause is the only time it can idle out.
- Fix direction: mark background refetches (for example a request header set by the live-refetch path) and do not slide the session for them, or slide only on user-initiated requests. Size S.

**B-016, `default_range` in the overview payload goes stale after `PUT /graphs/range`**
- Severity: Nit
- Category: interplay
- Confidence: confirmed
- Where: [`api/app.py:136`](../backend/src/investment_dashboard/api/app.py#L136) (`/api/graphs/range` is cache-neutral), [`readmodels/overview.py:677`](../backend/src/investment_dashboard/readmodels/overview.py#L677)
- What happens: the remembered range is part of the cached overview, but the write that changes it is exempt from invalidation, so other devices keep the old default until the next bump (and B-002 can make that long).
- Fix direction: drop `default_range` from the overview (the PUT response already returns it), or bump the cache for this write. Size S.

### Area 4: valuation model, domain clock, scheduler internals

**B-017, Uninvested brokerage cash is not part of the portfolio value**
- Severity: Medium
- Category: bug
- Confidence: likely (traced; impact depends on whether every brokerage account has money-market legs)
- Where: [`services/positions_service.py:364-380`](../backend/src/investment_dashboard/services/positions_service.py#L364) (only `savings` / `cash` account balances are added), [`services/transaction_edit_service.py:40`](../backend/src/investment_dashboard/services/transaction_edit_service.py#L40) (`NO_MONEY_MARKET_WARNING`)
- What happens: the total is positions + cash balances of `savings`/`cash` accounts. Cash sitting in a brokerage account counts only if it is booked as a money-market fund position (the Vanguard sweep legs). For an account without such legs (a manual entry gets "No money-market fund on this account yet - logged the cash move only", an importer without sweep rows, a generic import), sale proceeds and deposits leave the valuation until they are reinvested. The terminal value of XIRR, capital gain and total return are then understated by that cash, and the day move shows a sale as a loss (see B-007). `compute_cash_balance`'s own docstring says it is meant for "showing uninvested cash on the brokerage accounts", but the total never uses it for them.
- Fix direction: add brokerage cash (ledger cash balance excluding money-market-routed amounts) to the total, or raise a Data Health warning for any brokerage account with a non-zero unrouted cash balance. Size M (money maths, needs golden tests).

**B-018, Half-day sessions are treated as open until 16:00**
- Severity: Medium (the next two are close: Fri 27 Nov 2026 and Thu 24 Dec 2026)
- Category: bug
- Confidence: likely
- Where: [`domain/market_hours.py:265-281`](../backend/src/investment_dashboard/domain/market_hours.py#L265), [`domain/market_hours.py:284-309`](../backend/src/investment_dashboard/domain/market_hours.py#L284)
- What happens: early closes (13:00 ET: the day after Thanksgiving, Christmas Eve, usually 3 July) are modelled as full sessions. From 13:00 to 16:00 the scheduler keeps ticking. Quotes do not change, so the feed-stall detector (`prices_service._observe_feed`) can declare a stall, drop the 1D samples after the stall start (`drop_samples_after`) and show "not Live" / stalled. `latest_settled_session_date` does not count the day as settled until 16:00, so the EOD run (official closes, NAVs, snapshot warm) is three hours late, and the hero shows "live" wording for a closed market.
- Fix direction: add the NYSE early-close rule (and a small override table for exceptions) and use it for `_CLOSE` in `is_us_market_open`, `latest_settled_session_date` and `regular_session_close`. Pure domain change plus tests. Size S.

**B-019, The scheduler loop does blocking database work on the event loop**
- Severity: Low
- Category: inefficiency
- Confidence: confirmed
- Where: [`services/scheduler.py:656-677`](../backend/src/investment_dashboard/services/scheduler.py#L656) (`step` calls `self.due(...)` and `paused(...)` synchronously), [`services/scheduler.py:336-342`](../backend/src/investment_dashboard/services/scheduler.py#L336) (`default_prices_due` opens ledger + cache sessions), `services/settings_service.py:96-98` (cache refill)
- What happens: only the jobs and `interval_seconds` run via `asyncio.to_thread`. The once-a-minute "anything missing?" check (two SQLCipher sessions plus queries), settings cache refills and the first pause load all run on the single asyncio loop that also serves SSE, the auth checks and every async route. Usually milliseconds, but a cold SQLCipher connection or a slow disk stalls every request for that long.
- Fix direction: run `due()` (or at least `prices_due`) through `asyncio.to_thread`. Size S.

**B-020, The backup dirty flag is in memory only**
- Severity: Low
- Category: bug
- Confidence: confirmed
- Where: [`db.py:399-434`](../backend/src/investment_dashboard/db.py#L399), [`services/backup_service.py:386-405`](../backend/src/investment_dashboard/services/backup_service.py#L386)
- What happens: a write marks the process "dirty", and a snapshot follows after the debounce. If the process restarts inside the debounce window (every green `main` push deploys), the flag is lost, and the change is only sealed at the next nightly snapshot, up to 24 h later. `_rolling_backup` at boot is a local pre-migration copy, not a sealed off-site snapshot.
- Fix direction: persist "dirty since" (or compare the DB file's `data_version` / mtime with the last snapshot's) at boot. Size S.

### Area 5: activity logs, config, v5 leftovers

**B-021, Ledger edits and conversion edits leave no domain line in `changes.log`**
- Severity: Low
- Category: inconsistency (AGENTS.md "Activity logs")
- Confidence: confirmed
- Where: [`activity_log.py:67-72`](../backend/src/investment_dashboard/activity_log.py#L67) routes `transaction_edit_service`, `manual_entry` and `fx_conversion_service`, but none of these modules logs anything (no `log.` calls in `transaction_edit_service.py` or `fx_conversion_service.py`). Compare `instruments_service.py:346` and `import_undo_service.py:203`, which log what changed.
- What happens: `changes.log` only gets the generic request line ("POST /api/transactions status=201 ..."), with no transaction id, date, kind or account, so "what did I change on Tuesday?" cannot be answered from the activity log. The request middleware also logs "ok" before the commit (B-001). v7 overlap: plan §5.1 says "conversion edits already log to the `changes` subject", which is true only for the generic request line.
- Fix direction: one `activity("changes").info(...)` per create/update/delete with id, date, kind and account (no amounts needed if that is preferred). Size S.

**B-022, v5 desktop settings still live in the v6 `Settings`; `.env.example` misses v6 ones**
- Severity: Nit
- Category: hygiene
- Confidence: confirmed (field-by-field comparison)
- Where: [`config.py:78-131`](../backend/src/investment_dashboard/config.py#L78), `backend/.env.example`
- What happens: `api_enabled`, `publish_*`, `mobile_passphrase`, `dev_password`, `shutdown_on_tab_close` and `snapshot_path` are v5 desktop/web-companion settings with no v6 effect, which the cutover should drop. Meanwhile `.env.example` documents none of `host`, `port`, `log_dir`, `log_max_bytes`, `log_backup_count`, `ledger_path` / `config_path` / `cache_path`. `INV_DASHBOARD_BACKUP_PASSPHRASE` is read from `os.environ` directly instead of being a `Settings` field.
- Fix direction: fold into the approved v5 clean-up release. Size S.

## Summary

**Counts (22 findings):** Critical 0 · High 3 · Medium 7 · Low 10 · Nit 2.

None of the findings shows a wrong lifetime XIRR / TWR or a currency-rule break in the portfolio-level cashflow stream: `services/cashflows.py` does what AGENTS.md asks. The money problems are at the edges: period start values, the day move, cash outside a money-market fund, and holding-level legs.

**Top 10 to fix first**

| # | ID | Why first | Size |
|---|---|---|---|
| 1 | B-006 | MTD/YTD tiles wrong (about -2 % for a €1k deposit on a €50k book) every month with a flow on the 1st; first-year YTD about -50 % | S |
| 2 | B-007 | "Today's move" counts deposits and buys as gain; the v7 Daily Brief would narrate it | M |
| 3 | B-001 | Commit after the response: silent loss on a failed commit, and stale answers pinned by ETag | S-M |
| 4 | B-018 | Half-day sessions (27 Nov, 24 Dec 2026) are close: false stalls, dropped 1D samples, late EOD | S |
| 5 | B-017 | Uninvested brokerage cash leaves the total (XIRR terminal, capital gain) | M |
| 6 | B-002 | 304s outlive the server TTL: weekend / overnight tabs show stale "live"/"today" wording | S |
| 7 | B-012 | A returning tab never refetches after an EOD refresh or another device's edit; seq is not reset after a restart | S |
| 8 | B-003 | Projection / allocation / reconcile POSTs flush every cached read on every device | S |
| 9 | B-008 | Frozen legs still feed holding EUR figures and dividend income (v7 7.5c overlap: do the dividend and XIRR-flow paths here or in 7.5c) | M |
| 10 | B-013 | Overview `/both` pays the full metric stack twice, once a minute 24/5 | M |

**v7 overlap noted:** B-008 and B-011 touch 7.5c ("one rate everywhere", the pool rate at holding level, `ledger_query` overrides); B-021 corrects a claim in plan §5.1; B-007 should land before the 7.0 Daily Brief. Nothing here duplicates the UI-audit patch list in plan §7.

**Not covered (or only sampled):**
- `services/intraday_snapshots_service.py` (1D/1W sleeves, twin estimates, session FX): only the parts the scheduler and overview call were read.
- Importer parsers (`adapters/vanguard`, `fidelity`, `generic`, `tabular`), `import_staging`, `importer_service`: dedupe, settlement sweeps and the currency detection were not audited.
- Tiingo client and fallback wiring/budget, `benchmark_service`, `risk_free_service`, `diagnostics_service` checks.
- Read models for deposits, allocations / rebalance, projection / calculator, analytics, mobile export, `live_graphs` internals.
- Auth / passkeys (`auth_service`, `api/auth.py`) beyond the session-slide path, `api/limits.py`, storage encryption, the restore / upload / split tools, Alembic migrations and their downgrades.
- Repositories other than `fx_repo` (no N+1 sweep was done across them).
- Nothing was reproduced at runtime. "Confirmed" means traced in code, not executed.

