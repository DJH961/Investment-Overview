# v6 backend scoping (tasks B1-B6, D1-D2)

Read-only analysis of branch `feat/v6-one-app` at commit `893510a` (C1 contracts landed:
`api/app.py` factory, `api/deps.py`, `api/schemas/common.py`, router stubs, `models/auth.py` and
`models/fx_conversion.py` stubs, `services/server_runtime.py` stub). All paths are relative to
`backend/src/investment_dashboard/` (`IDB/`) unless prefixed `backend/`. Old `ui/pages/_*_query.py`
now live in `IDB/readmodels/queries/*_query.py`; `ui/money_format.py` is `IDB/readmodels/money_format.py`.

Conventions already fixed by C1 (do not re-decide):
- Routers: `IDB/api/<name>.py` exposes `router: APIRouter`; guarded by `deps.require_auth`.
- `deps.SessionDep` = ledger session, `ConfigSessionDep` = config session, `ReportCcy` = `?ccy=EUR|USD`
  (`Literal["EUR","USD"]`).
- Schemas: `api/schemas/common.py` has `ApiModel`, `DecStr` (decimal-as-string), `Envelope(ccy, as_of)`,
  `OkResponse`. Readmodels already emit decimals via `readmodels._serialize.dec()` (strings) and dates via `iso()`.
- Endpoints must be plain `def` (sync) so FastAPI runs them in the threadpool: all services use sync SQLAlchemy.
- Tests: `backend/tests/api/conftest.py` fixtures `api_db` (single-file DB, `create_all`), `api_client`, `anon_client`.

Shared gap list that touches several tasks (details in each section):
1. Several UI-only pieces of logic must be extracted into `readmodels/` or `services/` first: currency-effect
   panel maths (`ui/pages/overview.py`), projection seed/params (`ui/pages/_projection_view.py`), rebalance plan
   assembly (`ui/pages/calculator.py`), manual-transaction save/delete incl. settlement leg (`ui/pages/transactions.py`).
2. `ccy=USD` is NOT yet supported by most existing readmodels (they emit `*_eur`). Only metrics/instrument metrics
   carry both legs. Analytics has a currency bug (see B2).
3. Config-tier data (`app_config`, `target_allocations`) is read through whatever session the caller passes; see
   Cross-cutting risks (tier layout).

---------------------------------------------------------------------------------------------------

## B1 reads A: overview, holdings, allocations, graphs

### Existing building blocks (call these)

| Need | Function | Returns |
| --- | --- | --- |
| Context (as_of ET date, display ccy, fx) | `readmodels/_context.py: build_context(session, *, as_of=None) -> ReadModelContext` | frozen dataclass `as_of, display_currency, fx_rate_eur_to_display, fx_rate_eur_usd` |
| KPI bundle | `services/metrics_service.py: compute_portfolio_metrics(session, *, as_of=None) -> PortfolioMetrics` | frozen dataclass, EUR and USD legs (table below). Walks the whole ledger twice; a few hundred ms to seconds |
| Positions | `services/positions_service.py: compute_positions(session, *, as_of=None, transactions=None) -> list[Position]` | one per (account, instrument): `account, instrument, shares, cost_basis_native, current_price_native, current_value_native, current_value_eur, category, instrument_active, value_warning, effective` |
| Per-instrument returns, both ccys | `readmodels/queries/overview_query.py: compute_instrument_metrics(session, positions, *, as_of=None) -> dict[int, InstrumentMetrics]` | per instrument id: `cost_basis_/current_value_/capital_gain_/total_growth_/xirr_/ytd_growth_/mtd_growth_/daily_growth_` each `_eur`/`_usd`, plus `daily_move_eur/usd`, `daily_growth_as_of`, `expense_ratio` |
| Freshness | `overview_query.py: holding_freshness(session, positions) -> dict[int, HoldingFreshness]` | `price_as_of, updated_at, is_money_market, market_open, price_market_time` |
| Anomaly flags | `services/prices_service.py: instruments_with_price_anomalies(session, ids) -> set[int]` | ids with non-positive cached close |
| Holding cards | `overview_query.py: build_holding_cards(positions, *, metrics, freshness, price_anomaly_ids) -> list[HoldingCard]` | sorted by EUR value; see field list below |
| Movers | `overview_query.py: build_movers(cards, currency="EUR") -> MoversView` | `winners, losers: list[MoverEntry(symbol,name,move_eur,move_usd,pct_eur,pct_usd,reason)]`, `basis_date`, `eligible_count` |
| Benchmark verdict | `overview_query.py: compute_market_verdict(session, *, portfolio_xirr, years, as_of) -> MarketVerdict` | `benchmark_symbol, portfolio_return, benchmark_return, beating`. Caller passes EUR `metrics.xirr` today; for `ccy=USD` pass `xirr_usd` (benchmark sim is EUR-only inside `benchmark_service.simulate_benchmark_xirr`: gap) |
| Allocation by category | `overview_query.py: allocation_treemap(positions) -> list[TreemapDatum(label, value_eur)]` | EUR only |
| Daily series | `overview_query.py: build_value_series(session, *, currency, range_label, as_of=None, recompute_tail_days=None) -> list[ValueSeriesPoint(date, value)]` | ranges: `Day,Week,Month,YTD,Year,All` (`resolve_range_days`); drops non-trading days |
| Intraday series | `build_intraday_value_series(session, *, currency, tz=None, now=None, positions=None, freeze_after_hours=False)` and `build_week_value_series(...)` (both thin wrappers over `build_window_value_series(session, *, currency, sessions, ...)`) | `ValueSeriesPoint.date` is a datetime for these; `[]` when no data |
| 1D reference line | `overview_query.py: previous_session_close_value(session, *, currency, now=None) -> Decimal | None` | settled value at prior session close |
| Currency effect (lifetime) | `domain/currency_effect.py: compute_currency_effect(*, contributions_eur, contributions_usd, value_eur, value_usd, growth_eur, growth_usd) -> CurrencyEffect` | `avg_invest_rate, current_rate, rate_change_pct, currency_effect_pp, fx_pnl_eur, repatriation_value_eur, breakeven_rate` (all `None`-able). Currently used only by `ui/pages/analytics.py` |
| FX effect split (today) | `domain/session_fx.py: fx_effect_split(market_open=, total_value_usd=, live_fx=, session_close_fx=, session_open_fx=, today_fx_move_eur=) -> FxEffectSplit(market_hours_eur, overnight_eur, ...)`; `fx_buying_power_split(...)` for USD view; `graph_anchor_fx(...)` | pure |
| Session FX anchors | `services/intraday_snapshots_service.py: session_open_fx(session, *, now)`, `session_close_fx(session, *, now)` | `Decimal | None` |
| Daily caption | `services/daily_growth_view.py: build_daily_growth_caption(...) -> DailyGrowthCaption` | text pieces (formatting; do NOT port, client formats) |
| Regular EUR invest amount | `services/investing_power_service.py: get_amount_eur(session) -> Decimal` | used by the USD "investing power" panel |

`PortfolioMetrics` field map for `ccy` selection (select the suffix, never convert):

| Metric | EUR field | USD field |
| --- | --- | --- |
| total value | `total_value_eur` | `total_value_usd` (None when no EUR/USD spot; = `total_value_eur * spot`, a single-instant conversion, allowed) |
| net contributions | `total_contributions_eur` | `total_contributions_usd` (frozen `net_usd` legs) |
| dividend income | `total_dividends_cash_eur` (income, name misleading) | `total_dividends_cash_usd` |
| capital gain | `capital_gain_eur` | `capital_gain_usd` |
| XIRR | `xirr` | `xirr_usd` |
| total growth compounded | `total_growth_compounded_eur` | `total_growth_compounded_usd` |
| YTD growth / XIRR | `ytd_growth_pct`, `ytd_xirr` | `ytd_growth_pct_usd`, `ytd_xirr_usd` |
| MTD growth | `mtd_growth_pct` | `mtd_growth_pct_usd` |
| daily growth pct / money | `daily_growth_pct`, `daily_growth_money_eur` | `daily_growth_pct_usd`, `daily_growth_money_usd` |
| TTM dividends | `dividends_ttm_eur` | `dividends_ttm_usd` |
| ccy-neutral | `as_of, first_cashflow_date, weighted_expense_ratio, dividend_yield_pct, dividend_yield_ttm_pct, daily_growth_as_of, daily_growth_prev_as_of, daily_growth_fx_eur_usd, daily_growth_fx_eur_usd_prev` | |
| EUR-only | `annual_expense_cost_eur` (single-instant; convert at spot if ccy=USD), `total_growth_pct` (legacy simple; drop from API) | |

`HoldingCard` (overview_query) fields: `instrument_id, symbol, name, category, native_currency, is_money_market,
value_warning, price_data_warning, shares, current_price_native, avg_price_native, expense_ratio,
value_{eur,usd}, cost_basis_{eur,usd}, capital_gain_{eur,usd}, total_growth_{eur,usd}, xirr_{eur,usd},
daily_growth_{eur,usd}, daily_move_{eur,usd}, ytd_growth_{eur,usd}, weight, price_as_of, updated_at, market_open,
daily_growth_as_of, daily_is_stale`.

### Endpoints and payloads

