# Backend unification audit (v6)

Scope: `backend/src/investment_dashboard/` excluding `api/` (new v6) and `ui/` (deleted at cutover).
Audit date 2026-11-01, branch `feat/v6-one-app`. Read-only; line numbers are as of this audit and will drift.
Rules referenced: AGENTS.md (currency rule, Decimal end to end, layering, cache tiers only through their service, pure domain).
Size: S under half a day, M about a day, L multi-day. Risk is the chance of changing money numbers or the golden-master/parity vectors.

In flux right now (other workers): `services/{auth_service,scheduler,live_bus,transaction_edit_service}.py`, `readmodels/fx_effect.py`,
`repositories/fx_conversion_repository.py`, `models/fx_conversion.py`, `models/auth.py`. Not audited beyond grep.

## Priority summary

| # | Theme | Pri | Risk | Size |
|---|-------|-----|------|------|
| 1 | Transaction cash-leg to currency conversion has 6 copies, 3 with a wrong EUR fallback | P0 | med | M |
| 2 | "Missing FX rate" has three different behaviours (None / pass EUR through / zero) | P0 | med | S |
| 3 | `date.today()` (server local) in about 70 non-UI sites vs `exchange_today()` in 5 | P0 | med | M |
| 4 | Contribution/withdrawal/distribution kind sets duplicated in 5 places | P1 | low | S |
| 5 | Readmodels and services issue ORM queries / use cache repos on the wrong session | P1 | med | M |
| 6 | Position / cost-basis aggregation exists twice (positions_service vs overview_query) | P1 | high | L |
| 7 | EUR-only readmodels/services (currency rule gaps for `ccy=USD`) | P1 | high | L |
| 8 | Money-market / NAV-asset-class detection duplicated and inconsistent (raw vs effective) | P1 | low | S |
| 9 | Display/format helpers duplicated; pct fraction vs percent naming | P2 | low | S |
| 10 | Floats in display payloads; rounding policy absent | P2 | low | S |
| 11 | Dict vs dataclass return shapes; error handling style | P2 | med | M |
| 12 | v5-only dead code to delete at cutover (and what v6 still needs) | P2 | low | M |
| 13 | Test gaps on core money maths (no hypothesis anywhere) | P0 | low | M |
| 14 | Upward imports (repositories/adapters -> services), import-time cycles | P2 | low | S |

---

## 1. Duplicated currency / cashflow logic

### 1.1 Cash-leg conversion helpers (P0)

Canonical today: `domain/currency.py` `dual_currency_amounts` (read) and `split_native_to_dual_legs` (write-time freeze).
Copies that re-implement it, with different fallbacks:

| Location | Behaviour | Problem |
|---|---|---|
| `services/metrics_service.py:193 _txn_eur_amount` | `net_eur` else `net_native` else 0 | For a USD-native row without `net_eur`, treats dollars as euros (the v2.3 bug that `period_query` already fixed) |
| `services/benchmark_service.py:178 _txn_eur_amount` | verbatim copy of the above | Same bug, plus drift risk |
| `services/metrics_service.py:208 _txn_usd_amount` | `net_usd`, else USD-native `net_native`, else EUR*rate, else 0 | Private, imported cross-module from `readmodels/mobile_export.py:307` and `readmodels/queries/period_query.py:668`; returns 0 (not None) on missing FX, which shrinks denominators |
| `readmodels/queries/period_query.py:155 _amount_eur`, `:196 _amount_in` | converts via forward-filled rate, returns `None` on gap | Correct, but a fourth variant; the `None` vs 0 semantics differ from metrics_service |
| `readmodels/queries/analytics_query.py:126 _contribution_amount`, `:157`, `:260` | EUR path: `net_eur` else `net_native`; USD path uses `dual_currency_amounts` | EUR fallback has the USD-as-EUR bug; `:157` and `:260` bypass the helper entirely |
| `readmodels/queries/overview_query.py:669 _convert_native` and `:753` | wrapper over `dual_currency_amounts`, coerces None to 0 | Fine, but another wrapper |
| `readmodels/queries/deposits_query.py:100-140`, `ledger_query.py:208-258` | each wraps `dual_currency_amounts` separately | 3 wrappers with own None handling |

Proposed single form: add `domain/currency.py: txn_amount(t_fields, ccy, eur_to_usd, *, missing="none") -> Decimal | None` (pure; takes plain values, not ORM rows) plus a thin
`services/cashflow_service.py` (new) with `txn_amount(t, ccy, rates)` that reads `t.account.native_currency`. All of `_txn_eur_amount`, `_txn_usd_amount`, `_amount_eur`, `_amount_in`,
`_contribution_amount`, `_convert_native` become calls to it. Missing-FX policy is an explicit argument, default `None` (skip), never silently 0 or EUR.
Risk: med (golden master `tests/services/test_metrics_golden_master.py` and `tests/parity` pin the EUR/USD numbers; the EUR-fallback fix changes results only for rows lacking `net_eur`, so run parity on the real ledger). Size: M.
Files: `domain/currency.py`, `services/metrics_service.py`, `services/benchmark_service.py`, `readmodels/queries/{period,analytics,overview,deposits,ledger}_query.py`, `readmodels/mobile_export.py`.
Note: v6 plan section 2 drops `net_eur`/`net_usd`; making all reads go through one function is the prerequisite (the function then switches to "native amount x rate at date / FX pool" in one place).

### 1.2 Cashflow stream builders (P1)