`GET /api/overview?ccy=` (new readmodel, e.g. `readmodels/portfolio.py: build_overview(session, *, ccy)`):
- `meta`: `ccy, as_of, display_ccy, fx_eur_usd (spot), fx_as_of/observed_at (fx_service.get_live_spot("USD")), is_live (is_us_market_open), freshness`.
- `kpis` (selected by ccy, one value each): `total_value, net_contributions, capital_gain, dividends_income, dividends_ttm, xirr, total_growth_compounded, ytd_growth, ytd_xirr, mtd_growth, daily_growth_pct, daily_growth_money, daily_growth_as_of`, plus ccy-neutral `weighted_expense_ratio, dividend_yield_pct, dividend_yield_ttm_pct, annual_expense_cost (ccy)`.
- `currency_effect`: lifetime `CurrencyEffect` (via `compute_currency_effect` with metrics fields; `currency_effect_pp = growth_eur - growth_usd` is a difference of two independently computed returns, allowed) and `today` block: `net_eur = usd/live_fx - usd/prev_fx` (valuation at two instants, allowed), `market_hours_eur`, `overnight_eur`, regime flags (`market_open, forex_open, holiday, weekend_overnight, single_overnight, session_view`). For `ccy=USD` return `investing_power` (`amount_eur * (live_fx - prev_fx)`) instead.
- `verdict`: `compute_market_verdict` output.
- `movers`: `build_movers(cards, ccy)` (needs cards, so overview builds holdings internally; share one `compute_positions` call).
- `allocation` (see below) so the overview can show it without a second call.

NEW readmodel needed: the currency-effect "today" maths lives only in `ui/pages/overview.py` (`_fx_box_regime` L287,
`_prior_fx` L372, `_eur_effect_from_anchor` L394, `_fx_effect_html` L479, `_investing_power_html` L593). Extract the
numeric parts (not the HTML) into `readmodels/fx_effect.py` (pure + one session read for `session_open_fx/close_fx`).

`GET /api/holdings?ccy=`: list of `HoldingCard` fields reduced to the selected ccy (`value, cost_basis, capital_gain,
total_growth, xirr, daily_growth, daily_move, ytd_growth` plus ccy-neutral fields), `weight`, `native_currency`,
`current_price_native` (native, never converted), freshness fields, warning flags, `account` list if needed.
Add totals row (`total_value`, `capital_gain`). Existing `readmodels/overview.py: build` emits only EUR + native; keep it for the legacy snapshot; add a ccy-aware builder.
Risk: `build_holding_cards` iterates positions (per account) but takes values from per-instrument `InstrumentMetrics`; an instrument held in two accounts would be double counted on cards. Check against the real ledger / add a test with a ticker in two accounts; aggregate per instrument if needed.