| Location | What |
|---|---|
| `services/metrics_service.py:237 build_instrument_cashflows`, `:275 build_portfolio_cashflows`, `:334 build_portfolio_cashflows_dual` | owner |
| `services/benchmark_service.py:215-300` | own contribution/withdrawal loop for the simulation (`_CONTRIBUTION_KINDS` copy at `:50`) |
| `readmodels/queries/period_query.py:660-704` | calls `build_portfolio_cashflows` twice (EUR then USD with `amount_fn`) instead of `_dual` |
| `readmodels/queries/analytics_query.py:152-160, 253-264` | own loop over `EXTERNAL_FLOW_KINDS` |
| `readmodels/queries/overview_query.py:709-870` | own per-instrument flow loop (`eur_flows`/`usd_flows`) next to `build_instrument_cashflows` |
| `readmodels/mobile_export.py:299 _portfolio_cashflows`, `:86 _paired_cashflows` | wrapper (v5 only, delete) |

Canonical: `services/metrics_service.build_portfolio_cashflows_dual` (move to a new `services/cashflows.py` owned by task R1). All XIRR/TWR call sites
(`metrics_service:509,511,556,559`; `overview_query:864,866`; `period_query:698,704,800`; `benchmark_service:257`; `analytics_query:376`) should receive streams from it.
Risk: med. Size: M (rides with 1.1).

### 1.3 Currency-rule violations (P1; see also section 7)

| Location | Violation | Verdict |
|---|---|---|
| `services/metrics_service.py:477, 552, 705, 852` | USD valuation = EUR value x spot | Allowed (single instant). Keep, but route through one `value_in(ccy, eur, rate)` |
| `readmodels/queries/overview_query.py:893, 909, 1229`, `period_query:690, 719`, `snapshots_service.py:93, 205`, `live_graphs.py:265` | same, valuation x rate | Allowed (single instant; snapshots are EUR pivot by v5 transition rule) |
| `readmodels/queries/projection_query.py:72-82` | `_display_value` / `_convert_to_usd` return the **EUR value as if it were USD** when the rate is missing | Violation (relabels EUR as USD); see 2 |
| `services/display_currency_service.py:79-86 convert_from_eur` | returns `amount_eur` unchanged when the rate is missing | Same |
| `readmodels/queries/analytics_query.py:431` | `xirr` taken from `PortfolioMetrics.xirr_usd` for USD but curve/TWR (`:157`, `:376`) built from EUR legs for the EUR path only: USD path now uses USD legs (good), attribution `:260-264` is EUR-only | Gap, not return conversion |
| `domain/currency_effect.py` | takes EUR and USD growth side by side | Fine (does not convert) |
| grep for `usd_return`, `growth * fx`: none found | no direct "convert a return" violations in non-UI code | OK |

---

## 2. Missing-FX behaviour is inconsistent (P0)

Same input (no rate on file) yields: `None` (`period_query.py:313 _display_value`, `_amount_eur`, `_amount_in`), EUR passed through as the foreign figure
(`projection_query.py:72-82`, `display_currency_service.py:79`), 0 (`metrics_service._txn_usd_amount`, `analytics_query._contribution_amount`),
or `Decimal(1)` (`period_query.py:524, 588`: `lookup_rate_with_forward_fill(...) or Decimal(1)`) which silently treats EUR as USD.
`overview_query.py:812, 818` use `... or today_rate` (silent substitution of today's rate for a start-of-period mark).

Canonical: one rule, in `domain/currency.py`: `convert_eur(amount, rate) -> Decimal | None` returning `None` when the rate is None/0; callers decide to omit/blank, never relabel.
Document that `0` is never a stand-in for "unknown" in cashflows (it biases XIRR little but biases Modified-Dietz denominators).
Risk: med (visible: today some pages show EUR figure labelled USD; after change they show blank). Size: S. Depends on 1.1.

---

## 3. Date / time

### 3.1 Server-local `date.today()` vs ET trading day (P0)

Counts of `date.today()` / naive clocks in non-UI, non-API code (grep, includes defaults inside `x or date.today()`):

| File | Count | Notes |
|---|---|---|
| `services/intraday_snapshots_service.py` | 16 (mostly `datetime.now(UTC)` which is fine; `date.today()` at `:629, :1726`) | `:629` FX lookup uses server date |
| `readmodels/queries/overview_query.py` | 10 | `date.today()` at `:214, 291, 331, 504, 708, 1146, 1341` (FX "today" lookups at `:291, 331, 504` ignore the `as_of` in scope) |
| `services/prices_service.py` | 9 | `:163, 278, 648, 842` |
| `services/fx_service.py` | 7 | `:164, 428, 675 (live overlay!), 744` |
| `services/snapshots_service.py` | 6 | `:54, 114, 165, 238, 280`: cache "is today live" decision |
| `boot.py` | 5 | `:124, 148, 313, 324, 999` |
| `readmodels/queries/projection_query.py` / `projection_model.py` | 5 | `:107, 151, 185, 207` / `:196` |
| `services/{metrics,positions,benchmark,display_currency,risk_free,transaction_fx}_service.py` | 2-3 each | `metrics_service:243, 398`; `positions_service:134, 358, 379` |
| `readmodels/queries/{deposits,period}_query.py`, `live_graphs.py` | 2, 1, 4 | `live_graphs.py:232` uses `datetime.now(UTC).date()` (UTC date, also wrong near midnight) |
| `readmodels/_serialize.py`, `storage/*` | 1 each | fine / v5 only |

Total about 70 sites. Already correct: `readmodels/_context.py` (`exchange_today`), `analytics_query.py:314`, `positions_service` partially, `publish_service` (v5).
Canonical: `domain/market_hours.py: exchange_today(now: datetime | None = None) -> date`. Add `services/clock.py` (`today_et()`, `utcnow()`), inject `as_of`/`now` from API entry points,
and make the defaults `as_of = as_of or exchange_today()`. Calendar-date-of-the-user concepts (`audit_export_service.py:39` filename, `boot.py` backfill windows, `projection_*` "this year")
may stay server-local but must say so; on the server TZ=UTC so "user local" is not available (use `timezone_service.now_in_user_tz` if wanted).
Risk: med (day boundary changes between 00:00 UTC and 04:00/05:00 ET only; golden masters use fixed `as_of` so mostly unaffected). Size: M (mechanical but wide). Must not overlap in-flight edits in `services/` (wait).

### 3.2 Naive vs aware datetimes (P1)

Convention actually used: DB columns are naive UTC (`DateTime` without tz in `models/{intraday_value,price_cache_metadata,position_snapshot,auth,transaction}.py`);
in-memory status objects are aware UTC. Mixed spellings of the conversion:
`datetime.now(UTC).replace(tzinfo=None)` (`prices_service.py:164, 232, 591, 649, 843`; `fx_service.py:221, 391`), `datetime.now(tz=UTC)`, naive `datetime.now()` (`storage/backup.py:133`, `storage/integrity.py:66`, `services/timezone_service.py:43`).
Canonical: `services/clock.py: utcnow_aware()` and `utcnow_naive()` (documented as DB-naive-UTC), `to_db(dt)`, `from_db(dt)` (attach UTC). Compare only after normalising. Risk: low. Size: S (after 3.1).

---

## 4. Decimal vs float / rounding

Float use is mostly legitimate and contained:
- `domain/returns.py` (xirr Newton/bisection `:51-160`, cagr `:227-252`, `:336`) and `domain/risk*.py` convert at the boundary and return `Decimal(repr(x))`. Acceptable; document as the only sanctioned float zone (scipy-style numeric solvers).
- `readmodels/queries/projection_model.py:125`, `projection_query.py:128`: compounding via float power then `Decimal(repr(...))`. Same pattern as `domain/returns.py`; move into `domain/returns.py: periodic_rate(annual, periods)` (S, low).
- Display payload floats (move to string-Decimal for v6 JSON): `overview_query.py:1349 _signed`, `:1354 _num`, `:1300`; `period_query.py:812-839 _f`. Canonical: `readmodels/_serialize.py: dec()` (strings). Risk low; ties to frontend contract (the React client formats, so strings are preferred). Size S.
- `overview_query.py:1292-1298` `Decimal(str(float_value))` round trips after floats were created at `:1349` (lossy).

Rounding/quantize (no policy): `overview_query.py:976 round_cent` (HALF_UP), `investing_power_service.py:40` (HALF_UP), `ledger_query.py:81` (`quantize` default HALF_EVEN), `mobile_export.py:74` (delete), `domain/allocation.py:352` (share rounding).
Plus formatting with `f"{x:,.2f}"` in `money_format.py`, `overview_query.py:1307`, `period_query.py:880-923` (Decimal `format` rounds ROUND_HALF_EVEN, so display rounding differs from the HALF_UP helpers).
Canonical: `domain/currency.py: round_money(amount, places=2)` with ROUND_HALF_UP, used only at the display boundary; formatting stays out of the API (client formats).
Risk: low. Size: S.

---

## 5. Layering and session / tier handling

### 5.1 ORM access outside repositories (P1)

| Location | What | Move to |
|---|---|---|
| `readmodels/queries/deposits_query.py:177, 252` | `select(Transaction)` | `transactions_repo.list_by_kinds(session, kinds, start, end)` |
| `readmodels/queries/ledger_query.py:72` | `select(Transaction)` with joins | `transactions_repo.list_with_relations(...)` |
| `readmodels/queries/period_query.py:381` | `session.scalars(select(Transaction).options(joinedload(...)))` | `transactions_repo.list_transactions(..., eager_account=True)` |
| `services/cache_janitor.py:33-48` | `select(Instrument.id)` on ledger, `select(model)`/`delete` on cache | `instruments_repo.list_ids`, `cache` repos (`prices_repo.delete_orphans`) |
| `services/database_reset_service.py:136` | `delete(model)` per table | `*_repo.delete_all` or a `repositories/maintenance_repo.py` |
| `services/instrument_enrichment_service.py:190, 231, 276` | `session.get(Instrument)`, `flush` | `instruments_repo.get`, `.save` |

Model imports for typing/enums (`Transaction`, `TransactionKind`) in `readmodels`/`services` (19 modules) are tolerated when annotating; but AGENTS.md says only repositories import ORM models.
Proposal: re-export `TransactionKind` and plain value types from `domain/kinds.py` (see 6.1); type rows as `Protocol`s or `TYPE_CHECKING` imports. Risk: low-med. Size: M.

### 5.2 Cache-tier data via the wrong session (P1)

Rule: cache data (prices, FX, snapshots, intraday) only through `prices_service`, `fx_service`, `snapshots_service`. Violations (repo used directly in a non-owner service):
- `services/metrics_service.py:946` `snapshots_repo.list_in_range(session, ...)` on a **ledger session** (wrong in split-DB; bypasses `cache_read_session`).
- `services/benchmark_service.py:154, 173` `prices_repo.*` (uses `cache_read_session` correctly but is a second price-access path; benchmark prices should come from `prices_service`).
- `services/transaction_fx_service.py:219, 228` `fx_repo.get_rates` (correct session, wrong owner; call `fx_service.get_rates`).
- `services/tiingo_fallback_wiring.py:173, 234-235` and `tiingo_fallback_runner.py:23` `prices_repo`/`price_cache_repo`/`tiingo_state_repo` (belongs inside `prices_service`).
- `services/intraday_snapshots_service.py` talks to `intraday_repo` (acceptable: it is the owner of intraday) but also reads `app_config_repo` (`:1049, 1112, 1468, 1474, 1611, 1628-1629`) for "already reconstructed" flags using the ledger session (config-tier data, see 5.3; and these flags are really cache-tier state).
- `repositories/instruments_repo.py:90` mentions cache price history (check for a join across tiers).
Canonical: a single `db.TierSessions` accessor (`sessions.ledger/config/cache`) passed into services, retiring `cache_read_session(fallback)` / `cache_write_session(fallback)` heuristics (`db.py:252-290`), which only exist because callers pass one session.
On the server (`LEDGER_PATH == CONFIG_PATH`, split cache) the heuristics are fragile: backend.md risk 1.
Risk: med. Size: M. Needs coordination with API workers (they construct sessions in `api/deps.py`).

### 5.3 Config-tier data via ledger session (P1)

All 20 `app_config_repo` callers (`display_currency_service`, `theme_service`, `clock_format_service`, `chart_prefs_service`, `investing_power_service`, `risk_free_service`, `benchmark_service`, `auto_refresh`, `logging_service`, `auto_publish`, `intraday_snapshots_service`, `live_graphs.py:156`) and `allocations_repo` (`mobile_export.py:379`, positions/readmodels) accept an arbitrary `session`.
`readmodels/_context.py build_context(session)` reads display currency via the same session it uses for ledger reads, so in a split layout it reads the ledger file's stale copy (backend.md risk 1).
Canonical: settings services take an explicit `config: Session`; `ReadModelContext` is built with `(ledger, config)`; fail the test-suite if split `LEDGER != CONFIG`. Interim: on the server pin all of ledger/config to one file and add a test. Risk: med. Size: M.

### 5.4 `session_scope` legacy (P2)

`db.session_scope()` (alias of `ledger_session_scope`, `db.py:240`) is still used in `boot.py` (27), `services/database_reset_service.py` (7), `intraday_snapshots_service.py` (4), `fx_service.py` (4), `auto_publish.py` (4), `auto_refresh.py` (3), `main.py` (4), `tools/*` (5), `support_bundle.py` (2), `logging_service.py` (2).
Of these, config reads under `session_scope` (`logging_service.py:101`, `auto_refresh.py:82`) are actually config-tier. Replace each with the explicit tier scope; delete `session_scope` after cutover. Risk low. Size S (boot.py is hot; do after v5 boot paths are removed).

### 5.5 Domain purity (OK, with notes)

`domain/` imports only stdlib plus `zoneinfo` (`market_hours.py:24`); no I/O. Run `mypy --strict` already in the gate. Nothing to fix. Note `domain/attribution.py` docstring references a service (fine).

---

## 6. Duplicate helpers

### 6.1 Transaction kind sets (P1)

| Set | Locations |
|---|---|
| contribution `{deposit, transfer_in}` / withdrawal `{withdrawal, transfer_out}` | `metrics_service.py:71-83` (canonical, exports `EXTERNAL_FLOW_KINDS`), `benchmark_service.py:50-57` (copy), `deposits_query.py:37` (`_DEPOSIT_KINDS` tuple) and 3 string-literal tuples (`deposits_query.py:152, 169, 264`), `period_query.py:446, 458` (literals), `repositories/fx_conversion_repository.py:16` (comment "mirrors") , `manual_entry.py:63 MONEY_MARKET_TRIGGER_KINDS` (same four) |
| distribution `{dividend_cash, interest}` | `metrics_service.py:86`; `period_query.py:423` literal `("dividend_cash","dividend_reinvest")` |
| share-moving | `positions_service.py:44 _SHARE_MOVING_KINDS` |
| sign-of-net, trade kinds | `manual_entry.py:26-60 NET_POSITIVE_KINDS/NET_NEGATIVE_KINDS/TRADE_KINDS` |
| string literals `"buy"`, `"sell"` | `ledger_query.py:165-166` |

Canonical: `domain/kinds.py` (new, pure) with `TransactionKind` re-exported (or mirrored as `StrEnum`), `CONTRIBUTION_KINDS`, `WITHDRAWAL_KINDS`, `EXTERNAL_FLOW_KINDS`, `DISTRIBUTION_KINDS`, `SHARE_MOVING_KINDS`, `NET_POSITIVE/NEGATIVE`, `TRADE_KINDS`. Everything imports from there. Risk low. Size S.

### 6.2 Dividend classification (P1)

`domain/dividends.py` (`reinvest_keys`, `income_dual`, `income_value_native`) is canonical and used by `metrics_service:427-438` and `period_query:414-428`.
Hand-rolled copies: `overview_query.py:730-733` (key `(instrument_id, date)`) and `positions_service.py:148-150, 213` (key `(account_id, instrument_id, date)`) with **different key shapes** (the metrics key ignores account, positions includes it). Pick the `(account_id, instrument_id, date)` key in `domain/dividends.reinvest_keys` and migrate. Risk med (a same-day reinvest across two accounts changes dividend income). Size S.

### 6.3 FX rate lookup / loading (P1)

- `fx_service.get_rates` loads the **entire** EUR/USD series on every call (called about 20 times across `overview_query:512, 710`, `period_query:392`, `deposits_query:185, 257`, `ledger_query:120`, `benchmark_service:228, 297`, `mobile_export:304, 338`, plus `get_rate_eur_to_quote` which calls it again each time, e.g. `overview_query:291, 331, 504`).
  Canonical: `fx_service.FxSeries` (loaded once per request/context, with `.rate_on(date)` forward-fill and the live overlay) stored on `ReadModelContext`. Lookup via `domain.currency.lookup_rate_with_forward_fill` stays the only forward-fill (also reimplemented in `metrics_service.py:670 _fx_mark_date`, `positions_service.py:266 _eur_rate_for`, `snapshots_service` variants).
- Live overlay `fx_service.py:675` uses `date.today()`; see 3.1. `_LIVE_SPOT` global is unlocked (backend.md risk 3).
- Display conversions: 5 near-identical `value x rate`/blank helpers: `period_query:313 _display_value` + `:321 _convert_to_usd`, `projection_query:72, 78`, `display_currency_service:79 convert_from_eur`, `snapshots_service:93`, `live_graphs:265`. Canonical: `domain/currency.convert_eur` (see 2).
Risk: low-med. Size: M.

### 6.4 Formatting (P2)

`readmodels/money_format.py` (`fmt_money`, `fmt_pct`, `fmt_shares`) vs private copies `ledger_query.py:61 _fmt_money`, `overview_query.py:1304 _fmt_pct`, `:1310 _fmt_asof`, `period_query.py:52, 880-923` (JS formatter strings + Python `* Decimal(100)`), `daily_growth_view.py:118 _format_fx_tight`, `services/clock_format_service.format_clock`.
v6 stance: server returns raw Decimal strings (`_serialize.dec`), client formats. Canonical: keep `money_format.py` only for audit export/CSV; delete the rest with `ui/`. Size S.

### 6.5 Position and cost-basis aggregation (P1)

- `services/positions_service.compute_positions` (shares, cost basis native, effective instrument, money-market reinvest exclusion at `:168`) is the position source.
- `readmodels/queries/overview_query.py:709-930 compute_instrument_metrics` re-walks all transactions with its own running `cost_eur/cost_usd/shares_held` (12 uses), average-cost sell logic, money-market reinvest exclusion (`:740`), split handling, YTD/MTD invested.
- `readmodels/mobile_export.py:181-300` another aggregation (v5, delete).
- `metrics_service` and `benchmark_service` each hold their own transaction walks.
Backend.md risk 9 (double counting per-instrument across accounts) stems from this.
Canonical: one `services/ledger_walk.py` (single pass producing per-(account, instrument) lots with native cost, plus per-instrument dual-currency flows) that `compute_positions`, `compute_instrument_metrics` and `metrics_service` all consume. Risk high (parity vectors, `tests/parity`); do last. Size L.

### 6.6 Money-market and NAV/synthetic asset-class detection (P1)

`domain/money_market.is_money_market(symbol, *, asset_class, name)` is canonical, but callers differ: some pass the **effective** (override-aware) name/asset class
(`positions_service:168, 288`, `overview_query:740, 926, 1420`, `intraday_snapshots_service:281`, `mobile_export:133`), others pass raw instrument fields
(`metrics_service.py:329`, `live_graphs.py:383`), so an override-marked money-market fund is retained/excluded differently by feature.
Asset-class sets: `prices_service.py:63, 67` (`_SYNTHETIC_ASSET_CLASSES={cash,savings}`, `_NAV_ASSET_CLASSES={mutual_fund}`), `intraday_snapshots_service.py:214` (`{mutual_fund,cash,savings}`), `tiingo_fallback_wiring.py:40`, `diagnostics_service.py:61, 128` (private `prices_service._SYNTHETIC_ASSET_CLASSES`), `mobile_export.py:53` (adds `money_market`, `money-market`), `metrics_service.py:84 _RETAINED_CASH_ACCOUNT_TYPES`.
Canonical: `domain/instruments.py` (new): `is_nav_priced(asset_class)`, `is_synthetic(asset_class)`, `is_money_market(...)` taking an `EffectiveInstrument`-like value; one place applies overrides. Risk low-med. Size S.

---

## 7. EUR-only paths (currency rule gaps, P1)

From backend.md risk 8, re-verified:
- `services/benchmark_service.py:215-330`: simulation funded with EUR legs only (`_txn_eur_amount`, `close_usd / rate` at `:237, 309, 329`); `simulate_benchmark_xirr` EUR-only. Needs a `ccy` argument and USD stream.
- `readmodels/queries/overview_query.py allocation_treemap` EUR-only (`value_eur`), `calculator_query.py:63, 87, 140` EUR-only (`total_value_eur`, `native_price / fx`).
- `readmodels/queries/analytics_query.py:260-264` attribution EUR-only; `domain/attribution.py` EUR amounts.
- `readmodels/queries/projection_query.py` converts EUR inputs at spot (acceptable, but must be labelled; plus the missing-FX relabel in 2).
- Return-field naming (see 8) makes `ccy` selection manual: `PortfolioMetrics` has `xirr`/`xirr_usd` rather than `xirr_eur`.
Canonical: every readmodel takes `ccy: str` and picks leg through one `pick(ccy, eur, usd)`; later the "native+FX pool" computation from plan section 2 replaces the dual legs. Risk high. Size L (gate on parity).

---

## 8. Naming / shape inconsistencies

### 8.1 Suffix conventions (P2)

- EUR is unsuffixed in some places and `_eur` in others: `PortfolioMetrics.xirr` (EUR) vs `xirr_usd`; `ytd_growth_pct` vs `ytd_growth_pct_usd`; `mtd_growth_pct`/`_usd`; `daily_growth_pct`/`_usd`; `total_growth_compounded_eur`/`_usd`; `total_dividends_cash_eur` holds income (name says cash).
  Canonical for v6 DTOs: always explicit `_eur`/`_usd` or a `{ccy: value}` map; rename in readmodels only (`api/schemas` already wraps), keep dataclass names until R6.
- Rate direction: everywhere "quote per 1 EUR" (good) but `calculator_query.py:87 fx_rate_usd_per_eur` and `daily_growth_view.py:91 _display_rate` invert; keep one name `eur_to_usd`.

### 8.2 `*_pct` is a fraction in most places, a percent in others (P1, easy to break)

Fraction (0.1234): `fmt_pct` (`money_format.py:67`), `total_growth_pct`, `ytd_growth_pct`, `mtd_growth_pct`, `daily_growth_pct`, `dividend_yield_pct`, `rate_change_pct`.
Percent (12.34): `domain/allocation.py` `*_weights_pct` (`target_weights_pct`, `current_weights_pct`, `category_weights_pct`, `HUNDRED` at `:19`, `:40`, `:329`), `calculator_query.py:140 cat_pct`, `daily_growth_view.py:114 fx_move_pct`, `risk_free_service.py:156 raw/100 if raw>1` (heuristic).
Canonical: suffix `_pct` = fraction in 0..1? Pick: **`_ratio` / no suffix for fraction, `_pct` strictly 0..100**; rename `*_growth_pct` to `*_growth` (the period tables already use `yearly_growth_eur`). Risk med (needs matching frontend contract). Size M. Do in the same wave as the API DTO freeze.

### 8.3 Return shapes (P2)

62 public functions in `readmodels/` return `dict`/`list[dict]` (`mobile_export.py` 12, `live_graphs.py` 10, `analytics.py` 6, `calculator.py` 4, `periods.py` 4, `deposits.py` 3, `overview.py` 3) while `services/` and `queries/` return frozen dataclasses (`PortfolioMetrics`, `Position`, `HoldingCard`, ...).
Canonical: queries return frozen dataclasses; `readmodels/<x>.py` stays the dict shaper only for v5 UI/export; for v6 `api/` maps dataclass -> pydantic. Do not add new dict-returning readmodels. Size M (touches api mapping; wait).
Optional handling: `None` means unknown in readmodels (`Decimal | None`), but `0`/`ZERO` is the sentinel in cashflow builders (see 1.1). Normalise per 2.

### 8.4 Error handling (P2)

Mixed: `ValueError` for invalid input in setters (`theme_service`, `clock_format_service`, `display_currency_service`, `risk_free_service`, `timezone_service`, `onboarding_service`, `importer_service`, `benchmark_service`, `prices_service`, `fx_service`; 1 each); `None` for "no data" in fetchers; bare `except Exception` swallowing in `intraday_snapshots_service.py` (8), `fx_service.py` (6), `auto_publish.py` (4), `prices_service.py` (3).
`transaction_edit_service.py` (new, 9 raises) and `publish_service.py` (14 raises) use custom errors. Canonical: `errors.py` with `ValidationError`, `NotFoundError`, `ConflictError`, `UpstreamError`; services raise these; API maps to 4xx/5xx; "no data" stays `None`. Log-and-continue allowed only in scheduler loops, and must log with `log.exception`. Size M.

### 8.5 Logging (P2)

Consistent enough: `log = logging.getLogger(__name__)` (24 modules), no f-string logging, no `print` outside `tools/` and `db`/sqlcipher debug (backend.md risk 5). `adapters/{tiingo,yfinance}_client` import `services.provider_status`/`pull_log` lazily (see 14). Nothing to unify besides adding structured fields for the scheduler; skip.

---

## 9. Dead / v5-only code (delete at cutover)

| Group | Files | Who else depends |
|---|---|---|
| NiceGUI UI | `ui/**`, `main.py` (209), `shutdown.py` (202), `services/loop_watchdog.py` (186) | `boot.py:35` imports `ui.theme.register_plotly_template` (remove first); `readmodels/queries/*` docstrings mention ui; `tests/ui/*` actually test `readmodels/queries/*` (36 files): **move to `tests/readmodels/` before deleting `ui/`** |
| Publish / web companion | `services/publish_service.py` (476), `services/auto_publish.py` (241), `readmodels/mobile_export.py` (508), `storage/blob_crypto.py`, `tools/publish_web.py`, `tools/export_snapshot.py`, `readmodels/snapshot.py` (check), `redaction.py` use in publish | `readmodels/__init__.py` re-exports `build_mobile_export`/`build_snapshot`; `services/audit_export_service.py:24` imports `build_snapshot` (v6 `/api/backup?kind=json` may still need an audit export: keep `audit_export_service` + `readmodels/snapshot.py`, drop mobile shape); `shutdown.py` imports `auto_publish` |
| Desktop storage layer | `storage/{cloud,sidecar,move,lock,paths,backup,integrity,atomic_io}.py`, `tools/{repair_sidecar,split_db,backup}.py`, `boot.py` cloud/sidecar/lock paths (`_check_sidecars`, `_resolve_paths`, lock) | `db.py:31-36` imports `storage.encryption` and `storage.sidecar.should_use_truncate_journal` (replace with SQLCipher pragmas / WAL on server); `prices_service.py` imports `storage.encryption` for token (replace by settings) |
| Keyring | `prices_service.py:36-43 load_tiingo_token_from_keyring`, `storage/encryption.py` keyring paths, `config.py` keyring comments/flags | v6 must read `INV_DASHBOARD_TIINGO_TOKEN` from env only |
| Desktop-only services | `services/{theme,clock_format,chart_prefs,daily_growth_view,onboarding,price_probe,ticker_validation,support_bundle,error_reporting,timezone}_service.py` (timezone_service may still be wanted for per-user display tz) | `onboarding_service` seeds sample instruments; `ticker_validation_service` is used by manual-entry in v6; decide per item |
| Settings glue | `tools/set_password.py`, `tools/upload_db.py` (stubs, keep until D1), `services/server_runtime.py` (used by `api/app.py`: keep) | |

v6 still depends on (do NOT delete): `services/{metrics,positions,prices,fx,snapshots,intraday_snapshots,benchmark,risk_free,display_currency,investing_power,transaction_fx,importer,manual_entry,instrument_enrichment,diagnostics,auto_refresh,cache_janitor,database_reset,logging,provider_status,refresh_status,runtime_status,fetch_report,pull_log,tiingo_fallback*,audit_export,server_runtime}`,
`adapters/**`, `repositories/**`, `domain/**`, `readmodels/{_context,_serialize,money_format,live_graphs,deposits,analytics,calculator,overview,periods,transactions,fx_effect}.py` + `queries/**`, `boot.py` (after trimming), `db.py`, `config.py`, `logging.py`, `redaction.py`.
Deletion size: M; risk low once tests are moved. Wait for API workers (they may import some of these) and for owner approval of cutover.

---

## 10. Test gaps for core money maths

- **No `hypothesis` tests anywhere** (`grep` over `tests/`), although AGENTS.md requires them for new money maths. Candidates and properties:
  `domain/currency.py` (`split_native_to_dual_legs`/`dual_currency_amounts` round trip, `lookup_rate_with_forward_fill` monotone, `native_to_eur`/`eur_to_native` inverse), `domain/allocation.py` (weights sum to 100, rebalance conserves total), `domain/returns.py` (xirr of a zero-gain stream is 0; scale invariance in amount; sign flip), `domain/dividends.py`, `domain/fx_pool.py` (when it lands: FIFO pool conservation).
- Thin: `tests/domain/test_currency.py` 55 lines, `test_attribution.py` 72, `test_currency_effect.py` 82, `test_dividends.py` 100; **no test for `domain/money_market.py`**.
- Query modules are tested only under `tests/ui/` (`test_period_query*.py`, `test_overview_query.py`, `test_deposits_query.py`, `test_ledger_query.py`, `test_analytics_query.py`, `test_projection_*.py`, `test_calculator_query.py`): wrong location, and `analytics_query` and `deposits_query`/`ledger_query` have a single test file each (USD/EUR parity of `_contribution_amount` is covered only by `test_analytics_attribution_currency.py`).
- No dedicated test of `metrics_service.build_portfolio_cashflows_dual` equivalence with two single-stream calls, nor of the 6 duplicated `_txn_*` helpers agreeing (add a table test before 1.1).
- No test that `snapshots_service`/`metrics_service` give equal results with split vs single DB for `snapshots_repo` (`metrics_service.py:946`); `tests/services/test_split_db_valuation.py` exists but not for this call.
- No test for the ET/UTC day-boundary (freeze at 2026-03-02T01:30Z, assert `as_of` defaults); add with 3.1.
- Golden masters exist: `tests/services/test_metrics_golden_master.py`, `tests/parity/{vectors.json,test_vectors_fresh.py}`: keep green through every task below; they are the safety net.

---

## 14. Upward imports (P2, S)

- `repositories/tiingo_state_repo.py:20` imports `services.tiingo_fallback` (dataclass `TiingoDesktopState`): move that dataclass to `domain/` or `adapters/importer_types`-style neutral module.
- `adapters/tiingo_client.py:97`, `adapters/yfinance_client.py:48`, `adapters/_retry.py:130` lazily import `services.provider_status` / `services.pull_log`: replace with an injected `on_event` hook (or move the two tiny registries to `adapters/`).
- Local-import cycle workarounds (`# noqa: PLC0415`): 54 in `boot.py`, 19-20 each in `fx_service`, `prices_service`, `intraday_snapshots_service`; `period_query.py` imports `metrics_service` lazily to avoid a cycle. Resolves itself with 1.1 (`cashflows.py`) and 6.3.
- `services/diagnostics_service.py:128` uses private `prices_service._SYNTHETIC_ASSET_CLASSES`; `mobile_export` and `period_query` use private `metrics_service._txn_usd_amount`. Fixed by 1.1 and 6.6.
- Import-time hygiene for the server (backend.md risk 6): `boot.py:35` imports `ui.theme`; `shutdown.py` and `main.py` import nicegui; `readmodels/__init__.py` imports `mobile_export`.

---

## Proposed refactor sequence

Waves are ordered; tasks inside a wave have disjoint file lists and can run in parallel. "Wait" means the file list intersects what the v6 API workers are editing (`api/`, `services/{auth_service,scheduler,live_bus,transaction_edit_service}.py`, `readmodels/fx_effect.py`, `repositories/fx_conversion_repository.py`) or depends on their DTOs.

### Wave 1 (start now; pure/new files plus leaf edits; no API dependency)

| Task | Content | Own files | Size |
|---|---|---|---|
| R0 tests first | Move `tests/ui/test_*_query.py`, `test_projection_*`, `test_calculator_*`, `test_deposits_query`, `test_ledger_query`, `test_period_query*`, `test_overview_*query`, `test_analytics_*` to `tests/readmodels/`; add hypothesis to dev deps; property tests for `domain/{currency,returns,allocation,dividends}`; new `tests/domain/test_money_market.py`; table test that the six `_txn_*` helpers agree on a fixture ledger (xfail where known wrong) | `backend/tests/**` only (+ `pyproject.toml` dev-dep) | M |
| R1 kinds + instrument classes | New `domain/kinds.py`, `domain/instruments.py` (6.1, 6.6); replace local sets and literal tuples; make all `is_money_market` callers pass effective fields | `domain/kinds.py`, `domain/instruments.py`, `domain/money_market.py`, `services/manual_entry.py`, `services/positions_service.py`, `services/benchmark_service.py` (kind sets only), `readmodels/queries/deposits_query.py`, `readmodels/queries/ledger_query.py`, `services/diagnostics_service.py`, `services/tiingo_fallback_wiring.py`, `readmodels/live_graphs.py` | S |

### Wave 2 (after R0 merged; touches services and readmodels; coordinate with API workers: wait for them to finish or confine to listed files)

| Task | Content | Own files | Size |
|---|---|---|---|
| R2 cashflow/currency core (items 1.1, 1.2, 2, 6.2) | `domain/currency.py: txn_amount, convert_eur, round_money`; new `services/cashflows.py` (move builders from `metrics_service`); one missing-FX policy; fix EUR fallback bug; dividend key unification. WAIT for API workers: touches `metrics_service.py` and `period_query.py` which API endpoints import | `domain/currency.py`, `domain/dividends.py`, `services/cashflows.py` (new), `services/metrics_service.py`, `services/benchmark_service.py`, `readmodels/queries/period_query.py`, `readmodels/queries/analytics_query.py`, `readmodels/queries/projection_query.py`, `services/display_currency_service.py` | M |
| R3 clock (items 3.1, 3.2) | `services/clock.py`; replace `date.today()`/naive clock defaults; add day-boundary tests. WAIT: `services/` files are being edited by API workers | `services/{fx,prices,snapshots,intraday_snapshots,positions,transaction_fx,risk_free}_service.py`, `readmodels/queries/{overview,projection,deposits}_query.py`, `readmodels/queries/projection_model.py`, `readmodels/live_graphs.py`, `boot.py` | M |

R2 and R3 both touch `readmodels/queries`; split as listed (R2: period, analytics, projection_query; R3: overview, projection_model, deposits). `projection_query.py` is owned by R2 only; R3 must not edit it (its `date.today()` sites at `:107, 151, 185, 207` are done by R2).
`deposits_query.py` is touched by R1 (kinds) in Wave 1 and R3 in Wave 2: sequential, no overlap.
`services/benchmark_service.py` R1 (wave 1) then R2 (wave 2): sequential.

### Wave 3 (after Wave 2; layering and tiers)

| Task | Content | Own files | Size |
|---|---|---|---|
| R4 layering + tiers (5.1-5.4, 14) | Move ORM selects behind repositories; `TierSessions`; settings services take explicit config session; `FxSeries` once per context; retire `cache_read_session` fallback heuristics; fix `metrics_service.py:946` snapshot read; move `TiingoDesktopState`; injected adapter hooks. WAIT for API workers (changes `api/deps.py` contract: coordinate) | `repositories/*`, `db.py`, `services/cache_janitor.py`, `services/database_reset_service.py`, `services/instrument_enrichment_service.py`, `services/fx_service.py` (FxSeries only), `readmodels/_context.py`, `adapters/{tiingo,yfinance}_client.py`, `adapters/_retry.py`, `services/{provider_status,pull_log}.py`, `services/tiingo_fallback*.py` | M-L |
| R5 shapes and naming (8.1-8.4, 4 floats) | Rename `*_pct` fractions, `_eur/_usd` suffixes, errors module, drop float display helpers; dataclass returns. WAIT: must follow the API DTO freeze and the frontend contract | `readmodels/queries/overview_query.py` (float helpers, naming), `readmodels/_serialize.py`, `errors.py` (new), `services/{theme,clock_format,...}` setters | M |

### Wave 4 (last; high risk; owner-gated)

| Task | Content | Own files | Size |
|---|---|---|---|
| R6 single ledger walk (6.5, 7) | `services/ledger_walk.py`; `compute_positions`, `compute_instrument_metrics`, benchmark and USD/EUR sleeves consume it; `ccy` arg on benchmark/treemap/calculator/attribution; parity gate on the real ledger before merge | `services/positions_service.py`, `readmodels/queries/overview_query.py`, `services/benchmark_service.py`, `readmodels/queries/calculator_query.py`, `domain/attribution.py`, `readmodels/queries/analytics_query.py` | L |
| R7 cutover deletion (section 9) | Delete `ui/`, `main.py`, `shutdown.py`, publish/mobile_export/storage desktop layer, keyring, `tools/` v5 scripts; trim `boot.py`; drop `session_scope`. Only after owner approves cutover and R0 moved the tests. WAIT for API workers and Phase 4 | everything listed in section 9 | M |

Notes: R2 depends on R0's characterization tests; R6 depends on R2 + R4. R1 and R0 can start immediately and in parallel (no shared files except R1 not touching `tests/`).