`GET /api/allocations?ccy=` (read part of B3's PUT):
- `current`: by category from `allocation_treemap(positions)` (EUR) plus USD value: use `InstrumentMetrics.current_value_usd` summed by category, or EUR x spot (single instant).
- `targets`: `allocations_repo.list_allocations(session)` -> `[{id, name, active, allow_sell, display_currency, items:[{instrument_id, symbol, weight_pct, no_buy}]}]` (mirror of `mobile_export._target_allocations` L366, which already shapes exactly this; reuse it by moving to a readmodel).
- `drift`: `domain/allocation.py: current_weights_pct(values) -> dict[id, pct]` vs active target weights.
- Rebalance plan is B2 (calculator endpoint), not here.
- Tier caveat: `TargetAllocation` is `ConfigBase`; the repo takes any session. With ledger==config file (recommended) `SessionDep` works; with split files use `ConfigSessionDep` for targets.

`GET /api/graphs/{range}?ccy=&compare=false` with `range in {1d,1w,1m,1y,all}` (add `ytd` for free):

| range | builder | notes |
| --- | --- | --- |
| 1d | `build_intraday_value_series(session, currency=ccy, tz=UTC, freeze_after_hours=True)` | + `previous_session_close_value(session, currency=ccy)` as `reference`. USD line is FX-free (native sleeve), EUR line uses per-minute stored `fx_eur_usd`; never rescale one from the other |
| 1w | `build_week_value_series(... same args)`; if `[]` fall back to `build_value_series(range_label="Week")` | page does the same |
| 1m / 1y / all | `build_value_series(session, currency=ccy, range_label="Month"/"Year"/"All")` | daily points from snapshot cache (EUR snapshot x that day's EUR->ccy rate: valuation-moment conversion) |

Response: `{ccy, range, as_of, points:[{t: ISO8601 (UTC for intraday, date for daily), v: DecStr}], reference?, secondary?: {ccy, points}}`.
`compare=true` returns the other currency's line; the NiceGUI page drops it when point counts differ (copy that rule). Optionally an
`all` response may add `contributions` (cumulative net external flows in `ccy`, needs the analytics fix below).
Gaps/risks:
- Intraday builders may hit the network (yfinance 5-minute bars) on first read per anchor; they are also called by `boot`. In the API either pre-warm in the scheduler (B6) or run in threadpool and accept latency. There is no "cache only" flag.
- `build_value_series`/`series_in_currency` use `date.today()` (server UTC) not `exchange_today()`; set `as_of=market_hours.exchange_today()` explicitly.
- Intraday `ValueSeriesPoint.date` carries `tz`-localised datetimes; pass `tz=UTC` and let the client format.
- Cold snapshot cache: pass `recompute_tail_days` for `all` (as the yearly page did) to avoid a multi-second synchronous rebuild.

### Suggested files
`IDB/api/{overview,holdings,allocations,graphs}.py`; `IDB/api/schemas/{overview,holdings,allocations,graphs}.py`;
`IDB/readmodels/{portfolio.py,fx_effect.py,graphs.py,allocation_view.py}`;
tests `backend/tests/api/test_{overview,holdings,allocations,graphs}.py`, `backend/tests/readmodels/test_fx_effect.py`.

---------------------------------------------------------------------------------------------------

## B2 reads B: periods, analytics, deposits, transactions, diagnostics, calculator

### Periods (`GET /api/periods/{monthly|yearly}?ccy=`)
- Call `readmodels/queries/period_query.py: aggregate(session, *, monthly, with_closing_value=True, today=None, display_currency=None, fill_gaps=False) -> list[PeriodRow]`.
  Pass `display_currency=ccy` (the `*_display` fields are only filled for non-EUR; for EUR use the base fields).
- `PeriodRow`: `label, contributions, dividends, interest, net_flow, opening_value_eur, closing_value_eur, growth_pct, *_display (contributions, dividends, interest, net_flow, opening_value, closing_value, growth_pct), display_currency, total_growth_compounded_eur/_usd, yearly_growth_eur/_usd, closing_value_usd`.
- Existing `readmodels/periods.py` emits only the base EUR fields + `*_display`; it omits `total_growth_compounded_*`, `yearly_growth_*`, `closing_value_usd`. Extend it (additive) and flatten per ccy: `{label, contributions, dividends, interest, net_flow, opening_value, closing_value, growth_pct, total_growth_compounded, period_growth_xirr}`.
- Currency: cashflows converted per trade date (frozen `net_eur`/`net_usd`, `_amount_in`), balances at period-end rate. `growth_pct` is Modified Dietz in the chosen currency; `*_compounded_*` are XIRR families computed per currency. Never derive one from the other.
- Fill gaps: monthly view uses `fill_gaps=True` for charts if wanted.

### Activity / deposits (`GET /api/deposits?ccy=`)
- `readmodels/queries/deposits_query.py: compute_summary(session, *, today) -> DepositSummary(total_contrib_native, total/ytd/mtd_contrib_{eur,usd})`, `list_deposit_records(session, *, account_id=None) -> list[DepositRecord(id,date,account_label,native_currency,kind,amount_native,amount_eur,amount_usd,description)]`.
- Existing `readmodels/deposits.py: build` already shapes it (both ccy). Add `ccy` selection and `account_id` filter. Dividends activity comes from period rows (`dividends`, `interest`) or `dividends.income_dual`.
- B5 will add per-deposit FIFO match fields (`effective_rate`, `eur_actual`, `matched_batches`, `fallback_to_ecb`). Reserve optional fields now.

### Transactions (`GET /api/transactions`, + single `GET /api/transactions/{id}` used by edit)
- `readmodels/queries/ledger_query.py: LedgerFilters(account_id, instrument_symbol, kind, source, start, end, hide_settlement_sweeps=True)`; `list_ledger_records(session, filters, *, fx_rate=None) -> list[LedgerRecord(id,date,account_label,kind,symbol,native_currency,quantity,price_native,fees_native,gross_native,net_native,net_eur,net_usd,source)]` newest first; `summarize_ledger(...) -> LedgerSummary`.
- Existing `readmodels/transactions.py: build(session, *, context, filters)` returns all rows.
- NEW: paging. No limit/offset anywhere (1,807 rows today, fine to return all, but spec asks for paging). Add `limit/offset` (slice after `session.scalars(stmt)`, or apply `.limit()/.offset()` in `_build_ledger_stmt`) and a `total` count. Also return `account_id`, `instrument_id`, `account_label`, `external_id` presence, `description`, `settlement_date` (needed by the edit form; `LedgerRecord` lacks `account_id`, `instrument_id`, `description`).
- Query params: `account_id, symbol, kind, source, start, end, hide_sweeps, limit, offset`.
- Both legs (`net_eur`, `net_usd`) are frozen at write time (trade-date rate); amounts are shown as stored, no conversion. Rows with NULL legs mean an FX gap (surface a flag).
- Reference lists for filters: `accounts_repo.list_accounts`, `instruments_repo.list_instruments`.

### Analytics / risk (`GET /api/analytics?ccy=&lookback_days=365&full_curve=false`)
- `readmodels/queries/analytics_query.py: build_bundle(session, *, currency="EUR", lookback_days=365, as_of=None) -> AnalyticsBundle`; `build_curve(session, *, start, end, currency, benchmark_closes)`.
- `AnalyticsBundle`: `as_of,start,currency,curve[EquityCurvePoint(date,portfolio_value,cumulative_contributions,benchmark_value)],cagr,twr,xirr,volatility,sharpe,sortino,max_drawdown,calmar,ulcer,var_95,cvar_95,skew,kurtosis,beta,alpha,risk_free_rate,risk_free_symbol,benchmark_symbol,attribution[AttributionRow]`.
- Existing `readmodels/analytics.py: build` computes the EUR bundle plus a USD bundle and emits `<metric>_usd` companions and `portfolio_value_usd` per curve point. For the v6 API prefer one bundle per requested ccy (`build_bundle(currency=ccy)`), halving the work.
- CURRENCY BUGS to fix before exposing `ccy=USD` (both violate the currency rule):
  1. `analytics_query.py` `_build_curve` (~L157): `contribs_by_date` uses `t.net_eur` even when `currency="USD"`, so the USD curve's `cumulative_contributions` (and therefore the TWR cashflows in `build_bundle`, ~L350-360) are EUR amounts against USD values. Use `dual_currency_amounts` / frozen `net_usd` per currency.
  2. `build_bundle` returns `xirr=portfolio_metrics.xirr` (EUR XIRR) for every currency; use `xirr_usd` when `currency="USD"`.
  3. `_attribution_for_window` (~L260) sums `net_eur` and EUR positions regardless of currency: label attribution EUR-only or compute USD.
- `full_history_curve` option exists in `readmodels/analytics.py` (inception curve); keep as `full_curve=true`.
- Perf: two `build_bundle` calls + `compute_portfolio_metrics` + benchmark fetch; cache per (ccy, as_of) for the request burst.

### Diagnostics (`GET /api/diagnostics`)
- `services/diagnostics_service.py: check_health(session) -> HealthReport(items: tuple[HealthItem(key,title,severity,count,detail,examples)], generated_at)`; properties `problems, has_problems, problem_count, worst_severity`; `quick_status(session) -> (severity, count)` for a nav badge.
- Process-memory status (all thread-safe, module-level): `services/provider_status.py: all_latest() / get_log(limit) -> StatusEvent(provider,status ok|partial|error,message,at)`; `services/refresh_status.py: snapshot() -> RefreshActivity(active,source,seq,last_update_at,historical,progress_done,progress_total,progress_label)`; `services/runtime_status.py: recent(limit) -> list[BackgroundError(source,message,seq,at,severity)]`, `dismiss(seq)`, `dismiss_all()` (POST/DELETE); `services/fetch_report.py: all_latest() -> {provider: FetchReport(symbols, at)}`; `services/pull_log.py` (round log, text).
- Also: `intraday_snapshots_service.assess_graph_coverage(session)`, `fx_service.get_live_spot("USD")`, `benchmark_service.get_symbol`, tiingo budget (see settings page `_tiingo_budget_snapshot`, `repositories/tiingo_state_repo`).
- Support bundle: `services/support_bundle.py: build_support_bundle() -> str`, `bundle_filename()` (reads the log file; secrets redacted by `redaction.py`). Expose as `GET /api/diagnostics/support-bundle` (text download).
- New readmodel `readmodels/diagnostics.py` flattening the above. All of it is process-local: after a server restart the status lists are empty (document).

### Calculator / projection / rebalance (`POST /api/calculator`, plus `GET /api/calculator` inputs)
- Existing read-model `readmodels/calculator.py: build(session, *, context, years=10, months=36)` = fixed-scenario yearly/monthly projections in EUR only (`project_from_session`, `project_monthly_from_session`: start = EUR `total_portfolio_value`, average historical EUR contributions).
- Interactive projection (what the UI page does) lives in `ui/pages/_projection_view.py` (still UI-coupled): `build_seed(session, *, monthly, primary, today)` -> `ProjectionSeed(starting_eur, starting_usd, avg_contribution_eur/usd, expected_rate_eur/usd, usd_per_eur, xirr_available, ...)` and `_params(seed, controls)` -> `ProjectionParams` x2. Move `ProjectionSeed/build_seed/_avg_contribution` and the controls->params mapping into `readmodels/projection.py` (no nicegui). Pure engine is already in `readmodels/queries/projection_model.py`: `simulate(params) -> ProjectionResult(points[ProjectionPoint(index,label,period_date,contributed,nominal_by_scenario,real_by_scenario)])`, `band_rates(expected, band)`, `default_expected_rate(xirr)`, `time_to_target(result, target, real=)`, `required_contribution(params, target, scenario=)`.
- Currency: simulate twice, EUR at EUR XIRR and USD at USD XIRR (each its own historical return); the UI's "spread" trick (secondary expected = primary +/- historical spread) is an assumption, not a conversion; contribution entered in one ccy is converted to the other at today's spot (a forward assumption, flag it in the response as `assumptions.usd_per_eur`). Request: `{monthly, ccy, expected_rate, band, stepup, inflation, horizon, contribution, target, real}`; response: per-scenario series in the requested ccy + `time_to_target` + `required_contribution` + seed echo.
- Rebalance plan: `domain/allocation.py: plan_rebalance(cash_to_invest, target_weights_pct, current_values, current_prices=None, *, allow_fractional_shares=False, fractional_decimals=4, allow_sell=False, no_buy_ids=None, category_of=None) -> RebalancePlan(rows[RebalanceRow(instrument_id,target_pct,current_value,add_value,current_price,add_shares,no_buy)], cash_to_invest, residual_cash)`, `expand_category_weights(...)`, `current_weights_pct`. Inputs from `readmodels/queries/calculator_query.py: build_calculator_data(session) -> CalcData(instruments, categories, fx_rate_usd_per_eur, default_currency)`; every figure there is EUR (`current_value_eur`, `price_eur` converted at today's spot via `_price_to_eur`). The assembly (`_build_weights`, `_build_category_weights`, `_held_unticked_extras`, EUR<->display conversion, ui/pages/calculator.py L617-760) is page code: extract to `readmodels/rebalance.py: build_plan(session, *, cash, ccy, weights|category_weights, no_buy_ids, allow_sell, fractional)`; convert cash to EUR at spot, plan in EUR, convert rows back at the same spot (single-instant conversions only).
- Valid: `plan_rebalance` raises `ValueError` -> map to 422.

### Suggested files
`IDB/api/{periods,deposits,transactions (GET half; B3 owns the write half in the same file),analytics,diagnostics,calculator}.py` and matching `schemas/`;
`IDB/readmodels/{diagnostics.py,projection.py,rebalance.py}` plus edits to `periods.py`, `analytics.py`, `transactions.py`, `queries/ledger_query.py`, `queries/analytics_query.py`;
tests `backend/tests/api/test_{periods,deposits,transactions_read,analytics,diagnostics,calculator}.py`, analytics USD regression test.
Coordination: `api/transactions.py` is touched by B2 (GET) and B3 (POST/PUT/DELETE); agree one owner or split into `transactions.py` + `transactions_write.py` mounted on the same prefix.

---------------------------------------------------------------------------------------------------

## B3 writes

### Manual transactions (`POST/PUT/DELETE /api/transactions`)
`services/manual_entry.py` is pure helpers only (no DB): `signed_net(kind, magnitude)`, `signed_quantity(kind, magnitude)`,
`net_sign(kind)`, `reconcile_trade(quantity, price, total) -> TradeFigures(quantity, price, total, error)`,
`settlement_leg_values(net_native) -> MoneyMarketLeg | None`, `money_market_leg(kind, net_native)`, constants `TRADE_KINDS`,
`MONEY_MARKET_TRIGGER_KINDS`, `RECONCILE_TOLERANCE`.
The actual create/update/delete orchestration exists ONLY inside the NiceGUI page `ui/pages/transactions.py`:
- `_save` (L369-): reconcile -> net sign -> `instruments_repo.get_or_create(session, symbol)` -> `transaction_fx_service.compute_legs(session, native_currency=, net_native=, on=date) -> TransactionLegs(fx_rate_to_eur, net_eur, net_usd, complete)` -> `transactions_repo.insert_transaction(session, Transaction(source="manual", ...))` / `update_transaction(session, id, **fields)`.
- `_maybe_money_market_leg` (L501), `_find_existing_settlement_leg` (L557), `_resync_settlement_leg` (L584): paired VMFXX/SPAXX settlement leg (external id convention `:vmfxx`, `manual:{id}` parent id) created/kept in sync/deleted; helpers `transactions_repo.find_account_money_market_instrument / find_settlement_leg / find_legacy_settlement_leg`.
- `_confirm_delete` (L632): delete paired leg then `transactions_repo.delete_transaction(session, id)`.
- Every write then calls `snapshots_service.invalidate_for_trade_dates(session, {old_date, new_date})` (and v5 `auto_publish.schedule_publish_after_edit()` which must NOT be carried over).
NEW: `services/transaction_service.py` with `create(session, payload) -> Transaction`, `update(session, id, payload)`, `delete(session, id)` extracted from the page (+ move the three settlement helpers there). Reuse for tests; the NiceGUI page can later call it.
Request body: `{account_id, date, kind, symbol?, quantity?, price?, total?, fees?, description?, route_money_market: bool}` (user types positive magnitudes; server applies signs). Response: the transaction row (same shape as the GET row) + `warnings` (e.g. `legs.complete == False` -> "FX missing for date").
Also after writes: `intraday_snapshots_service.clear_week_samples(session)` (importer does it for imports) and, for B5, recompute FIFO matching.
Currency: write-time legs are frozen via `transaction_fx_service.compute_legs` (USD-native: `net_usd = net_native`, `net_eur = net_native / ECB rate on the date`). Do not add columns (AGENTS.md).
Validation to port: account exists, date parse, `kind` in `TransactionKind`, required fields per kind, `UNIQUE(account_id, external_id)`.

### Imports (`POST /api/imports`, `POST /api/imports/{id}/confirm`)
- Today (`ui/pages/transactions.py` `_open_import_modal` L718): the upload is just stashed in a dict as bytes; there is NO preview. Confirm calls `importer_service.import_csv(session, *, broker: Broker, account_id, content: str|bytes) -> ImportResult`, which parses AND writes in one go (idempotent through `UNIQUE(account_id, external_id)`; duplicates counted).
- `ImportResult`: `inserted, duplicates, sweeps_dropped, unknown_actions, fx_missing_dates, errors[RowIssue(message,line,raw)], warnings[RowIssue], unresolved_symbols`.
- Parse step: `importer_service._parse(broker, content) -> ParseReport(rows[ParsedTransactionRow], sweeps_dropped, unknown_actions, errors, warnings)` (private; make it public as `parse_only`). Vanguard additionally runs `adapters/vanguard/settlement.py: inject_settlement_legs(rows)` before insert (so preview rows must apply it to match what will be written). Xlsx detected by `b"PK\x03\x04"`; CSV decoded `utf-8-sig`.
- `ParsedTransactionRow`: `date, settlement_date, kind, symbol, quantity, price_native, gross_native, fees_native, net_native, description, external_id, source, name, asset_class, native_currency, expense_ratio`.
- Preview needs a duplicate count (not available): add `transactions_repo.existing_external_ids(session, account_id, ids) -> set[str]` and mark rows `is_duplicate`.
- Holding the preview between two HTTP calls: process-local store `services/import_staging.py` (dict `{import_id: StagedImport(broker, account_id, filename, raw_bytes, report, created_at)}` guarded by a lock, TTL ~30 min, max N entries/size, uuid4 id, tied to the session principal). Store the RAW BYTES (not only the report) and re-run `import_csv` on confirm: guarantees what is written equals a fresh parse, and idempotency makes retries safe. Single-process uvicorn only (no multi-worker; if workers>1 the store must move to the DB/disk). Enforce upload limit (e.g. 10 MB) and extension allowlist `.csv,.xlsx`; needs `python-multipart` (already a dependency).
- Confirm must run off the event loop (sync endpoint): `ensure_instrument` calls yfinance per unknown symbol, `ensure_fx_coverage` hits Frankfurter. After confirm with `inserted > 0`: call `intraday_snapshots_service.reload_graphs(session)` (page does via `_reload_graphs_after_import`) or leave to the scheduler.
- Response preview: `{import_id, broker, account_id, filename, counts{rows, new, duplicates, sweeps_dropped}, rows[first N], errors, warnings, unknown_actions, expires_at}`; confirm returns `ImportResult` fields.

### Allocations write (`PUT /api/allocations`)
- `repositories/allocations_repo.py` has only `list_allocations, get_active, set_active, deactivate_all, create_allocation(session, name, weights_by_instrument_id, *, active, no_buy_ids, allow_sell, display_currency)`. No update/delete/rename; `name` is UNIQUE. NEW: `replace_allocation(session, id, ...)` / `delete_allocation(session, id)` in the repo and an `allocation_service` validating weights sum to 100 (`Numeric(5,2)`), instrument ids exist (comment in model says the repo must check; today it does not).
- Shape: `PUT /api/allocations {name, active, allow_sell, display_currency, items:[{instrument_id, weight_pct, no_buy}]}`; `POST .../{id}/activate` -> `set_active`; `DELETE`.
- Config tier: use `ConfigSessionDep` if tiers are split, else same session.

### Settings (`GET/PUT /api/settings`)
All stored in `app_config` (key/value, config tier) via `repositories/app_config_repo.py: get/set_value/delete_key`:

| Setting | Service | Get / set | Notes |
| --- | --- | --- | --- |
| display currency | `services/display_currency_service.py` | `get_display_currency(session)` / `set_display_currency(session, ccy)` (ValueError if not in `SUPPORTED_CURRENCIES=("EUR","USD")`) | the API `?ccy` overrides per request; this is the default |
| theme | `services/theme_service.py` | `get_theme -> bool|None` (None=auto, True=dark) / `set_theme(session, bool|None)` | API should expose `"auto"|"light"|"dark"` |
| timezone | `services/timezone_service.py` | `get_timezone / set_timezone(session, name)`, `supported_timezones()` | default `"Local"` = server local (UTC on the server): change default to a real zone |
| clock format | `services/clock_format_service.py` | `get_clock_format / set_clock_format(session, "auto"|"12h"|"24h")` | |
| chart prefs | `services/chart_prefs_service.py` | `get_pref(session, key, *, default, allowed=None) / set_pref(session, key, value)` (prefix `chart_pref.`); also `overview_query.effective_overview_range / remember_overview_range` | |
| auto-refresh interval | `services/auto_refresh.py` | `get_interval_seconds / set_interval_seconds(session, s)` (15..3600, default 60) | v5 re-arms a NiceGUI timer via `main.set_live_refresh_interval`; v6 scheduler (B6) must re-read the value each loop |
| regular invest amount | `services/investing_power_service.py` | `get_amount_eur / set_amount_eur` | drives the USD-mode panel |
| benchmark / risk-free | `services/benchmark_service.py` `get_symbol/set_symbol`; `services/risk_free_service.py` `get_symbol/set_symbol/set_manual_rate/get_risk_free_rate/refresh` | | analytics inputs |
| log level | `services/logging_service.py` `get_log_level / set_log_level` (INFO, DEBUG) | | |
| onboarding | `services/onboarding_service.py` `is_onboarded(session)` (>=1 account), `seed_default_setup(session) -> SeedResult`, `add_validated_instrument(session, symbol, *, category, asset_class, native_currency, name, expense_ratio, validator) -> TickerValidation` | `GET` returns `onboarded`; `POST /api/settings/seed` | |
| accounts / instruments | `repositories/accounts_repo.py` (`create_account, update_account`), `instruments_repo`, `instrument_overrides_repo` (`set_category, set_active, upsert`) | used by Settings page dialogs; include if the Settings/Onboarding pages need them |

Not for v6: sync folder/move ledger/passphrase/shutdown/live-web publish/Tiingo token in keyring (desktop-only). Tiingo token: `Settings.tiingo_token` env only (`prices_service._resolve_tiingo_token` falls back to keyring, must not be hit on the server: guard by `server_mode`).
Response: one `SettingsDto` with typed fields + `options` (supported currencies, timezones, clock formats, interval bounds).

### Refresh trigger (`POST /api/refresh`)
- `services/auto_refresh.py: tick_refresh(source="Live price refresh", *, force=False) -> bool` (blocking: yfinance prices, FX spot, intraday sample, graph backfill; never raises, records `refresh_status`/`runtime_status`), and `run_in_background(source, *, force=False)` which spawns a daemon `threading.Thread`.
- API: `POST /api/refresh?force=true` -> sync endpoint calling `run_in_background` (returns 202 + current `refresh_status.snapshot()`), or `asyncio.to_thread(tick_refresh)`. Add a lock/"already running" guard (`refresh_status.snapshot().active`) to avoid stacking; B6's scheduler should share the same guard.
- Heavy variants available: `boot.start_full_history_refresh(source, force_progress=)` (thread) for "re-download everything"; `intraday_snapshots_service.reload_day_graph/reload_week_graph/reload_graphs(session)`; `services/database_reset_service.py: reset_database(ResetLevel)` (CACHE/TRANSACTIONS/ALL; destructive: do NOT expose without confirmation + auth; AGENTS rule on permanent deletion).

### Backup (`GET /api/backup`)
- `storage/integrity.py: backup_database(db_path, dest_path, *, encryption=None) -> Path` (SQLite online backup API, works through SQLCipher; safe while writing); `storage/backup.py: snapshot(db_path, *, policy, now, encryption, min_interval)` (rolling hourly/daily/monthly in `<dir>/backups/`), `verify_backup(path, *, encryption) -> {table: rowcount}`; `storage/blob_crypto.py: encrypt_bytes(plaintext, passphrase) -> envelope dict (AES-GCM, PBKDF2)`, `decrypt_bytes`.
- `services/audit_export_service.py: build_audit_export_json(session, *, as_of=None, indent=2) -> str` (full `build_snapshot`, plaintext JSON), `audit_export_filename()`; `dev_password_configured / verify_dev_password` (constant-time, from `Settings.dev_password`).
- Proposed `GET /api/backup?kind=db|json`: `db` = `backup_database` to a temp file, then seal with `blob_crypto.encrypt_bytes(bytes, passphrase)` where passphrase is a request-supplied or settings value, stream as `application/octet-stream`; never ship the raw SQLCipher key. `json` = audit export (plaintext; require re-auth/dev password; contains all transactions). Use `StreamingResponse`/`FileResponse` with `BackgroundTask` to delete the temp file. Log each download.
- `tools/backup.py` CLI (`inv-dashboard-backup db --verify`) and the boot `_rolling_backup()` already exist; the server (D1) should run rolling backups on a schedule, not just at boot.

### Suggested files
`IDB/api/{transactions (write),imports,allocations (write),settings,ops}.py`; `schemas/{transactions,imports,allocations,settings,ops}.py`;
`IDB/services/{transaction_service.py,import_staging.py,allocation_service.py,settings_service.py (aggregator)}`; `repositories/allocations_repo.py` and `transactions_repo.py` additions;
tests `backend/tests/api/test_{transactions_write,imports,allocations_write,settings,ops}.py`, `backend/tests/services/test_transaction_service.py`.

---------------------------------------------------------------------------------------------------

## B4 auth

### Today
- `IDB/api/security.py` (C1 stub): `Principal(kind, session_id)`, `async authenticate(request) -> Principal` always 401. `IDB/api/deps.py: require_auth` calls it. `IDB/api/auth.py`: empty public `APIRouter(prefix="/auth")` (routes must depend on `require_auth` except login/passkey-login/`me`).
- `IDB/api/token_auth.py: require_token(authorization, x_api_token)` (kept v5 dependency): when `settings.api_token` is unset the API is OPEN. In v6 `authenticate` must accept the bearer token ONLY when `api_token` is configured (use `secrets.compare_digest`) and otherwise reject: do not inherit the open-by-default behaviour.
- Config (`IDB/config.py`, C1): `server_mode, session_secret (required in server_mode), session_idle_minutes=30, session_max_age_days=30, cookie_secure=True, login_rate_limit_per_minute=5, webauthn_rp_id="localhost", webauthn_rp_name, webauthn_origin, api_token`. Env prefix `INV_DASHBOARD_`. Deps already added: `argon2-cffi`, `webauthn`, `python-multipart`.
- `web/src/webauthn.ts` today is purely client-side: PRF-extension wrapping of the *mobile blob passphrase* in `localStorage` (`enrolBiometric`, `unlockWithBiometric`, `encryptPassphrase/decryptPassphrase`). No server verification, no relying-party logic, nothing reusable on the backend. v6 needs real server-verified WebAuthn registration/assertion via the `webauthn` lib (`generate_registration_options / verify_registration_response / generate_authentication_options / verify_authentication_response`); frontend uses `@simplewebauthn/browser` (per design brief).
- Contract from frontend (docs/v6_frontend_design.md): `POST /api/auth/login {password}` -> 204 + cookie; `POST /api/auth/logout`; `GET /api/auth/me -> {authenticated, passkeys:n}` (must work unauthenticated: `skipAuthRedirect`); `POST /api/auth/passkey/login/options|verify`; `POST /api/auth/passkey/register/options|verify` (authenticated); `GET /api/auth/passkeys`; `DELETE /api/auth/passkeys/{id}`.

### Where tables live
- `IDB/models/auth.py` stub says config tier (`ConfigBase` from `models/base.py`, same pattern as `AppConfig`/`TargetAllocation`), migration revision `e3b7c5d9f2a1`, `down_revision = "d2a6b4c8e1f0"` (B5), whose own down is `c1f5a3b9e2d4` (0014, current head).
- Tables (suggested): `auth_credentials(id=1 row or key/value: password_hash argon2id, updated_at)` (or store the hash in `app_config` key `auth.password_hash`: no migration needed, but prefer a table), `auth_sessions(id (sha256 of token), created_at, last_seen_at, expires_at, user_agent, ip)`, `auth_passkeys(id, credential_id (bytes), public_key (bytes), sign_count, transports, name, created_at, last_used_at)`, `auth_login_attempts` optional (rate limit can be in-memory per IP).
- Migration pattern (see `backend/migrations/versions/0011_v3_5_4_allocation_settings.py`, `0014_v3_9_3_intraday_market_component.py`): hand-written, idempotent, tier-aware: `bind = op.get_bind(); inspector = sa.inspect(bind); tables = set(inspector.get_table_names()); if "auth_sessions" in tables: return; op.create_table(...)`, with `downgrade()` that drops them if present. Alembic runs on the LEDGER URL only (`env.py` `target_metadata = list(ALL_METADATAS)`), so with a single file the config tables are created there; for split files `boot._ensure_secondary_tier_schema()` runs `ConfigBase.metadata.create_all` (so the model alone suffices there). Tests use `create_all`.
- Session design: opaque random token in an httpOnly, `Secure`, `SameSite=Strict` cookie; store only a hash server-side; idle timeout `session_idle_minutes` (slide `last_seen_at` on each authenticated request, throttle writes) and absolute `session_max_age_days`; `Principal.session_id`. Session signing secret `session_secret` is only needed if the cookie is signed (itsdangerous-style) rather than opaque; decide (opaque + DB lookup is simpler and revocable).
- Auth DB access in `authenticate` is a blocking call inside an `async def` dependency: use `run_in_threadpool`/make the dependency `def`, since `require_auth` is `async`.
- Rate limit: in-memory sliding window per client IP (`request.client.host` behind Caddy: uvicorn runs with `proxy_headers=True, forwarded_allow_ips="*"` in `api/app.py:run`, acceptable only because the port is bound inside the compose network; tighten to the Caddy IP) with `login_rate_limit_per_minute`; also apply to passkey verify. Constant-time-ish failure (verify against a dummy hash when no password set).
- CLI: `inv-dashboard-set-password` -> `IDB/tools/set_password.py: main()` (stub). Read password with `tools/_passphrase.py`-style `getpass` (never argv); hash with `argon2.PasswordHasher`; write via config session. First-run: if no password exists, every login fails and `/me` reports `authenticated:false` (no setup-over-HTTP endpoint; owner runs the CLI on the server).
- CSRF: cookie `SameSite=Strict` + JSON-only API; also check `Origin` header on state-changing requests against `webauthn_origin`/host.
- Passkeys: challenge storage between options and verify calls (short-lived in-memory dict keyed by a signed temp cookie or session; same multi-worker constraint as imports); `webauthn_rp_id` must be `investments.daniel-henke.de` in prod, `webauthn_origin` `https://investments.daniel-henke.de`.

### Suggested files
`IDB/api/{security.py (fill), auth.py (fill)}`, `IDB/api/schemas/auth.py`, `IDB/models/auth.py`, `IDB/repositories/auth_repo.py`, `IDB/services/auth_service.py` (hashing, sessions, rate limiter), `IDB/services/passkey_service.py`, `IDB/tools/set_password.py`, `backend/migrations/versions/0016_v6_auth_tables.py` (revision `e3b7c5d9f2a1`), tests `backend/tests/api/test_auth.py`, `backend/tests/services/test_auth_service.py`, `backend/tests/test_migration_0016.py`.

---------------------------------------------------------------------------------------------------

## B5 currency (plan section 2.5)

### What a USD deposit looks like today
- Account: `models/account.py: Account(broker, account_label, native_currency="USD", account_type)`.
- Row: `models/transaction.py: Transaction(kind="deposit" | "transfer_in", account_id, date, net_native=+USD amount, net_usd=net_native (frozen, verbatim), net_eur=net_native / ECB EUR->USD rate on `date` (frozen, forward-filled), fx_rate_to_eur=that rate, source in {import_vanguard_csv, import_vanguard_xlsx, import_fidelity_csv, manual, migration}, external_id)`. Written by `services/transaction_fx_service.py: compute_legs(session, *, native_currency, net_native, on) -> TransactionLegs` via `domain/currency.py: split_native_to_dual_legs(...)`. Rate convention: `fx_history` stores quote-per-1-EUR (EUR->USD ~1.08). Withdrawals mirror with `kind="withdrawal" | "transfer_out"`, negative `net_native`. Vanguard also gets auto settlement legs (VMFXX buy) which are NOT external flows.
- `services/transaction_fx_service.py` also has `backfill_missing_legs(session, *, force)`, `missing_fx_dates`, `ensure_fx_coverage(session, *, earliest_needed)`.
- Read helper: `domain/currency.py: dual_currency_amounts(*, native_currency, net_native, net_eur, on, eur_to_usd, fallback_rate=None, net_usd=None) -> (eur, usd)`: returns the frozen legs verbatim when both exist (the natural place to inject an override).

### Exact functions computing EUR cashflows (the plug-in points)
External-flow kinds: `metrics_service._CONTRIBUTION_KINDS = {deposit, transfer_in}`, `_WITHDRAWAL_KINDS = {withdrawal, transfer_out}`, `EXTERNAL_FLOW_KINDS`. FIFO matching applies to contribution kinds with USD-native accounts only.

| Site | Function | Use |
| --- | --- | --- |
| 1 (primary) | `services/metrics_service.py: _txn_eur_amount(t) -> Decimal` (L193; returns `net_eur` else `net_native`) | feeds `compute_portfolio_metrics` (contributions_eur, withdrawals_eur, ytd contributions) and `build_portfolio_cashflows_dual(...)` / `build_portfolio_cashflows(...)` -> the EUR XIRR (`xirr(cashflows_eur, ...)`), YTD XIRR, MTD (`_compute_mtd_growth`) |
| 2 | `metrics_service.build_portfolio_cashflows(transactions, *, retained_cash_account_ids, amount_fn)` | `amount_fn=None` uses `_txn_eur_amount`; `readmodels/queries/period_query.py` L670 calls it for `total_growth_compounded_eur`/`yearly_growth_eur` |
| 3 | `readmodels/queries/period_query.py: _amount_eur(t, *, eur_to_usd)` (L152) and `_amount_in(...)` (L192, the `target=="EUR"` branch) | monthly/yearly EUR contributions and Modified Dietz |
| 4 | `readmodels/queries/deposits_query.py: _amounts(t, *, native_currency, eur_to_usd, fallback_rate)` (L97) | deposits table + `DepositSummary` totals/ytd/mtd (EUR) |
| 5 | `readmodels/queries/analytics_query.py` `_build_curve` (~L157 `t.net_eur`) and `_attribution_for_window` (~L260) | cumulative contributions line, TWR cashflows |
| 6 | `services/benchmark_service.py: _txn_eur_amount(t)` (L178; duplicate of #1) | "same contributions into the index" simulation in EUR |
| 7 | `readmodels/queries/overview_query.py` ~L753 (`dual_currency_amounts` per trade, instrument-level XIRR) and `metrics_service.build_instrument_cashflows` | buys/sells, not deposits: leave at ECB trade-date rate (documented inconsistency: instrument EUR XIRR keeps ECB basis; portfolio EUR XIRR uses actual EUR) |
| 8 | `readmodels/queries/ledger_query.py: _to_record` (display of `net_eur`) | show effective value alongside the frozen one |

Recommended seam: one function `effective_eur_leg(t, overrides)` (domain/service) and a request-scoped `overrides: dict[int, Decimal]` (txn id -> EUR actually spent) produced by `services/fx_pool_service.py: build_effective_eur(session) -> dict[int, Decimal]`; sites 1-6 take `overrides` (default `{}` = today's behaviour, which keeps the parity gate: with no conversions entered everything must equal today's numbers). Replace the two duplicated `_txn_eur_amount` helpers by one shared function. USD legs never change.
Return rule: EUR XIRR/TWR are recomputed from the EUR cashflow stream with these amounts, never `usd_return / fx`.

### New pieces (progress file B5; migration `d2a6b4c8e1f0`, down `c1f5a3b9e2d4`)
- `IDB/models/fx_conversion.py` (stub, ledger tier): `FxConversion(id, date, eur_sent, usd_received, fees_eur?, note, created_at)`; native amounts only; effective rate `usd_received / eur_sent` is derived, not stored.
- `IDB/domain/fx_pool.py` (pure, `mypy --strict`, hypothesis + golden tests): `match_fifo(conversions: Sequence[Batch], deposits: Sequence[UsdDeposit]) -> list[DepositMatch]` where `DepositMatch(deposit_id, allocations=[(batch_id, usd_used, eur_cost)], uncovered_usd)`; the uncovered remainder is priced by the caller at the ECB rate (`fallback_eur = uncovered_usd / ecb_rate(date)`). Properties: USD used <= deposit; sum of USD used per batch <= batch USD; eur conserved; FIFO order by batch date; deposits processed by date then id; withdrawals ignored (or reduce pool: decide with owner). Decimal only.
- `IDB/repositories/fx_conversions_repo.py`, `IDB/services/fx_pool_service.py` (loads batches + deposit txns, `effective_eur_by_deposit`, per-deposit `effective_rate`, `fallback_to_ecb` flags for Diagnostics), `IDB/api/fx_conversions.py` (CRUD `/api/fx-conversions` + `GET /api/fx-conversions/pool` balance + per-deposit matching), schemas, tests `backend/tests/domain/test_fx_pool.py`, `backend/tests/services/test_fx_pool_service.py`, `backend/tests/api/test_fx_conversions.py`, parity-gate test (`compute` with zero conversions == current numbers on a fixture).
- Caches: any cache of EUR cashflow-derived values must invalidate on conversion CRUD (snapshots hold VALUES only, not contributions, so `PositionSnapshot` is unaffected; monthly/yearly are recomputed live).
- Deposits readmodel additions: `effective_rate, eur_actual, eur_ecb, matched_batches[], fallback_usd`.
- Currency effect (B1) interplay: `compute_currency_effect.avg_invest_rate = contributions_usd / contributions_eur` then reflects the actual rate automatically once `total_contributions_eur` uses effective EUR.
- Deferred by decision: native-USD snapshot/intraday storage migration and dropping `net_eur`/`net_usd` (parity gate first).

---------------------------------------------------------------------------------------------------

## B6 live: scheduling inventory

### How v5 schedules things

| Job | Trigger today | Function | Blocking? | asyncio-safe? |
| --- | --- | --- | --- | --- |
| Offline boot (migrations, backups, janitor) | once, before `ui.run` (`main.run`) | `boot.run_boot_sequence(skip_network=True)` | yes (disk, SQLCipher, alembic) | call once in `to_thread` during lifespan startup |
| Deferred network refresh (FX, tx legs, prices, live FX, splits, benchmark, intraday 1D, 1W, snapshot warm) | thread started at launch (`main._start_deferred_network_refresh`) | `boot.run_full_history_refresh(source, *, force_progress=False) -> bool` (wraps `refresh_status` + `runtime_status`; never raises) | yes, minutes on a cold cache | `await asyncio.to_thread(...)` |
| Live price tick | `app.timer(interval, _live_refresh_tick)`; interval from `auto_refresh.get_interval_seconds` (default 60, min 15); also page load/chip click via `auto_refresh.run_in_background` | `auto_refresh.tick_refresh(source, *, force=False) -> bool`: `prices_service.refresh_due_prices(ledger, cache)` (TTL gated; includes Tiingo fallback) -> `fx_service.refresh_live_spot()` -> `intraday_snapshots_service.record_if_market_open()` -> `intraday_snapshots_service.backfill_graphs()` | yes (yfinance HTTP) | `to_thread`; takes both tiers' sessions itself |
| Intraday sample | inside the tick | `intraday_snapshots_service.record_if_market_open(*, now=None) -> bool` (opens own sessions, 5-min dedupe `MIN_CAPTURE_GAP_SECONDS`, prunes older than week window) | DB + `compute_positions` | `to_thread` |
| Graph backfill | inside the tick | `intraday_snapshots_service.backfill_graphs(*, now=None) -> GraphCoverage` (calls `reconstruct_last_session`, `week_series_with_fx(force=True)`; yfinance bars) | yes | `to_thread`; guarded by module `_reconstruct_lock` |
| Tiingo fallback | inside `prices_service.refresh_prices/refresh_due_prices` via `tiingo_fallback_wiring.apply_desktop_fallback(...)` (`_maybe_run_tiingo_fallback`) | `tiingo_fallback_runner.run_desktop_fallback` (budgeted: `repositories/tiingo_state_repo`) | yes (HTTP) | token from `Settings.tiingo_token` or keyring (`prices_service._resolve_tiingo_token`): on the server set the env var; keyring import is lazy |
| Cache janitor | boot only | `cache_janitor.cleanup_orphan_cache_rows(ledger_session, cache_session) -> dict[str,int]` (`boot._run_cache_janitor`) | short DB | `to_thread`; run daily |
| EOD snapshots / splits / benchmark / risk-free | boot (`_warm_snapshots`, `_refresh_splits`, `_refresh_benchmark`) and lazily on read | `snapshots_service.warm_range(session, start, end, *, force=False) -> int`, `invalidate_for_trade_dates`; `prices_service.refresh_splits(ledger, cache, *, earliest_needed)`; `benchmark_service.refresh_history(session, *, start)`; `risk_free_service.refresh(session)` | yes | `to_thread`; run once after close (e.g. ET 16:30 + 17:30) |
| Daily ECB FX | boot (`_refresh_fx`) | `fx_service.purge_legacy_yfinance_fx_history(cache)` + `fx_service.refresh_fx_history(cache, *, earliest_needed)` | HTTP | `to_thread`; run on startup + daily ~16:30 CET |
| Live FX spot | inside tick | `fx_service.refresh_live_spot(...) -> Decimal | None` writes the process-local `_LIVE_SPOT` (overlaid onto `get_rates` for today only; NOT in `fx_history`) | HTTP | `to_thread` |
| Event-loop watchdog | `app.on_startup(loop_watchdog.start)` via `loop_watchdog.install()` | `loop_watchdog.start(...) -> asyncio.Task` (async; `install()` imports nicegui lazily: do not call it; call `start()` directly in lifespan) | async, cheap | native asyncio |
| Error reporting hooks | `error_reporting.install()`, `app.on_startup(install_asyncio_handler)` | stderr tee, thread excepthook, asyncio handler | | `install_asyncio_handler` needs a running loop (call in lifespan) |
| Auto publish / shutdown-on-tab-close | NiceGUI only | `services/auto_publish.py`, `shutdown.py` (imports nicegui at module level) | | desktop-only: do not import in the server |
| Market hours | pure | `domain/market_hours.py: is_us_market_open(now), is_trading_day, latest_settled_session_date, exchange_today, regular_session_open/close, is_forex_market_open` | pure | call freely |

### v6 scheduler design (lifespan task)
- `services/server_runtime.py: startup(app)/shutdown(app)` (C1 stub) -> `await asyncio.to_thread(boot_server)` then, if `settings.scheduler_enabled`, `app.state.scheduler = asyncio.create_task(scheduler.run())`; cancel + await in `shutdown`. Idempotent.
- `services/scheduler.py: async def run()`: loop with `asyncio.sleep`; each job wrapped in `await asyncio.to_thread(job)` with try/except + `runtime_status.record_error`; single-flight per job (an `asyncio.Lock` or `refresh_status.snapshot().active` check) so a slow yfinance round cannot stack. Cadence: market open (`is_us_market_open`) -> `tick_refresh` every `get_interval_seconds` (read each iteration, so a Settings change applies at once); market closed -> FX spot every 30-60 min, one tick after close, EOD jobs once per session date (store the last-run date in `app_config`, e.g. `scheduler.eod_done=<ET date>`), janitor daily, rolling backup hourly/daily, ECB FX daily.
- Never call `tick_refresh` directly on the event loop: it opens sync sessions and does blocking HTTP. `run_in_background` (daemon thread) is also acceptable but unobservable; prefer `to_thread` for cancellation/awaiting.
- Server boot variant of `boot.run_boot_sequence` (see D1): skip desktop-only steps when `settings.server_mode`.

### Live bus + SSE (`GET /api/stream`)
- `services/live_bus.py`: in-process pub/sub (`subscribe() -> asyncio.Queue`, `publish(event)`; bounded queues; drop-oldest). Publish from the scheduler after each tick: `{type:"tick", at, market_open, total_value_eur, total_value_usd, daily_growth_pct(_usd), fx_eur_usd, prices:{symbol:{price, as_of}}}`, `{type:"fx"}`, `{type:"status"}` (refresh active/progress from `refresh_status.snapshot()`), plus 15-30 s heartbeat comments. Frontend `lib/live.ts` already expects `EventSource("/api/stream")` with backoff.
- Payload source: a light total only: `positions_service.total_portfolio_value(session, as_of)` per tick (cheap) rather than `compute_portfolio_metrics` (heavy); compute USD as EUR x spot (single instant). Full KPIs stay on REST (client invalidates queries on tick).
- Implementation: `fastapi.responses.StreamingResponse(media_type="text/event-stream")` or `sse-starlette` (listed as optional in progress file; not in pyproject); set `Cache-Control: no-cache`, `X-Accel-Buffering: no` (Caddy: disable response buffering / `flush_interval -1` for this path). `app.py` security middleware sets `Cache-Control: no-store` for `/api` (fine). Detect disconnects (`request.is_disconnected()`); auth via the same cookie (`EventSource` sends cookies same-origin).

### Suggested files
`IDB/services/{server_runtime.py (fill), scheduler.py, live_bus.py}`, `IDB/api/{stream.py, ops.py (refresh)}`, `IDB/boot.py` (server variant), tests `backend/tests/services/test_scheduler.py` (inject clock, fake jobs), `backend/tests/api/test_stream.py`.

---------------------------------------------------------------------------------------------------

## D1/D2 deploy and ops

### Encryption today
- `IDB/storage/encryption.py`: `resolve_encryption(*, encrypt_synced_tiers, env_passphrase) -> EncryptionConfig(enabled, driver, passphrase)`. Driver auto-detected by `importlib.util.find_spec` in order `pysqlcipher3`, `sqlcipher3` (`_detect_driver`); passphrase = `Settings.db_passphrase` (env `INV_DASHBOARD_DB_PASSPHRASE`) else OS keyring (`keyring` is a core dependency, imported lazily: with `server_mode` always supply the env var so the keyring is never touched; a headless Linux box has no backend and logs a warning on fallback).
- Activation: `Settings.encrypt_synced_tiers` (`INV_DASHBOARD_ENCRYPT_SYNCED_TIERS=true`) -> `boot._apply_encryption()` -> `db.set_active_encryption(cfg)`. `db.make_engine` rewrites `sqlite:///` to `sqlite+pysqlcipher:///` (`to_sqlcipher_url`) and applies `PRAGMA key = '<pass>'` in a `connect` listener (first statement), then WAL + `foreign_keys=ON` + `synchronous=FULL` (NORMAL for cache).
- SQLAlchemy 2.0.50's `pysqlcipher` dialect `import_dbapi` tries `import sqlcipher3` first, then `pysqlcipher3.dbapi2`, so the `sqlcipher3-binary` wheel works with this URL. But: (1) the dialect's own `on_connect` runs `pragma key=""` (URL has no password) BEFORE the app's key listener; (2) it forces `SingletonThreadPool` (one connection per thread); (3) it has a stray `print(query_pragmas)` on every connect. Nothing in `backend/tests` exercises a real encrypted engine (only `tests/storage/test_file_safety.py` mentions sqlcipher). D1 must add an integration test that opens an encrypted file, writes, reopens, and survives the empty-key-then-real-key sequence on Linux.
- `pyproject` `encrypted` extra pins only `pysqlcipher3>=1.2 ; sys_platform != 'win32'` (needs a compiled libsqlcipher); the plan says `sqlcipher3-binary` for the image: change the extra/Dockerfile to `sqlcipher3-binary` (only the orchestrator may edit pyproject).
- Cache tier is intentionally unencrypted when it is a separate file (`db.get_cache_engine`); it is encrypted only when it shares the ledger/config file.
- Raw-sqlite helpers (`storage/integrity.py: integrity_check`, `backup_database`; `storage/backup.py`) use `encryption.connect_sqlite(path, config)`, which imports `<driver>.dbapi2` directly (works for `sqlcipher3.dbapi2`).
- Encrypt a plaintext DB: `tools/split_db.py: _encrypt_inplace(plain_path, passphrase)` (private) uses `ATTACH DATABASE ? AS enc KEY '...'; SELECT sqlcipher_export('enc')` but imports `pysqlcipher3` first, then `sqlcipher3`. Reuse/extract as `storage/encryption.py: encrypt_database_file(src, dest, passphrase)`.

### DB paths
`Settings.db_path` (env `INV_DASHBOARD_DB_PATH`, legacy single file, all tiers), or `ledger_path/config_path/cache_path` (`INV_DASHBOARD_{LEDGER,CONFIG,CACHE}_PATH`). `boot._apply_resolved_layout()` returns early when `INV_DASHBOARD_DB_PATH` is set; otherwise it runs `storage.resolve_storage_layout` which includes OneDrive/Dropbox/iCloud/GDrive detection (desktop-only) and reads persisted `ledger_path/config_path` overrides from the config tier. On the server set explicit env paths under `/data` and never rely on detection. Recommended server layout: `LEDGER_PATH == CONFIG_PATH == /data/ledger.sqlite` (encrypted; one file so every `app_config`/auth read through either session sees the same data) and `CACHE_PATH=/data/cache.sqlite` (unencrypted, rebuildable, excluded from backups). Note `Settings.is_split_db` is then `True` (cache differs) which activates `cache_read_session/cache_write_session` routing: required for correctness, tested by `tests/test_db_tiers.py`.

### `boot.run_boot_sequence(*, skip_network=False)` steps (current order)
| Step | Function | Server? |
| --- | --- | --- |
| 1 | `_apply_encryption()` | keep (env passphrase only) |
| 2 | `_apply_resolved_layout()` | keep only the env-path branch; skip cloud detection and persisted overrides |
| 3 | `_check_sidecars()` (`-wal/-shm` next to cloud files) | skip (desktop/cloud) |
| 4 | `_acquire_writer_lock()` (`storage/lock.py`, file lock; falls to read-only on conflict) | skip or keep as a safety net against two containers on one volume; but a read-only fallback must NOT silently happen on the server (fail fast) |
| 5 | `_integrity_check_tiers()` (daily marker file, `storage/integrity.py`) | keep |
| 6 | `_rolling_backup()` (`storage/backup.snapshot`, hourly min interval) | keep, but also schedule (B6) |
| 7 | `_run_migrations()` (Alembic via `_load_alembic_config`: searches `<pkg>/../../../alembic.ini` and CWD; `create_all` fallback) | keep; Dockerfile must place `alembic.ini` + `migrations/` where one of those candidates finds it (backend/ dir as CWD works); if not found it silently falls back to `create_all`, which would skip data migrations: make the server fail loudly instead |
| 8 | `_apply_persisted_log_level()` | keep |
| 9 | `register_plotly_template()` (imports `investment_dashboard.ui.theme` at MODULE import of `boot.py`, line 35) | drop; remove the module-level `ui.theme` import (blocks deleting `ui/` at cutover) |
| 10 | `_run_cache_janitor()` | keep |
| 11+ (if not `skip_network`) | `_refresh_fx, _backfill_transaction_legs, _refresh_prices, _refresh_live_fx, _refresh_splits, _refresh_benchmark, _refresh_intraday_day, _refresh_intraday_week, _warm_snapshots` | run in the scheduler thread after the server accepts traffic, not in startup |
Desktop-only globals: `_boot_state` (read_only, held_lock), `is_read_only()`, `release_writer_lock()`, `holds_writer_lock()`; `shutdown.py` (imports `nicegui` at module level) must not be imported by the server.

### `backend/tools/upload_db.py` (D2) must
1. Inputs: local plaintext `ledger.sqlite` + `config.sqlite` (OneDrive copies; read-only: copy first, never touch the live file), target host over Tailscale (`/c/Windows/System32/OpenSSH/ssh.exe`/`scp.exe` from Git Bash), passphrase from `INV_DASHBOARD_DB_PASSPHRASE` or `getpass` (reuse `tools/_passphrase.py: resolve_passphrase`; never argv).
2. `PRAGMA integrity_check` on the copy; refuse if not `ok`; make a sealed local backup (`storage/blob_crypto.encrypt_bytes`) of the original first.
3. Merge to the server layout: v5 split files have ledger + config tiers; server wants ledger==config in one file: copy config-tier tables (`AppConfig`, `InstrumentOverride`, `TargetAllocation*`) into the ledger copy (the ledger DB from v5 may already contain empty copies of all tables because Alembic migrates `ALL_METADATAS`; do `INSERT OR REPLACE` per table like `tools/split_db.py: _copy_tier`, inverted). Drop cache tables (rebuilt server-side) and prune unused instruments/accounts with zero transactions (plan section 5 Phase 2); do not drop instruments referenced by `InstrumentOverride`/allocations without confirming.
4. Run Alembic `upgrade head` against the copy (reuse `boot._run_alembic_upgrade` logic via `INV_DASHBOARD_LEDGER_PATH` env + `alembic.ini` from `backend/`), so v6 migrations (fx_conversions, auth) apply before upload.
5. Encrypt: SQLCipher export into a new file (see `_encrypt_inplace`), verify by reopening with the key + `integrity_check` + row-count manifest (`storage/backup.verify_backup`), compare counts with the plaintext source (transactions, accounts, instruments).
6. Upload: `scp` to a temp name in `/opt/investments/data/` (volume path on the server per RUNBOOK `/opt/investments`), checksum (sha256) both sides, then atomic `mv`; the app container must be stopped (or the upload is to a staging path followed by `docker compose stop app && mv && start`), because SQLite WAL files must not mix. Print the exact commands for the owner; the tool must not handle server credentials (AGENTS.md: owner does accounts/secrets), `--dry-run` default, `--yes` to execute, tests with a tmp plaintext DB (no network) for steps 2-5.
7. Post-check: owner runs `GET /api/health` and compares totals with the v5 app (parity gate).

### Compose / Litestream notes (D1)
- Container env (`backend/.env.example`): `INV_DASHBOARD_SERVER_MODE=true, SESSION_SECRET, DB_PASSPHRASE, ENCRYPT_SYNCED_TIERS=true, LEDGER_PATH, CONFIG_PATH, CACHE_PATH, LOG_DIR, FRONTEND_DIST, SCHEDULER_ENABLED=true, COOKIE_SECURE=true, WEBAUTHN_RP_ID/ORIGIN, TIINGO_TOKEN, HOST=0.0.0.0, PORT`, plus `TZ`; `Settings.host` default `0.0.0.0`, `port` 8080.
- Litestream replicates raw SQLite pages/WAL; to my knowledge it does not support SQLCipher-encrypted databases (header and pages are ciphertext). Verify in the restore drill early; if unsupported, back up with `backup_database` -> `blob_crypto` sealed snapshot to B2 on a schedule (hourly/daily) instead, and keep Litestream (if wanted) for the unencrypted cache only (pointless) or drop it.
- `alembic.ini` + `migrations/` must ship in the image (the wheel excludes them; `pyproject` `[tool.hatch.build.targets.wheel] packages=["src/investment_dashboard"]`).
- Healthcheck: `GET /api/health` (public).
- `bootstrap.sh` sets the host timezone to UTC (`timedatectl set-timezone Etc/UTC`); see the `date.today()` risk below.

---------------------------------------------------------------------------------------------------

## Cross-cutting risks

1. Tier layout: services call `app_config_repo.get(session)` and `allocations_repo.*` with whichever session the caller has. In a split-file layout a ledger session reads the ledger file's (Alembic-created) copy of `app_config`, while `api.deps.get_config_session` and `logging_service` use the config file: two diverging copies. Use `LEDGER_PATH == CONFIG_PATH` on the server (or always inject the same tier consistently) and test with `INV_DASHBOARD_CACHE_PATH` different.
2. `date.today()` is used in ~56 non-UI call sites (`services/`, `readmodels/`, `boot`); the server clock is UTC, the market is New York. Near midnight UTC "today" differs from the ET trading day (snapshots, daily growth, periods). Pass `as_of=market_hours.exchange_today()` explicitly in every API entry point and fix defaults where feasible (`metrics_service`, `snapshots_service`, `fx_service.get_rates` live overlay uses `date.today()`).
3. Module-level mutable state (process-local, thread-safe via locks except where noted): `fx_service._LIVE_SPOT` (no lock; single dict assignment), `provider_status`, `refresh_status`, `runtime_status`, `fetch_report`, `pull_log`, `intraday_snapshots_service._reconstruct_lock`, `db._engines_by_url/_factories_by_url/_engine_state` (NO lock: create engines once at startup, never lazily from concurrent first requests), `boot._boot_state/_large_pull_state`, `services/auto_publish` debounce. Run exactly ONE uvicorn worker; none of this (nor the import staging store, passkey challenges, rate limiter, live bus) survives multiple workers.
4. SQLite writer contention: request threads (GET handlers write caches: `snapshots_service.get_or_compute`, intraday reconstruction) and the scheduler thread write concurrently; engines set no `busy_timeout` (driver default ~5 s) and `synchronous=FULL` on durable tiers. Expect `database is locked` under load; set `PRAGMA busy_timeout`, keep write transactions short, and serialize scheduler writes with the refresh single-flight lock.
5. SQLCipher integration is untested and has dialect quirks (empty key pragma first, `SingletonThreadPool`, debug `print`); validate on Linux with `sqlcipher3-binary` before anything else in D1. `keyring` must never be consulted on the server (`server_mode` + env passphrase and `INV_DASHBOARD_TIINGO_TOKEN`).
6. Import-time hygiene: importing `readmodels`, `api.app`, `boot` does NOT import nicegui/keyring/plotly (checked: only pandas/yfinance load, ~3.7 s). Offenders to keep out of the server import graph: `shutdown.py` (module-level `from nicegui import Client, app`), `main.py`, `ui/*`, `services/loop_watchdog.install()` (lazy nicegui), `boot.py:35` imports `ui.theme` (light, but ties `boot` to the package that is deleted at cutover; plotly is imported lazily inside `register_plotly_template`).
7. Several tabs of logic live only in NiceGUI page modules and must be extracted before the API can serve them (overview FX panels, projection seed/params, rebalance assembly, transaction CRUD + settlement legs, import modal). Moving them also unblocks deleting `ui/`; keep behaviour identical and add regression tests from the existing `tests/ui/test_*_query.py` patterns.
8. Currency-rule violations found in current code, to fix or fence before exposing `ccy=USD`: analytics curve contributions/TWR use EUR `net_eur` for the USD bundle and `AnalyticsBundle.xirr` is always EUR; attribution is EUR-only; `benchmark_service` simulation is EUR-only; projection converts contribution inputs at spot (acceptable as an assumption, must be labelled); `allocation_treemap` and `calculator_query` are EUR-only.
9. `build_holding_cards` mixes per-position shares with per-instrument metrics: an instrument held in two accounts may be double counted. Verify on the real ledger (parity gate) before the Holdings endpoint ships.
10. Read endpoints have side effects and latency: `snapshots_service` writes cache rows on read; `week_series_with_fx`/`reconstruct_last_session` can fetch yfinance bars on first read; `compute_portfolio_metrics` walks the full ledger twice (cache per request, avoid calling it in both overview and analytics in the same request, consider a short TTL cache keyed by `(as_of, ledger_version)` invalidated on writes/ticks).
11. Blocking calls inside `async` code: `api.security.authenticate` and `deps.require_auth` are `async` and will touch the DB (B4); wrap with `run_in_threadpool` or make them sync. SSE generator must not run sync DB code on the loop.
12. Open-by-default API: `api/token_auth.require_token` allows everything when `api_token` is unset; the v6 `authenticate` must default-deny (the C1 stub does). `Settings.dev_password` (audit export gate) is also open when unset: require a session AND the dev password (or re-auth) for `/api/backup?kind=json`.
13. Secrets handling: `Settings.session_secret`, `db_passphrase`, `tiingo_token` live in env (`/opt/investments/.env`, mode 600); `redaction.py` + `support_bundle._config_summary` redact secrets; double-check that new settings (`session_secret`, `api_token`, `webauthn_*`) are covered by the redaction list and never logged by `configure_logging`.
14. Alembic discovery in the image: `_load_alembic_config` looks for `alembic.ini` relative to the package tree or CWD; a missing file makes boot fall back to `create_all` silently (skips data migrations and version stamping). Fail loudly in `server_mode`; CI should include the planned "upgrade v5 fixture to head and downgrade to 0014" test (migration ids: B5 `d2a6b4c8e1f0`, B4 `e3b7c5d9f2a1`; file numbers `0015`, `0016`).
15. Test debt: no hypothesis tests yet for `domain/currency.py`/`allocation.py` (AGENTS.md requires them for new money maths); `domain/fx_pool.py` must ship with property tests plus a hand-computed golden case (two EUR->USD batches, three deposits) before any wiring into metrics.
