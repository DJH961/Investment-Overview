# v7.0 plan — **PARTIAL DRAFT**

> **Status: INCOMPLETE in two specific places. Usable everywhere else.**
> Written 2026-11-05 against v6.6.0. The planning exercise was disrupted by
> model rate limits and then cut short; every agent was asked to hand back
> early. Most workstreams reported usefully. Every section is marked ✅
> **researched**, ⚠️ **partial**, or ❌ **NOT INVESTIGATED**.
>
> **The two real holes are:**
> 1. **No page-by-page critique of the existing UI exists** (§4) — nobody
>    assessed whether your current pages are good, thin or redundant.
> 2. **Design language is entirely unresearched** — no screenshot of any
>    competitor was viewed, so layout, density, typography, empty states and
>    mobile interaction patterns are unanswered (§5.4e). Six competitors were
>    verified on *features* (§5.4f, §5.4h), but **Portfolio Performance,
>    Ghostfolio and Wealthfolio — the self-hosted peers closest to this app —
>    were never touched.**
>
> A third, narrower hole: **all OpenRouter API facts are unverified** (§5.3i).

---

## 0. How this document was produced, and what is missing

The plan was meant to combine five parallel investigations:

| # | Investigation | Status | In this doc |
|---|---|---|---|
| 1 | Currency page + expanded holding deep-dive | ⚠️ Deep-dive **current state fully mapped** by a surviving child agent; Currency page not started; no design proposals | §5.1 |
| 2 | "What happened since I last logged in" briefing | ✅ **Complete and buildable** | §5.2 |
| 3 | LLM performance summaries + News tab (OpenRouter) | ⚠️ **Privacy/payload design done and valuable**; News design and **all OpenRouter web research** missing | §5.3 |
| 4 | Page-by-page / component-by-component internal audit | ⚠️ Parent agent died; only its debt-focused child survived | §3 (debt) ✅, §4 (page critique) ❌ |
| 5 | Best-in-class benchmark vs other trackers and brokers | ⚠️ Repo-grounded gap analysis ✅; **six competitors verified with sources** (§5.4f, §5.4h); Portfolio Performance / Ghostfolio / all brokers / all UX comparators unresearched, **no design language at all** | §2, §5.4 |

**Why it failed:** five concurrent Opus subagents exceeded the `claude-opus-5`
rate limit in the Sweden Central region (HTTP 429), and several agents stalled
with no stream progress for 600 s. Two were relaunched with no-fan-out
instructions but spawned children anyway and were stopped before finishing.

**What this means:** the four *feature* workstreams came back well enough to
act on — one of them (§5.2) is ready to build. What is missing is the
**evaluative** half of the request: nobody judged the existing pages, and
nobody verified what competing products actually do. So this document is
strong on "what to add" and silent on "what to fix or throw away".

### Resuming this work

Run investigations **at most two at a time**, on Opus, each with an explicit
"do not spawn subagents" instruction and a tool-call budget. Two briefs remain
outstanding: the page-by-page UI audit (§4) and the OpenRouter API research
(§5.3i). The competitor benchmark has been resumed separately.

---

## 1. ✅ Where the app stands today (verified)

Version **6.6.0**, live, clean `main` at commit `500eedf1`. v6 shipped
2026-11-03; the v5 NiceGUI desktop app and `web/` companion are still present
on `main` pending the owner-approved clean-up release.

**Frontend** — React 19 + TS + Vite, `frontend/src/`:

- **18 pages:** Overview, Holdings, Allocations, Risk, Periods, Projection,
  Transactions, CurrencyConversions, Instruments, Import, Activity,
  Diagnostics, Settings, Help, Onboarding, Login, Styleguide, NotFound.
- **48 components**, including a chart family of `Chart`, `Sparkline`,
  `Treemap`, `DivergingBar`, `GrowthBars`, `HeroIntraday`, `ValueChartCard`.

**Backend** — FastAPI, `backend/src/investment_dashboard/`:

- 26 API routers, ~55 services, 20 readmodels, 14 domain modules.
- Domain covers `returns`, `risk`, `risk_extras`, `attribution`, `allocation`,
  `dividends`, `money_market`, `currency_effect`, `fx_pool`, `session_fx`,
  `market_hours`.

> ⚠️ This is a structural inventory only. **No judgement has been formed about
> whether any page is good, thin, redundant or well-designed** — that was
> investigation 4, which did not report.

---

## 2. ⚠️ Backend capability, and the one constraint that shapes all of v7

### 2.1 🚩 THE BINDING CONSTRAINT: the instrument master is nearly empty

This is the most important finding of the whole exercise.

`models/instrument.py` holds exactly: `id`, `symbol`, `name`, `asset_class`,
`native_currency`, `expense_ratio`. `models/instrument_override.py` adds
`category`, `active`, `name_override`, `asset_class_override`,
`expense_ratio_override`, `provider_symbol`, `pricing_mode`.

There is **no ISIN, no WKN, no sector, no industry, no country or region, no
fund domicile (IE/US/LU), no accumulating-vs-distributing flag, no
fund-vs-single-stock type, no market cap, no exchange.**

Consequently **every** allocation or diversification view beyond "asset class"
and "user-typed category" is currently impossible, and so is almost all German
tax logic. A large share of the attractive v7 ideas are blocked behind one
unglamorous piece of work: **enriching the instrument master**. Plan it first
or plan around it.

### 2.2 Tables that do not exist — feature areas with zero foundation

**lots / cost basis**, **corporate actions** (only `price_split` exists, which
is a price-adjustment record, not a holdings-affecting action), **tax**,
**watchlist**, **notes/journal**, **alerts**, **goals**, **news**, **saved
views**, **annotations**.

Existing tables: accounts, app_config(+audit), auth (credentials/passkeys/
sessions), fx_conversions, fx_history, import_batches, instruments,
instrument_overrides, intraday_value, position_snapshots,
price_cache_metadata, price_history, price_split, target_allocations(+items),
transactions.

> This independently confirms the lots risk flagged in §5.1b: **there is no lot
> table.** Lots are a new-table project, not a UI project.

`models/transaction.py` does capture `fees_native` per transaction — so a Fees
view is nearly free — but has **no tax-withheld field**, so net-of-Quellensteuer
dividend analysis needs a schema change.

### 2.3 Computed capability that is under-exposed in the UI

The domain layer is genuinely deeper than typical consumer trackers:

- `returns.py` — XIRR, TWR, CAGR, annualise, total growth, windowed growth.
- `risk.py` — annualised volatility, Sharpe, Sortino, max drawdown, best/worst
  month, monthly win rate, beta, alpha.
- `risk_extras.py` — Calmar, Ulcer index, historical VaR, historical CVaR,
  skewness, excess kurtosis.
- `attribution.py` — **per-instrument contribution to portfolio return.**
- `currency_effect.py` + `readmodels/fx_effect.py` — **EUR/USD currency-effect
  split**, a real differentiator most consumer tools lack.
- `allocation.py` — current weights, category→instrument expansion, and a
  rebalance planner with buy-only and with-sells modes plus overspend trimming.

**Two cheap wins stand out:** surfacing `attribution.py` prominently (if it is
not already — ⚠️ unverified whether any page shows it) and promoting the
currency-effect split to a first-class KPI rather than a sub-page.

### 2.4 Other verified gaps

- **The importer is US-locale only.** `docs/user_guide.md` states it expects
  `MM/DD/YYYY`, `.` decimal and `,` thousands, and *skips* EU-locale values.
  Adapters exist for `fidelity/`, `vanguard/`, `generic/`, `tabular/` — a
  US-broker-shaped pipeline. If any German broker export ever needs importing,
  this is a hard blocker.
- **`/` → search is a half-made promise.** `docs/v6_frontend_design.md`
  specifies keyboard shortcuts including `/` focusing `[data-search]`, but
  there is no search surface in `pages/`.
- **No dividends, benchmark or reports router** exists in `api/`.

---

## 3. ✅ Debt, cleanup and v5 leftovers (researched)

The only investigation that completed. Source: debt-audit subagent, 2026-11-05.

### 3.1 The codebase is unusually clean

No FIXME or HACK anywhere in `backend/src`, `frontend/src`, `deploy` or `docs`.
No `NotImplementedError`, no commented-out blocks, no feature-flag cruft, no
stub endpoints. Import-linter has **no `ignore_imports` exemptions**, so no
tolerated layering violations are hiding. Dependencies are all
current-generation (FastAPI ≥0.110, SQLAlchemy ≥2.0.30, Pydantic ≥2.7,
React 19.3.1, TanStack Query 5.105, TS 5.9.3, Vite 8.3.5). `[Unreleased]` is
empty — the release-fast policy is being followed.

### 3.2 ⚠️ Correction needed to AGENTS.md: the frozen currency legs are load-bearing

`AGENTS.md` describes `net_eur` / `net_usd` / `fx_rate_to_eur` as "only a
cross-check". That is **wrong in practice**:

- `readmodels/queries/ledger_query.py` builds the transaction-list display
  directly from `t.net_eur` / `t.net_usd` (22 hits, e.g. lines 292-296,
  313-314, 341-342);
- `api/schemas/transactions.py` exposes them as primary response fields
  (4 hits).

Dropping these columns at cutover is **not** a mechanical deletion. It requires
reworking dual-currency transaction display to derive from native amounts plus
that date's rate, with an Alembic migration carrying a working downgrade to
`0014`. **Action: fix the framing in AGENTS.md before anyone plans this as a
cheap cleanup.**

### 3.3 Live bug — the 404 page tells users it is a placeholder

`frontend/src/pages/NotFound/NotFound.tsx:12-13` is the catch-all `path="*"`
route (`App.tsx:64`) and still renders `title="Coming soon"` with "This page is
a placeholder and will be filled in by a later step of the v6 build". Anyone
hitting a bad URL sees it. **~5 minute fix, ship as a patch.**

### 3.4 Test coverage

Frontend: 62 test files, no coverage tool installed (`@vitest/coverage-v8`
absent), one Playwright spec (`frontend/e2e/smoke.spec.ts`, 52 lines).

- **25 of 46 components (54%) have no direct test**, including the primitives
  everything is built on: `Button`, `Input`, `Select`, `Field`, `Dialog`,
  `Sheet`, `Switch`, `Toast`, `Tooltip`, `Menu`, `Skeleton`, `Sparkline`, plus
  the `Tour` state machine.
- **Diagnostics is the biggest hole** — 9 untested sub-components on an
  admin/ops surface with real blast radius (`RunJob`, `RepairTab`,
  `SchedulerTab`, `MarketDataTab`, `LogsTab`, `HealthTab`, `SystemTab`,
  `JobParamsForm`, `ConfirmAction`).
- `pages/Transactions/TransactionForm.tsx` — the core money-entry form — has no
  test.

Backend, by source/test file ratio: `services` 65/77 and `readmodels` 29/29 are
healthy. **`repositories` 19/8 is the thinnest non-trivial package** and sits
directly under the service layer, where regressions become silent
data-correctness bugs. `models` 19/1. `tools` 15/8.

Unverified: whether `backend/tests/{installer,parity,e2e}/` (8 files, not
mirroring `src/`) actually run or are quietly skipped. Check before relying
on them.

### 3.5 Cutover scale (all gated on owner approval + a parallel-run week)

| Item | Lines |
|---|---|
| `web/` | 72,675 (191 files) |
| NiceGUI `backend/.../ui/` | 13,838 |
| `installer/` | 1,544 |
| `run_dashboard.{py,bat,sh,vbs}` | 746 |
| Publish services (`publish_service`, `auto_publish`, `tools/publish_web`) | 844 |

Also outstanding: keyring usage spans **12 files**, wider than `storage/cloud.py`
alone, and needs per-file triage rather than a blanket delete. The plan requires
migrating `ui/pages/_*_query.py` logic into `readmodels/` before deleting `ui/`
— **not confirmed done**.

`web/src/` still contains ~11 files of client-side money maths (`compute.ts`,
`returns.ts`, `currency-effect.ts`, `projection.ts`, `window-growth.ts`…) — the
exact "client computes a return" anti-pattern AGENTS.md warns against. It is
dead weight rather than active risk, since `frontend/src/` was confirmed to do
no client-side computation.

### 3.6 Files to split before v7 logic lands on them

Keepers only (excluding deletion-bound v5 code): `readmodels/queries/overview_query.py`
1,774 lines, `services/intraday_snapshots_service.py` 1,761, `boot.py` 1,221,
`services/prices_service.py` 1,120. Frontend: `components/Chart/Chart.tsx` 682,
`pages/Holdings/Holdings.tsx` 566, `pages/Transactions/Transactions.tsx` 527,
`pages/Allocations/Builder.tsx` 519.

### 3.7 Caveat

Five releases landed on 2026-11-04/05 (6.5.0 → 6.6.0), including an Overview
hero redesign and a holdings/movers rebuild. **The frontend findings describe
freshly-changed code, not settled code.**

---

## 4. ❌ NOT INVESTIGATED — page-by-page critique and information architecture

The core of the owner's request: for each of the 18 pages, is it pulling its
weight, what is good, what is thin or redundant, what is missing from that page
given its purpose; plus whether the component layer is a coherent design system
or a pile of special cases, whether the chart family is consistent, the state of
empty/loading/error handling, accessibility, the mobile story, and whether the
top-level navigation is right for a single user with 18 pages.

Suspected overlaps worth adjudicating (**unverified, inferred from page names
only — do not act on these without checking**): Holdings vs the Overview
holdings list; Allocations vs Risk; CurrencyConversions vs Transactions.

**No page was read. No opinion has been formed. This section is empty.**

---

## 5. The four feature workstreams

All four reported. §5.1 and §5.2 are designed and actionable; §5.3 has a
strong privacy design but an unresearched News half; §5.4 has reasoning but no
verified competitor research. Each sub-section ends by naming what it did not
reach, so the work can resume cleanly.

### 5.1 ✅ Currency page + holding deep-dive

#### 5.1a ✅ Currency page — designed, and cheaper than expected

**The single best finding in the whole exercise:
`domain/currency_effect.py` already computes almost everything the owner asked
for, and v6 throws five of the six fields away.**

`compute_currency_effect(...)` (`domain/currency_effect.py:62-117`) returns
`avg_invest_rate` (the blended average EUR cost rate of his dollars — the exact
metric he asked for), `current_rate`, `rate_change_pct`, `currency_effect_pp`,
`fx_pnl_eur`, `repatriation_value_eur` and `breakeven_rate`. **Only
`currency_effect_pp` is surfaced on the v6 path** (`readmodels/overview.py:271`,
`:347`); the rest are computed and discarded (they were shown on the legacy
NiceGUI analytics page, `ui/pages/analytics.py:389-438`).

**What exists today.** `/conversions` is **CRUD plus provenance, with zero
analytics** (`pages/CurrencyConversions/CurrencyConversions.tsx:163-331`): two
KPI tiles, a table of conversion batches, and a FIFO deposit-matching card. No
chart, no rate history, no FX P&L, no percentile, no per-holding FX.

**FX storage:** `fx_history(date, base, quote) → rate, source`
(`models/fx_history.py:17-33`) — **daily only**, ECB/Frankfurter sourced, with
manual-override rows (`fx_service.py:765-831`). Live spot is **in-memory only
and resets on restart** (`fx_service.py:74-114`). Intraday FX exists only
piggybacked on `intraday_value.fx_eur_usd` (`models/intraday_value.py:60-65`),
retained for **5 sessions at 5-minute spacing**. `fx_service.list_rates(…)`
(`:790-798`) is already the backbone of a rate-history endpoint.

**Proposed page** — new `frontend/src/pages/Currency/` at `/currency`; keep
`/conversions` as the editing surface and link to it. Backend:
`readmodels/currency.py` + `api/currency.py` with `GET /api/currency/both`
(ETag `/both` pattern) and a separate `GET /api/currency/history?range=`.

| # | Panel | Verdict |
|---|---|---|
| 1 | Rate now (spot, as-of, live vs EOD, day move) | **Already computed** (`fx_service.eur_quote_as_of:732-762`) |
| 2 | FX vs instruments split of lifetime return | **Already computed** — show both legs, not just the difference |
| 3 | Avg rate you bought dollars at vs today, breakeven, FX P&L, repatriation value | **Already computed, discarded** — highest value per line of code |
| 4 | Real cost of conversions (spread vs ECB fixing) | **Computable**, new `domain/fx_spread.py`; join `fx_conversions` ⋈ `list_rates`, no new storage |
| 5 | EUR/USD chart with his own transaction markers | **Computable**; needs the new history endpoint |
| 6 | Where today's rate sits in his own holding period (percentile) | **Computable**, new `domain/fx_stats.py` |
| 7 | FX on cash balances | **Computable** (`positions_service.compute_cash_balance:323-342`); needs a definition decision |
| 8 | Realised vs unrealised FX effect | **Needs new work** — the only genuinely new money maths |
| 9 | FX impact per holding | **Already computed** — both EUR and USD legs exist per card, `pick()` discards one |
| 10 | Conversion pool state | **Already computed** — reuse `GET /fx-conversions/pool` |

**Recommended order:** KPI strip (#1 + #3) → #2 split → #5 chart → #6
percentile → #9 per-holding table → #4 conversion costs → #7 + #10.

🚩 **Currency-rule hazards a future agent will walk into:**

1. #2 must **not** be `eur_return = usd_return × fx_change`. EUR growth stays
   the independently-computed EUR leg; `currency_effect_pp` is a *residual*.
2. #3's `fx_pnl_eur` is valid **only as a single-instant comparison**. Never
   annualise it or feed it to an XIRR.
3. #6's percentile is non-linear → **server-side only**.
4. #4 must compare each conversion against **its own date's** fixing, never one
   back-dated rate across a batch. Label it "vs ECB daily reference", not
   "vs mid-market" — ECB is a daily fixing, not the intraday mid.
5. #8 is the easiest place to break the rule: it must be built from the EUR
   cashflow stream with each leg at its own date's rate (via `ledger_walk`'s
   `cost_eur` legs), never USD realised gain × a rate delta.
6. **Do not add derived-currency columns** to `fx_conversions` (no stored
   `mid_rate` or `spread_eur`) — AGENTS.md forbids it; #4 is a read-time join.

**New storage needed: none** for panels 1–4, 6, 7, 9, 10. Recommendation:
**do not** persist intraday FX beyond the existing 5-session window for v7 —
daily ECB fixings are the right granularity for a lifetime/strategic view.

⚠️ **Check before building:** `components/CurrencyBox/` and
`components/CurrencyLifetime/` were **not read** — some of panel 3 may already
be partly built in `CurrencyLifetime`. Also unread: `fx_conversion_service.py`,
`domain/session_fx.py`, and **`services/cashflows.py`**, which is central to
panels 2 and 8.

#### 5.1b ✅ Holding deep-dive — exactly what exists today (verified)

**The headline finding: the deep-dive is thinner than its reputation, and
mobile already works — just badly.**

Today the entire "deep dive" is: one 480px bottom `Sheet`, a muted strapline, a
six-range native-currency price chart with a cost-basis reference line, and an
**11-field definition list**. That is all. No route, no tabs, no transactions,
no dividend history, no lots, no benchmark, no intraday range, no per-holding
statistics.

**How it opens** (`Holdings.tsx:148-162`) — a `Sheet` (bottom sheet), *not* a
route, dialog or row expansion. Desktop: only the symbol is clickable
(`holdings-page__open` button); the row itself is not. Contents in order: a
muted `{account} · {category} · {native_currency}` line, `HoldingDrawerChart`,
then `HoldingDetails`.

`HoldingDetails` (`HoldingParts.tsx:54-121`) is a 2-column `<dl>` with exactly
11 rows: Price · Price as of/updated · Shares · Cost basis · Capital gain ·
Dividends · Total return · Growth · XIRR · Weight · Expense. It **omits**
fields the table already has: `avg_price_native`, today/MTD/YTD growth, value,
and category/account beyond the strapline.

**Mobile is already implemented — as a confusing two-stage flow.** The owner's
"ship it to mobile" ask is therefore partly already done; the real defect is
duplication. On phone (`isPhone`, `Holdings.tsx:187`) the `DataTable` is
replaced wholesale by `HoldingMobileRow` list items. Tapping a row expands it
inline and renders **the same 11-field `HoldingDetails`**; a secondary "Price
chart" button then opens **the same `Sheet`, which renders that identical dl
again**. The user sees the same 11 fields twice.

> **Recommendation (provisional):** make the deep-dive a real route,
> `/holdings/:id`. The survey confirms this is **low-friction**: `titleFor`
> (`nav.ts:64`) already prefix-matches, so TopBar title and TabBar active state
> work unchanged; per-id data already exists via `useHoldingHistory(id, range)`
> plus the cached list row; reusing the existing Holdings chunk avoids a new
> waterfall. Caveats: a cold deep-link renders only after `/api/holdings/both`
> resolves, and `useParams` yields a string while `instrument_id` is a number.

**1D / 1W: blocked at the API, but the infrastructure exists.**
`HISTORY_RANGES` is `["1m","3m","6m","ytd","1y","all"]` (`Holdings.tsx:118`),
and the API enum `HoldingHistoryResponse.range` is exactly those six
(`lib/api-types.ts:3025`). If the stored display pref is `1d`/`1w` it silently
falls back to `1y`. **But portfolio-level graphs already support them** —
`GRAPH_RANGES = ["1d","1w","1m","3m","6m","ytd","1y","all"]`
(`lib/queries/portfolio.ts:16`), with a 30 s stale time for 1d/1w. So intraday
plumbing exists at portfolio level; the work is extending it per-instrument.
✅ **Resolved — per-holding 1D/1W cannot be served from stored data today.**
`intraday_value` is a **single portfolio-wide aggregate row per instant**
(`models/intraday_value.py:1-24`, `:37-56`), not a per-instrument series, and
`price_history` is one row per (instrument, date) (`models/price_history.py:34-40`).
There is no per-instrument intraday series anywhere on disk.

Two options:

- **(a) Fetch on demand per symbol** via the existing adapters
  `fetch_intraday_closes` / `fetch_intraday_closes_range`
  (`adapters/yfinance_client.py:335`, `:359`), cached per request. No schema
  change, but a provider call on each drawer open. **Recommended for v7.**
- **(b) A new cache-tier `instrument_intraday` table** mirroring
  `intraday_value`'s 5-session retention, written by the same capture tick.
  Correct and fast, but adds a model, a migration and janitor coverage.

⚠️ **Check first — it may make (a) nearly free:**
`intraday_snapshots_service.reconstruct_last_session` (`:815`) almost certainly
already fetches per-instrument bars and aggregates them away. If so, (a) is a
small refactor rather than new plumbing. This materially changes the estimate.

**Lots: ✅ question resolved — the app is average-cost, and that is the real
problem.** A grep for `lot|lots|tranche|tax_lot` over `frontend/src` returns
zero matches, and there is no lot table (§2.2). The ledger walk uses
**average cost per `(account_id, instrument_id)`** — stated explicitly at
`services/ledger_walk.py:9-13` ("the average-cost method is applied per
account, never pooled across accounts"), with a SELL releasing a proportional
slice (`:105-112`). `Lot` (`:35-55`) is a running aggregate, not a tranche.

**Good news:** no schema change or migration is needed to *display* lots. The
transactions table has one row per BUY/SELL/REINVEST/SPLIT with date, quantity,
price and fees (`models/transaction.py:60-84`), indexed by instrument (`:50`),
so per-lot reconstruction is a pure-domain replay (`domain/lots.py` +
`services/lots_service.py`).

🚩 **The real cost is conceptual, not technical.** Adding FIFO lots introduces
a **second cost-basis method** into an app whose entire gain/growth/XIRR stack
is average-cost. Per-lot gains **will not sum to the position's displayed
capital gain** after any partial sale. Recommendation: ship lots as a
**purchase-tranche history** (per-lot cost, age, gain vs today's price),
explicitly labelled *"FIFO view — the position's totals use average cost"*, and
**never let lots feed an aggregate**. True FIFO cost basis for tax purposes
would touch every return number in the app and needs a full parity run under
the AGENTS.md money-maths gate — that is a separate, much larger project.

⚠️ **Most likely bug in the lots feature:** SPLIT rows change quantities as
deltas (`ledger_walk.py:139-142`) and the price feed is back-adjusted, which
`positions_service` compensates for with a cumulative split factor
(`positions_service.py:49-73`, `:198-224`). Each lot's historical price needs
the same treatment or per-lot gains are wrong by the split ratio.

**Dividends per holding: one number.** The drawer shows a single lifetime
"Dividends" figure (`HoldingParts.tsx:85-88`). Real dividend detail lives on
the **Activity** page (`Activity.tsx:290-309`: KPI tiles, "Dividends by
holding" and "by year" tables, a per-payment column set) but it is **not
filterable to one instrument and not linked from the holding detail** — an
obvious, cheap connection to make.

**Smaller defects worth fixing in passing:**

- The holding chart passes no `rangeLabel`, so its buttons read raw ids
  ("1m", "ytd") while `ValueChartCard` shows "1M", "YTD"
  (`ValueChartCard.tsx:29-38`). Inconsistent.
- Holdings breaks the established **phone→`Sheet` / desktop→`Dialog`** pattern
  that Transactions (`:500`/`:504`) and Instruments (`:397`/`:401`) follow — it
  always uses a Sheet, so on desktop the detail is a 480px bottom-anchored
  sheet rather than a dialog.
- `Sheet` is minimal: props are only `open`, `onOpenChange`, `title`,
  `children`. No footer, size, description, snap points or drag-to-dismiss
  (the grab handle is decorative, `aria-hidden`). A richer deep-dive will
  outgrow it — another argument for a route.
- `OverviewHoldings` rows are **not clickable** (`OverviewHoldings.tsx:199-213`
  offers only a "Show all" fold). If the deep-dive becomes a route, Overview
  rows should link to it.
- The house tab pattern is `SegmentedControl` (used on Activity, Risk, Periods,
  Allocations, Diagnostics, Projection, Transactions, Settings) — reuse it for
  deep-dive tabs rather than inventing one.

**Useful context for sizing:** there is currently **no per-instrument
transactions, dividends or lots query hook** in `lib/queries/` — all of those
would be new endpoints plus new hooks.

❌ **Still missing from this workstream:** the actual *design* of the expanded
deep-dive (panels, tabs, layout), the summary-statistics set, and the entire
Currency page.

### 5.2 ✅ "What happened since I last logged in" — fully scoped, ready to build

The owner's stated primary interest, and the best-specified workstream in this
plan. **Buildable as described.**

#### 5.2a 🚩 There is no usable "last seen" marker — and the obvious ones are traps

`AuthSession` (`models/auth.py:40-48`) has `created_at` and `last_seen_at`, but
every candidate fails:

- **`last_seen_at` is throttled to 60 s** (`auth_service.py:181-182`, `:51`)
  and is touched by *any* API call, so a tab left open overnight makes it track
  "tab was open", not "owner looked".
- **The previous session's `last_seen_at` is destroyed by the act of logging
  in** — `_start_session` deletes the presented cookie's row before issuing a
  new one (`api/auth.py:120-132`, `:123-124`). Decisive.
- **`created_at`** looks right but breaks for a long-lived cookie: he can go two
  weeks without re-authenticating, so it would go stale and never re-arm.
- **`services/session_memo.py` is unrelated** — it is a per-DB-session read memo
  for hot ledger reads (`:1-26`). Rule it out despite the name.

**Recommendation: a persisted `briefing.last_seen_at` key in `AppConfig`**
(`models/app_config.py:11-15`, via `app_config_service.py:44-64`), advanced
**only** by an explicit `POST /api/briefing/ack` — never by a GET. That makes
it mean "the last moment the owner was *shown* what happened", the only honest
definition. **No Alembic migration needed**; `intraday_snapshots_service`
already uses `app_config` for markers this way (`:1642`, `:1659-1660`).

#### 5.2b ✅ The trigger rule, precisely

`domain/market_hours.py` already has every primitive, including tz-aware
`regular_session_open(day)` (`:360-370`) and `regular_session_close(day)`
(`:345-357`), plus holiday computation including Good Friday via computus
(`:137-173`) and Juneteenth from 2022.

> **A briefing is due iff at least one NYSE regular-session boundary instant
> lies in the half-open interval `(L, N]`**, where `L` = `briefing.last_seen_at`
> and `N` = now. Boundaries are generated for each date `d` in
> `[exchange_today(L), exchange_today(N)]` where `is_trading_day(d)`.

A dozen lines of pure domain code that answers every edge case for free:

| Case | Behaviour |
|---|---|
| Two visits in one session (17:00 and 17:30 CET) | no boundary → **no briefing** ✓ |
| 14:00 → 16:00 CET | 15:30 open crossed → **gap story** |
| 20:00 → 23:00 CET | 22:00 close crossed → **session-complete story** |
| Fri 23:00 → Mon 10:00 | no boundary → **no briefing** (see FX exception) |
| Over a holiday | `is_trading_day` excludes it → no spurious briefing |
| First ever login | key absent → seed `L = N`, report nothing |
| Dismiss, return 5 min later | ack advanced `L` → **no briefing** ✓ |

**Absence classes** (drive content): `gap` (open crossed, no close),
`one_session` (1 close), `few_sessions` (2–5 closes — the intraday cache still
covers it, `WEEK_SESSIONS = 5`), `long` (>5 closes, daily closes only).

**Decisions taken:** model **NYSE only** in v1 — `market_hours` is NYSE-only by
explicit design (`:26-28`), the book is US-heavy, and the EUR instruments are a
minority. Say "US session" in the copy. Accept the existing half-day
inaccuracy (`:16-19`): a 1pm ET close fires the briefing three hours late,
which is harmless. ⚠️ Note `previous_trading_day` (`:310-326`) and
`trading_days_before` (`:329-342`) are **holiday-unaware** by their own
docstrings — use `is_trading_day` / `latest_settled_session_date` instead.

#### 5.2c ✅ Content

**Headline** is the portfolio's *return over the absence window*, not a price
delta, computed server-side via `domain/returns.window_growth(...)`
(`returns.py:427-490`) — whose docstring already enforces the currency rule
(`:439-441`), and whose `_in_window` (`:373-379`) correctly excludes a flow
dated on the opening day. Opening value from
`snapshots_service.get_or_compute_in_currency(…, anchor_date, ccy)`
(`:95-124`), which converts **at that date's rate**. **Computed twice, once per
currency**, exactly like `_overview_both` (`api/overview.py:27-35`).

**Anchor** = the last settled close at or before `L`
(`latest_settled_session_date`, `:260`), *not* `L` itself — "Tuesday's close"
is reproducible, "17:43 on Tuesday" is not. Print the window on screen.

**Movers:** for `gap`/`one_session`, pass the existing `build_movers` output
through and relabel (`overview_query.py:1743-1774`). For longer absences a
**window mover board** is new work — shares held **at the anchor**, not now,
or a position opened mid-window shows a fake move.

**FX gets its own line, always** — his portfolio is USD and his money is EUR,
so the dollar moving *is* part of what happened. ⚠️ `compute_eur_fx_effect` is
built around a single day's live/prev pair, so a multi-session version is new
work and **must not be faked by scaling**.

🚩 **Weekend exception, recommended:** a Friday-to-Monday absence crosses no
NYSE boundary, so the rule says "no briefing" — yet EUR/USD moved. If
`last_forex_reopen` (`:425`) falls in `(L, N]`, show a *reduced* one-line strip
("Markets were shut. EUR/USD moved −0.3%") and nothing else.

**Portfolio changes while away:** query transactions by `created_at` in the
window (`models/transaction.py:93`) — dividends landed, deposits, splits,
imports. Omit the block entirely when empty rather than showing "nothing".

❌ **Cut from v1 — "moved on no volume vs real news" is not buildable.** No
volume is stored anywhere; a repo-wide grep finds one hit, an import column
name (`adapters/tabular/columns.py:226`). The honest substitute is the existing
`daily_is_stale` flag — a "last priced Tue" tag on the mover row. Real volume
means a provider field, a new column and a migration; price it separately.

❌ **Milestones / new highs: defer.** Nothing tracks all-time or 52-week
extremes, and the obvious derivation needs a full-history scan that
`series_in_currency` explicitly guards against doing on the request thread
(`:186-195`). Build it scheduler-side, cached in `app_config` — not v1.

#### 5.2d ✅ UI

**A dismissible banner-card directly above `OverviewHero`**, inserted in
`Overview.tsx` between `OverviewWarnings` (`:115`) and `OverviewHero` (`:117`).
Not an interstitial (hostile on a glance-check), not a hero replacement (his
first instinct is still "what is it worth"), not a `/since` route (an extra tap
for his stated main interest).

Desktop: three zones — headline + signed money + `DeltaBadge` | window
sparkline | 3-up movers strip and the FX line, with "Details" expanding in
place. Mobile: single column, headline and number only, rest behind
tap-to-expand, reusing `Card`'s collapsible mechanism (`Card.tsx:22-23`) with a
**separate** persisted key from dismissal.

**States:** *loading* → render nothing (don't reserve space and jump the hero);
*nothing-to-report* → render nothing at all, no "you're up to date" chrome;
*weekend* → the quiet reduced strip; *stale/provider failed* → **never show a
number computed against a missing anchor** — gate on `freshness.prices_live`,
`total_value_complete` and `warnings.missing_fx`, and degrade to the
qualitative story only ("3 sessions passed") plus a muted "figures unavailable"
line, copying the existing `anchor_missing` pattern (`overview.py:258`).

**Dismissal:** `×` → ack; **also auto-ack after the card is visible ≥3 s**
(IntersectionObserver), so reading and scrolling past does the right thing.
Keep a local `iv.briefing.dismissedAt` only so a failed ack doesn't re-show it
in the same tab; the server marker is the cross-device source of truth.

**Colour:** a warn border beside an orange loss figure puts `--color-warn` next
to `--color-neg` — **that pair must be added to `tokens.cvd.test.ts`.** Keep
the up/down arrows; never colour alone.

#### 5.2e ✅ Implementation and ship order

New: `domain/briefing.py` (boundaries + classification, property-tested across
weekends, holidays and **DST changeovers both directions**),
`services/briefing_service.py`, `readmodels/briefing.py`,
`api/briefing.py` (`GET /briefing/both` + `POST /briefing/ack`),
`components/SinceYouWereAway/`, `lib/queries/briefing.ts`.

🚩 **Easiest thing to get subtly wrong:** the ETag. `@conditional_both`
(`read_cache.py:216-248`) varies on the `LEDGER`/`PRICES`/`FX` generations, but
the payload also depends on `last_seen`, which is **not** one of them — so an
ack would not invalidate the cache. Fix by including `last_seen` in the route's
plain params, or bumping `LEDGER` on ack.

**Activity log:** the ack is a POST, so `subject_for` already routes it to
`changes` (`api/activity.py:135-149`) — add an explicit `_LABELS` entry, but
**no new subject and no RUNBOOK row needed**. The GET correctly logs nothing.

**Ship order.** **v1:** trigger rule, last-seen marker, ack endpoint, window
return, the ETag'd GET, and the component — scoped to `gap` and `one_session`
only, where the existing single-day `compute_eur_fx_effect` already works.
Longer absences fall back to a plain "N sessions passed" strip with no numbers.
**v1.1:** the transactions-while-away block and the weekend FX strip (cheap,
high perceived value). **v2:** the window mover board and window FX
attribution. **v3 / separate decision:** milestones and the volume signal.

### 5.3 ⚠️ LLM summaries (privacy design ✅) + News tab (❌)

**Privacy constraint, stated by the owner and non-negotiable:** the LLM may
receive which holdings he owns and their performance percentages, and nothing
else — no totals, no absolute amounts, no weights, no composition beyond the
bare list of instruments.

#### 5.3a 🚩 Conflict with the existing v6 plan — needs an owner decision

`docs/v6_one_app_plan.md:308-311` already specifies a **Phase 5 OpenRouter
assistant**: `POST /api/assistant/chat` with SSE streaming and read-only
**tool-calling** mapping 1:1 to read-models (`get_overview`, `get_holdings`,
`get_transactions`, `get_allocation_drift`, `simulate_rebalance`…).

**That design cannot satisfy the privacy constraint.** Tool-calling hands the
model a live query surface; you cannot allow-list a payload that the model
fetches for itself — `get_overview` and `get_transactions` return values and
amounts by definition. v7 must scope this as a **push-a-redacted-payload
summariser**, not a tool-using chat assistant, and `v6_one_app_plan.md:308-311`
should be amended to say so.

#### 5.3b ✅ Groundwork that exists (verified)

The plan anticipates the key: `OPENROUTER_API_KEY` is listed at
`v6_one_app_plan.md:264`, and `:263` notes the bearer token stays "for scripts
and the future LLM". **No code groundwork exists at all** — greps for
`openrouter|llm|assistant` across Python/TS/docs hit only documentation and
substring false positives. No adapter, service, router, setting or env var.

#### 5.3c ✅ Payload source and the redaction design

`readmodels/holdings.py` is the right source and already emits both the needed
and the forbidden fields, so redaction is a real filter.

- **Allowed (percent-shaped):** `xirr` (:121), `total_growth` (:122),
  `ytd_growth` (:123), `mtd_growth` (:124-131), `today_pct` (:132).
- **Identity:** `symbol`, `name`, `category`, `asset_class`,
  `native_currency` (:100-106).
- **Forbidden:** `cost_basis`, `value`, `capital_gain`, `dividends`,
  `total_return`, `today_move`, `shares`, `avg_price_native`, `price_native`,
  and **`weight_pct` (:137)**.

Two specific hazards found:

1. **`_summary()` (`holdings.py:142-170`) returns `most_concentrated_symbol`
   and `most_concentrated_weight_pct`** (:159-163) — the single largest holding
   by name and number. Must never reach the payload.
2. **`attribution.pct_of_total_return` (`analytics.py:66`) looks percent-shaped
   and is not safe** — it is a contribution share, i.e. weight × return, so it
   reconstructs relative weights directly. This is exactly the field a
   blacklist misses and an allow-list catches.

`readmodels/analytics.py` `_bundle()` (:72-94) is otherwise usable field by
field — `cagr`, `twr`, `xirr`, `volatility`, `sharpe`, `sortino`,
`max_drawdown`, `calmar`, `ulcer`, `var_95`, `cvar_95`, `beta`, `alpha` are all
dimensionless — but `curve` (:30-33), `attribution` (:60-66) and the summary
block (:234-243) carry absolute money and must be dropped wholesale. In
`readmodels/periods.py`, `_flat_row()` (:68-104) mixes safe `growth_pct` /
`period_growth_xirr` with forbidden `contributions`, `net_flow`,
`opening_value`, `closing_value`.

**Implementation shape:** a strict allow-list builder in a new
`readmodels/assistant_payload.py` that constructs the dict field by field from
scratch — never `dict(row)` then `pop()`, never `**row` — returning a frozen
dataclass whose fields *are* the entire allowed surface, so adding a field
upstream can never silently widen the payload. Back it with two tests: one
asserting `set(payload_keys) == EXPECTED`, and one feeding a holding row whose
every money field is a recognisable sentinel, asserting no sentinel appears in
the serialised JSON **or in the rendered prompt string**.

#### 5.3d ✅ Leakage routes — including the one that matters most

1. **Ordering implies weight.** Default sort is by value, so position 1 is the
   largest holding. **Sort alphabetically by symbol** in the builder, with a
   comment explaining why, and test it.
2. **Decimal precision.** Percentages derived from exact `Decimal` money carry
   low-order digits that help solve for weights. **Round to 1 dp** at the
   boundary (quantize, don't truncate).
3. **🚩 The portfolio aggregate is a weighted mean of the holdings.** This is
   the subtle one. Publishing every holding's `ytd_pct` *and* the portfolio
   `ytd_pct` gives `Σ wᵢ rᵢ` — one equation in n unknowns, harmless. **But
   publishing 12 monthly portfolio figures alongside 12 monthly per-holding
   figures gives 12 equations and the weights become solvable.** Rule:
   per-holding figures at several horizons, but the **portfolio** figure at
   **one** horizon only. Never both full monthly grids. Invisible to any
   field-by-field blacklist.
4. **"Top contributor" framing implies weight** (contribution = weight ×
   return). The prompt must forbid contribution/driver language.
5. **Free text is a prompt-injection surface, not just a leak surface.**
   Instrument `name`/`category` are owner-editable via
   `PATCH /api/instruments/{id}`. Cap length (~64 chars), strip control
   characters and newlines, and render the payload as a **JSON block in a
   delimited section**, never interpolated into prose — otherwise a custom
   instrument name reading "ignore previous instructions" executes.
6. Account names (leak broker and structure) and dividend amounts: excluded.
   Holding **count** implies concentration — unavoidable and acceptable, since
   he is disclosing the list anyway.

#### 5.3e ✅ Does whole-portfolio XIRR/TWR count as a forbidden "total"?

**Argued position: no, include them — subject to the one-horizon rule above.**
The constraint names total *value*, absolute amounts and weights. XIRR and TWR
are **dimensionless rates**: 9.6% YTD reveals nothing about whether that is on
€5k or €5m, and TWR is specifically constructed to be insensitive to cashflow
size. They are also the only weight-aware numbers available, which is what lets
the model say "the portfolio is up 9.6% while your best holding is up 40%" —
truthfully signalling that the 40% holding is small. **Removing them makes the
summary less accurate without making it more private.**

#### 5.3f ✅ The weights trade-off — two options, owner decides

Without weights, "<some holding> +40%, portfolio +9.6%" is honest but mute.

- **Recommended — UI-side mitigation, zero privacy cost.** The client already
  holds the real weights. Render the summary **next to** a weight bar per
  mentioned symbol: the LLM supplies language, the UI supplies magnitude. This
  is permitted under "server computes, client patches" — the weight is a value
  the server already sent, and placing it beside text is presentation.
- **Optional relaxation if prose must be weight-aware:** coarse buckets per
  holding (`core` ≥15% / `mid` 5–15% / `small` <5%) with fixed, public edges.
  Discloses the portfolio's shape but no numbers, and slightly re-opens
  leakage route 3. **Not recommended for v1** — try the UI mitigation first.

#### 5.3g ✅ Platform requirements (verified)

- **Settings: copy the `tiingo.api_token` pattern**
  (`services/settings_registry.py:445-456`) — `secret=True`, `nullable=True`,
  `env_var=…`, `danger=…`, section `"providers"`. `SettingDef`
  (`domain/settings_schema.py:67-90`) supports it. A new `"assistant"` section
  would need adding to `SECTIONS` (`settings_registry.py:34-46`).
- **🚩 Rate limiting must be built, not configured.** `api/limits.py` is a
  `RequestGuard` middleware doing **body-size caps and up-front auth only**
  (:76-137). The *only* rate limit in the codebase is on login. A cost-bearing
  LLM endpoint needs a new mechanism; `limits.py:29-36` (`PUBLIC_API_PREFIXES`,
  `UPLOAD_ROUTES`) shows the table-driven shape to follow.
- **Guards:** use `FreshActorDep` (`api/guards.py`) for changing the OpenRouter
  key, matching the Tiingo token's `danger` note.
- **Activity log:** add a new **`assistant`** subject (an LLM call is neither
  `market_data` nor `changes`) to `SUBJECTS` (`activity_log.py:35-70`), the
  RUNBOOK table, and `subject_for()` routing (`api/activity.py:133-151`).
  **Do not** add `POST /api/assistant/summary` to `_READ_ONLY_WRITES` — it
  spends money and sends data off the server, so it belongs in the log like
  `/api/backup`. Log model id, token counts, latency, cache hit/miss and cost;
  never the payload, prompt, completion or key.
- **Kill switch:** `assistant.enabled`, **default false**, gating the adapter,
  the scheduler job, the routes (disabled, not 500) and the frontend card. With
  it off, no key is read and nothing leaves the server.
- **Scheduler:** `services/scheduler.py` (610 lines, lifespan job runner, with
  run-now/pause already logged) is the right home for a nightly after-close
  "generate today's summary" job.

**Surface (provisional):** one summary per day generated after close, stored in
a new table keyed by date + payload hash so re-requests are free and the text
is stable all day; a rate-limited "regenerate" button; a card at the top of
Overview with a "generated 22:05, model X" stamp. When the LLM is unavailable,
show yesterday's summary **clearly marked stale**; if none exists, hide the
card rather than showing an error. Add a post-hoc output check that rejects any
completion containing a currency symbol or digits adjacent to one.

#### 5.3h ⚠️ News tab — one solid finding, no design

**The privacy disclosure, which needs no research:** querying news by ticker
discloses his holdings list to the search provider — and unlike the summary,
**repeatedly and on a schedule**, which also reveals when he checks. There is
no technical mitigation preserving usefulness (decoy tickers still leak the
real set via intersection over time). What *is* mitigable: fetch **server-side
only** (no browser IP/cookie correlation), **batch all tickers into one query
per run** so timing doesn't track his activity, and pick a provider whose
retention terms he has read. Honest framing: *"if you accept the LLM summary at
all, you have already accepted disclosing the holdings list; news adds
frequency, not a new category of disclosure."*

❌ Everything else about News is **undone**: the source comparison (OpenRouter
web search vs a news API vs RSS vs yfinance/Tiingo news), ranking, dedup,
clustering, tying an item to a holding's move, storage schema and retention,
offline behaviour, and the page layout and components.

#### 5.3i ❌ NOT INVESTIGATED — all OpenRouter research

**Zero web calls were made.** The following are *recalled from training data*
and **must not be planned against until verified**: the `:online` suffix, the
`web` plugin object and `web_search_options` syntax; **cost per web-search
request**; how citations/annotations return; which models support native vs
plugin search; current model ids and per-Mtok pricing; and — most important —
**OpenRouter's data-retention and training policy, and whether zero-data-
retention is a request parameter or an account setting.** That last point is
the difference between this feature being acceptable and not, given
`v6_one_app_plan.md:311` requires defaulting to ZDR providers.

Codebase areas also not reached: `adapters/yfinance_client.py` and
`adapters/tiingo_client.py` (whether news endpoints are already wired, and the
adapter conventions a new `adapters/openrouter_client.py` should follow — **read
these first when resuming**); `readmodels/overview.py` field list;
`services/settings_service.py` storage side of secret settings; scheduler
internals; the entire frontend; and the models/Alembic work for the summary and
news tables.

**Ship order, the one assertion that holds:** summary first, News second — the
summary reuses read-models that already exist and has a single external
dependency, whereas News needs a source decision nobody has made.

### 5.4 ⚠️ Best-in-class benchmark — six competitors verified, design language not

> **Two competitors were verified live on 2026-11-05 with sources: Parqet and
> Getquin** (§5.4f). They happen to be the two closest to this owner's profile
> (German, EUR-reporting, retail). **Every other product claim in this section
> is model reasoning, not research** — see §5.4e for the full unresearched
> list, which still includes Portfolio Performance, the closest comparator of
> all.

#### 5.4a Missing surfaces, judged on product reasoning (competitor claims unverified)

- **Dividends/Income page — build, M.** `domain/dividends.py` already
  recognises the income but there is no router and no page. Monthly payout bars
  with a YoY overlay, forward 12-month forecast, **yield-on-cost per holding**
  (the metric that rewards a long holder), income as a share of contributions,
  and an ex-div calendar strip. A net-of-withholding view needs a new
  `tax_withheld_native` column.
- **German tax page — build a *narrow* version, L.** A full Abgeltungsteuer
  engine is a trap: the broker's Steuerbescheinigung is authoritative and a
  wrong number is worse than none. The valuable slice is forward-looking: a
  **Vorabpauschale estimator**, an **"if I sell X shares now"** FIFO/
  Teilfreistellung estimate, **Sparer-Pauschbetrag consumed this year**, and
  tax-loss-harvesting candidates with the Aktien-vs-Sonstige Topf distinction.
  Label everything "estimate, not tax advice". ⚠️ The Pauschbetrag amount, the
  BMF Basiszins and current Teilfreistellung rates are **unverified** and must
  be looked up. Depends on §2.1 and lots.
- **Benchmark/Compare page — build, M.** Today there is one benchmark symbol
  feeding beta/alpha. A real surface: N benchmarks normalised to 100, TWR vs
  benchmark per period, and crucially a **"same cashflows into the benchmark"**
  mode so the comparison matches his actual deposit timing. For a concentrated
  USD portfolio, "would a single world ETF have beaten me?" is *the* question.
- **Fees & Costs — build, S.** Best value-per-effort on the list: `fees_native`
  is on every transaction and `expense_ratio` on every instrument. Lifetime
  broker fees, fees as a share of contributions, annual TER in euros, projected
  TER drag. **No new data needed.**
- **Cashflow/Contributions — build, S–M.** Split value over time into
  contributions vs market growth vs FX effect — all three already computable.
  "Your money vs the market's money" is the most motivating honest chart for
  someone years in.
- **Command palette / global search — build, S.** `/` is **already promised**
  in the design doc and goes nowhere (§2.4). Overdue for an 18-page app.
- **Journal/notes annotated onto the value chart — build, S.** Compounds in
  value over years, distinctive, cheap. Needs a small table.
- **Corporate actions — build, M.** Only `price_split` exists, which is a
  price-adjustment record. A multi-year holder *will* hit a spin-off or merger
  and the ledger will silently go wrong.
- Also proposed: Goals (M), Reports/annual statement (M), **FX scenario/stress
  test** (M, no new data, uniquely relevant given unhedged USD), narrow alerts
  (S — drift, dividend cut, failed pull; **not** price alerts), ETF look-through
  and overlap (L, needs an external holdings source), EU-locale import (S).
- **Watchlist — build small or skip.** For a buy-and-hold investor it is mostly
  a temptation engine. Better shaped as "candidates with a note on why and a
  target entry price", which is journal-adjacent.

#### 5.4b Per-page upgrades worth noting

Overview: an underwater/drawdown strip under the hero; transaction markers on
the value line; a contributions-vs-growth shaded band; promote the
currency-effect split to a KPI tile. Holdings: column presets and saved views,
inline sparklines (the component exists), sort by contribution-to-return.
Allocations: time-stacked allocation drift over years; treemap sized by value
and coloured by return. **Risk: the metrics are already deeper than any
consumer tracker, but almost certainly under-explained** — add a correlation
matrix (the metric that actually bites for a concentrated book), a rolling-vol
line, an underwater plot with recovery durations, and per-metric "what good
looks like". Depth without interpretation is wasted. Periods: a protan-safe
month × year diverging grid. Projection: a fan/percentile band instead of one
line, with "use my own historical TWR" as an assumption source.

#### 5.4c "Fun but good", judged by whether it survives the third viewing

**Survives:** chart annotations/journal (gets better with age); "your money vs
the market's money"; a **personal-records page** (best month, longest
contribution streak, largest single-day gain, **days since the last all-time
high**, days underwater) — cheap and genuinely informative. ~~**Survives
marginally:** year-in-review~~ — **superseded by §5.4f: upgraded to a real
recommendation**, on evidence that Parqet Wrapped has run every year since
2022 and that its cards are behavioural rather than performance-based. Still
make it seasonal rather than a permanent nav item. **Fades:**
"what if I'd invested in X instead" (fun twice, then smug or painful — build it
only inside the Benchmark page where it is analytically honest);
achievements/badges (condescending by month two); streaks (one number on the
records page, not a mechanic). **Mixed:** time-machine "portfolio as of date X"
— frame it as a utility and it survives.

#### 5.4d Anti-recommendations

Do **not**: add price alerts or daily-move push notifications (engagement
patterns that exist to make you trade); put a big daily-change number in a
large typeface at the top (daily noise is the most misleading thing a
multi-year tracker can emphasise); copy brokerage-shaped UI (order tickets,
"buy more", bid/ask) — there is no brokerage attached; add social, leaderboards
or copy-portfolio anything; show un-annualised "total return since inception"
as the hero metric; build a filing-grade German tax report; add chart-junk (3D
pies, gradient fills obscuring the axis, animated counters); build multi-user
or sharing scaffolding. **And:** any heatmap or diverging palette borrowed from
a competitor screenshot must go through `tokens.cvd.test.ts` — borrowed
red/green will fail the protan gate.

#### 5.4e ❌ NOT INVESTIGATED (revised after §5.4h)

**Never touched — and these are the most directly comparable products to this
app:** **Portfolio Performance**, **Ghostfolio**, **Wealthfolio** — the
open-source, self-hosted peers. Also zero research: Finary. Also untouched:
Sharesight, Kubera, Empower, **all broker apps** (IBKR, Trade Republic,
Scalable, Robinhood, Schwab, Degiro, eToro), **all analytics terminals**
(Koyfin, Morningstar X-Ray, Bloomberg PORT, Stockanalysis.com, TradingView),
and **all pure-UX comparators** (Monarch, Copilot, YNAB, Lunch Money, Mercury,
Stripe, Linear).

**Partial:** Stock Events — homepage only. Widgets, notification settings,
mobile patterns and changelog are all missing, **which is the largest remaining
hole given the brief singled out mobile**.

🚩 **Design language is entirely unanswered.** No screenshots were viewed for
*any* product, so colours, typography, layout, density, empty states and
onboarding are unresearched across the board — as are mobile bottom sheets,
pull-to-refresh and haptics. The UX-patterns half of the brief was never
delivered.

Also still open: Snowball's full alert trigger list; PDF report contents (no
sample seen anywhere); per-country treaty withholding rates (e.g. 15% US/DE)
and Vorabpauschale mechanics; and genuine user threads — **all complaint data
gathered came from commercial review sites, several competitor-operated**, so
weight it accordingly.

**Re-check before relying on:** Getquin's risk-metric list (traced to a 2020
founder roadmap, not confirmed shipped); Stock Events pricing; Finanzfluss
Breakdown's exact labels (direct fetch failed, details from a search summary);
Portseido's multi-currency doc (search summary); DivvyDiary's
Freistellungsauftrag support; and the recalled-not-checked claim that FIFO is
mandatory for German private investors. German tax constants
(Sparer-Pauschbetrag, BMF Basiszins, Teilfreistellung rates) remain unverified.

#### 5.4h ✅ Verified: Snowball, DivvyDiary, Finanzfluss, Portseido (2026-11-05)

🚩 **VERIFIED WHITE SPACE — searched for and found on *no* product:**
**factor/style analysis, formal concentration scores (e.g. HHI), and a
dedicated currency-exposure screen.** Currency exists everywhere only as one
breakdown axis among many. **All three are directly relevant to this owner, and
the second and third are already in this plan** (§5.1a and the concentration
score in §5.4a). This is the strongest evidence in the whole study that the
Currency page is a genuine differentiator rather than catch-up work.

**Finanzfluss Copilot — the most German-relevant product found.** Free tier
permanently; PLUS €69.99/yr. It ships what §5.4f deferred: **estimated
Vorabpauschale per depot and per ETF** for a chosen year, plus a
**Freistellungsauftrag overview**. It also has two ideas worth taking outright:
**"Realrendite p.a." = return − inflation**, benchmarked against the German VPI
(no US tracker shows this), and a **Cash-Toggle** that includes or excludes
cash from the return calculation as an explicit control. Its "Breakdown"
look-through is a **single toggle in the Analyse tab** flipping every
allocation chart between "as held" and "look-through", and it **publishes its
own limits in the UI** (swap-based ETFs and assets without an ISIN cannot be
decomposed). Its help centre even has articles explaining *why numbers differ
between screens* — a pattern worth copying for an app with XIRR, TWR and
multiple currencies. ⚠️ Exact Breakdown labels unverified (fetch failed).

**Portseido — the most relevant currency finding.** TWR and MWR are shown
**side by side**, framed as "the return your decisions produced" vs "includes
the effect of contributions" — wording worth near-verbatim reuse. Its
multi-currency model has two explicit modes: a default where a foreign-currency
outflow is converted **at the transaction date's rate**, just enough for that
transaction, so **no FX gain/loss on cash arises**; and an opt-in
multi-currency mode with separate cash balances where **FX gain/loss on cash is
recognised**. That is a clean model for documenting this app's own currency
rule. **Crucially: Portseido has no currency-effect metric or chart at all** —
nothing decomposing return into local-return vs FX-return. Per-trade analytics
include **holding days**. ⚠️ Multi-currency doc read via search summary only.

**Dividend features worth taking** (Snowball and DivvyDiary, both far ahead of
Parqet/Getquin here):

- **Dividend cut detection is answered: yes, it ships.** Snowball flags
  increases and cuts **inside the calendar itself**; DivvyDiary lets alerts be
  narrowed to **hikes and cuts only**, suppressing routine unchanged payouts.
- 🚩 **Best alerting idea found anywhere: alert on the *absence* of an expected
  payment** (DivvyDiary, for missed bond coupons). Detecting a non-event is
  something this app's scheduler could do well.
- **Dividend Matrix** — a security × month × year grid (DivvyDiary).
- **Mark forecast rows with a distinct ✨ icon plus one global toggle** to hide
  all forecasts (DivvyDiary) — a clean answer to mixing projected and confirmed
  data.
- Dividend growth over **1/3/5/10 years, gross *and* net** (DivvyDiary); a
  **"Change" column vs the previous payment** in dividend history.
- **Passive-income diversification chart** — allocation of *income*, separate
  from allocation of value (Snowball).
- Snowball's **0–100 Dividend Rating** on 13 published criteria in 4 groups,
  with a stated danger threshold (below 35 = high cut risk). DivvyDiary
  deliberately ships no safety score.
- Apply the stored **tax allowance consistently across calendar, notifications
  *and* export** (DivvyDiary, 27 Sep 2026).

**Look-through UX, better than Parqet's:** DivvyDiary shows **your position
both directly and through your ETFs on the security page**, and offers a
**reverse look-through** — "which of my ETFs hold this stock", sortable by
weight (Apple appears in 1,728 ETFs). **ETF overlap has a concrete published
formula:** `overlap = Σ min(weight_A, weight_B)` across shared holdings, with
interpretation bands **<30% complementary, >60% redundant** (Snowball).

**Other items worth stealing:**

- **Plain-language explanation next to every risk metric** (Snowball puts one
  inline beside TWR, Beta, Sharpe, Sortino). This app already has the metrics
  Parqet lacks; explaining them is what makes them usable. Reinforces §5.4b.
- **Portfolio Snapshot by Date** — reconstruct holdings as of any past date.
- 🚩 **Backtest → save target allocation → hand straight to the rebalancing
  tool** (Snowball Portfolio Lab). **This app already has a rebalance planner**;
  closing that loop is the differentiator.
- **Cost-basis selector FIFO/AVCO with an explicit list of which metrics it
  changes** (Snowball, 28 Oct 2026) — a direct answer to the average-cost
  conflict in §5.1b: don't hide the method, publish its consequences.
- **Privacy/Stealth mode** hiding all amounts — shipped by *both* Snowball and
  DivvyDiary. v6 already has hide-numbers; this validates it.
- **An MCP server exposing the portfolio to the owner's own AI tools**
  (Snowball ships this on its top tier). **Nearly free for a self-hosted
  FastAPI app**, and a notably better fit for this owner's privacy constraint
  than sending data out — he would control the client.
- **Per-year IRR plotted on the growth chart**; a **customizable dashboard**
  with rearrangeable widgets; a portfolio value tile with a freely selectable
  period and buys/sells excluded; **Invested Capital by quarter and month**
  (when capital was deployed, separate from what it is worth).
- **Year-in-review confirmed a second time:** Snowball shipped a "2025 Recap"
  on 16 Dec 2025. Two independent products, pattern confirmed. **No streaks or
  achievements were found on any product** — supporting the §5.4c call to skip
  them.

**Export and reporting is confirmed cheap differentiation.** Nobody ships a
strong one: Snowball's has limited customisation and no capital-gains report,
DivvyDiary exports only a dividend calendar, Portseido reportedly has no tax
report, Getquin has no export at all. **No PDF report sample was found on any
product.**

⚠️ **Colour warning:** Finanzfluss's monthly-return heatmap uses a red/green
gradient. Any heatmap or chart copied from these products must be re-expressed
in `--color-pos` / `--color-neg` with its pairs added to
`frontend/src/styles/tokens.cvd.test.ts`.

#### 5.4f ✅ Verified: Parqet and Getquin (live 2026-11-05, with sources)

**ETF look-through is proven shippable.** Parqet's X-Ray sums each underlying
across all ETFs, funds *and* direct holdings into one true weight
(`parqet.com/en/x-ray`). Two implementation details matter more than the
feature itself: it substitutes a physical ETF's composition for synthetic/swap
ETFs on the same index, and it **shows the unresolvable remainder openly as
"Andere", which can reach ~17% of a portfolio**. Launch coverage was top-100
constituents only. If v7 builds this, copy the honesty about the remainder.

🚩 **Currency as an allocation dimension — a quick win that was under-rated.**
Parqet added market cap and currency as breakdown dimensions on 29 May 2026
(`parqet.com/en/changelog`); Getquin has both. For a EUR investor holding USD
assets this is the single most relevant allocation dimension — and unlike
sector or country it needs **no master-data enrichment**, because
`native_currency` already exists on `instruments`. **Size S. Not gated on
§2.1.**

🚩 **A lower-risk first tax feature than the Vorabpauschale estimator.**
Parqet's tax dashboard shows taxes paid per activity type per year (buy / sell
/ dividend) and **withholding tax by year *and country*, with an estimated
refund column** (`parqet.com/en/blog/tax-dashboard`). For a German holder of US
stocks that is high value and far smaller than a Vorabpauschale engine. It
needs the same single `tax_withheld_native` column already flagged in §2.2 —
**one schema change unlocks both this and net-of-withholding dividends.**
Parqet explicitly frames it as *not* a tax report; copy that framing.
⚠️ A Sparer-Pauschbetrag tracker could not be confirmed in either product, so
that idea stays unvalidated. **This replaces Vorabpauschale as the first tax
feature.**

🚩 **Correction: year-in-review was mis-judged.** §5.4c called it "survives
marginally". **Parqet Wrapped has run every year since 2022**
(`parqet.com/en/wrapped`) — the strongest available evidence that it keeps
working. The reason is that its cards are **behavioural, not performance**:
longest-held position, most-frequently-bought instrument ("bought this ETF 17
times"), average fee per transaction, portfolio age, value milestones, rare
one-off badges. Performance is one card among many. For a single-user app,
swap Parqet's community medians for **the owner's own prior years**. Upgraded
to a real recommendation.

**The app's risk metrics are a confirmed differentiator.** 2026 reviews still
flag that Parqet has **no Sharpe, beta, volatility or correlation at all**
(`finanzwissen.de/erfahrungen/parqet`). This app has all of those plus Calmar,
Ulcer, VaR, CVaR, skew and kurtosis. **The gap is interpretation, not maths** —
confirming §5.4b. Getquin's answer is a 0–100 health score with four 0–10
sub-scores (diversification, risk, fees, macro) and a written recommendation
per sub-score (`getquin.com/portfolio-analysis/`). Steal the interpretation
layer, not the metrics.

**Export is a free differentiator.** Parqet withholds export on the free tier,
Getquin has none, and reviewers call both lock-in
(`finanzwissen.de/anbieter/getquin/test/`). Neither offers a PDF report.

**Benchmark framing confirmed, with a better angle.** Parqet frames it as
*"should I have just bought a world ETF?"* — same period, same cash-flow
timing, up to 5 series, with the benchmark **suggested contextually from your
actual composition** (global → FTSE All-World, US-heavy → S&P 500, tech-heavy →
Nasdaq-100) (`parqet.com/en/performance-comparison`). They also teach IRR vs
TTWROR in-product and suggest **trailing-1-year IRR vs since-inception IRR** as
a built-in "am I doing better or worse lately?" read
(`faq.parqet.com/en/articles/650587-return-vs-ttwror`) — nearly free given
`domain/returns.py`.

**Ideas not previously considered:**

- **Balance reconciliation** against the broker's stated closing balance, per
  asset class (Parqet, 6 Mar 2026). For a file-import app this catches silent
  import gaps; pairs with Diagnostics and import staging. S–M.
- **Tags + "Views"** — colour-coded tags on holdings, and saved cross-cutting
  filters that behave like a first-class portfolio with their own value and
  return (Parqet, 2 Oct 2026).
- **Selectable cost-basis method per portfolio: FIFO / Average / LIFO**
  (Parqet, Jun–Jul 2026). 🚩 **Design the lots table for this from day one** —
  it directly addresses the average-cost conflict in §5.1b.
- Holdings and already-sold positions in one return table, sold ones
  collapsible.
- **Drag-select a time range inside the chart**, with all metrics recomputing
  for the selection (Parqet, 26 Jun 2026). The `Chart` component already has
  crosshair and ranges.
- Chart hygiene: dividend charts start at the first actual dividend, not the
  period start; heatmap rows auto-collapse when empty (Parqet, 25 Sep 2026).
- **Per-share dividend progression since *your* purchase date** — personal
  dividend growth, distinct from the instrument's (Getquin).
- Getquin's entire €149.99/yr "Wealth" tier is a **planning page**: an editable
  assumptions panel (pension, spending, inflation, taxes, cash, expected
  return, contributions) plus one-off cash-flow events on a timeline. That is
  the shape for a Goals/Projection upgrade.
- Tap-to-toggle % vs absolute directly on the holdings list.

~~**9. Alerts — do not act yet.**~~ **SUPERSEDED by §5.4h — this conclusion was
wrong.** Alerting is absent from Parqet and Getquin *specifically*, but
DivvyDiary, Snowball and Stock Events all ship it. It is not a market gap.

**10. CVD warning.** Parqet went from 8 to 16 chart colours in April 2026. If
v7 takes the treemap (colour = return) or a 5-series benchmark chart, **both
need new pairs in `frontend/src/styles/tokens.cvd.test.ts` before shipping.**

#### 5.4g Revised ranked shortlist

| # | Item | Size | Needs new data? |
|---|---|---|---|
| 1 | Enrich instrument master (ISIN, sector, country, domicile, acc/dist) | M | Yes |
| 2 | Lots/cost basis, **designed for selectable FIFO/Average/LIFO from day one** *(revised)* | L | Yes |
| 3 | Dividends/Income page: TTM monthly-income hero, announced-only forecast, yield-on-cost, gross/net toggle *(sharpened)* | M | Partly |
| 4 | Benchmark page: same-cashflow "world ETF" counterfactual + contextual suggestion + trailing-vs-inception IRR *(sharpened)* | M | No |
| 5 | **Currency as an allocation dimension** *(new — no enrichment needed)* | S | No |
| 6 | Fees & costs: broker fees + implicit TER as one annual figure | S | No |
| 7 | Underwater/drawdown chart + correlation matrix on Risk, **with interpretation copy** | S/M | No |
| 8 | Contributions-vs-growth decomposition | S–M | No |
| 9 | **Withholding tax by year and country with refund estimate** *(new — replaces Vorabpauschale as the first tax feature)* | M | One column |
| 10 | **Balance reconciliation against broker closing balances** *(new)* | S–M | Partly |
| 11 | Command palette / global search (the `/` shortcut already promises it) | S | No |
| 12 | Journal/notes annotated on the value chart | S | Small table |

**Promoted into contention:** behaviour-based year-in-review (S–M, no new data;
**now confirmed twice** — Parqet Wrapped since 2022 and Snowball's 2025 Recap);
tags + saved Views (S–M); ETF look-through with an honest "Other" bucket (L,
external data); a portfolio health score as an interpretation layer over the
existing risk metrics (M).

**Revised again after §5.4h:**

- **Alerts come back in** — not as a market gap (that was wrong), but because
  the *design* is now clear: narrow to **hikes and cuts only**, and alert on
  the **absence of an expected payment**. S.
- **Vorabpauschale is validated, not dropped** — Finanzfluss ships it per depot
  and per ETF alongside a Freistellungsauftrag overview. It still sits *behind*
  the withholding-tax view, which remains the cheaper first tax feature.
- **New, cheap, and well-matched to this owner:** "Realrendite p.a." (return
  minus German VPI inflation) and a Cash-Toggle on the return calculation —
  both S, no new data, and neither exists in any US-oriented tracker.
- **New: close the rebalance loop** — backtest → save target allocation → hand
  it to the existing rebalance planner. The planner already exists, so this is
  the cheapest route to something no competitor pairs up.
- **New: an MCP server** exposing the portfolio to the owner's own AI tools.
  Nearly free on a self-hosted FastAPI app, and a better privacy fit than
  §5.3 — the data would never leave his control.
- **Export / PDF report confirmed as cheap differentiation** — no competitor
  ships a strong one, and no PDF sample was found anywhere.

⚠️ **Caveats on the above:** Getquin's specific risk-metric list traces to a
2020 founder roadmap and is **unverified for 2026**. A few details came from
search summaries rather than direct fetches (Getquin's watchlist hypothetical
position; Parqet community requests). **No pairwise "ETF A vs ETF B overlap"
tool was found in either product** — Morningstar X-Ray was cited as the
alternative, and Morningstar was never researched.

---

## 6. ✅ A provisional v7 shape

Everything here rests on completed research. The missing work (§4, §5.4e)
affects what else should join the list, not whether these are sound.

### 6.1 Ship immediately — hours each, no new research needed

1. **Fix the 404 copy** (§3.3). Minutes; ships as its own patch release.
2. **Surface the five discarded `CurrencyEffect` fields** (§5.1a panel 3) —
   average rate he bought dollars at, breakeven, FX P&L, repatriation value.
   **The highest value-per-line-of-code item found anywhere in this exercise.**
3. **Show both currency legs per holding** (§5.1a panel 9) — the data is
   already on every card and `pick()` throws one away.
4. **Correct AGENTS.md** on the frozen currency legs (§3.2).
5. **Add currency as an allocation dimension** (§5.4f) — `native_currency`
   already exists on `instruments`, so this is the one allocation breakdown
   that is **not** gated on the instrument-master work, and it is the most
   relevant dimension for a EUR investor holding USD assets. Size S.

### 6.2 The v7.0 headline feature

**"Since you were away" (§5.2), v1 scope.** It is the owner's stated main
interest, it is fully designed, and it needs no migration. Build the trigger
rule, the `app_config` marker, the ack endpoint, the window return, the ETag'd
GET and the banner — scoped to `gap` and `one_session` only.

### 6.3 The Currency page (§5.1a)

🚩 **Now the strongest strategic case in the plan.** §5.4h searched six
competitors and found **a dedicated currency-exposure screen on none of them** —
currency appears everywhere only as one breakdown axis among many, and
Portseido, the most currency-aware product found, has **no currency-effect
metric or chart at all**. So this page is a genuine differentiator, not
catch-up — and most of its panels are already-computed data being discarded.

Ship panels 1–3, 9 and 10 first (near-zero new maths), then 4, 5 and 6. Leave
panel 8 (realised vs unrealised FX) for last — it is the only genuinely new
money maths and carries the highest rule-violation risk.

Worth adopting alongside: Portseido's **TWR-beside-MWR** framing ("the return
your decisions produced" vs "includes the effect of contributions") and its
two documented cash-currency modes, which are a clean model for explaining this
app's own currency rule to its single user.

### 6.4 The holding deep-dive (§5.1b)

Promote it to a **route** (`/holdings/:id`, confirmed low-friction) with a
`GET /holdings/{id}/detail` endpoint, and fix the phone duplication where the
same 11-field list renders twice. Then multi-window returns and
volatility/drawdown. Lots and per-holding 1D/1W come after, with the caveats in
§5.1b.

### 6.5 Sequencing constraint

🚩 **Enriching the instrument master (§2.1) gates roughly half of §5.4a** —
sector/country allocation, ETF look-through, and fund-type logic all need it.
If any of those matter for v7, that unglamorous data work is the first
dependency, not an afterthought.

Two cheap escapes from that dependency, both confirmed in §5.4f:

- **Currency as an allocation dimension** needs no enrichment at all
  (`native_currency` already exists) and is the most relevant dimension for
  this owner. Already listed in §6.1.
- **One new column, `tax_withheld_native`, unlocks two features**: withholding
  tax by year and country with a refund estimate (the recommended *first* tax
  feature, ahead of Vorabpauschale) and net-of-withholding dividend income.

### 6.6 Health items worth doing alongside

Backfill `repositories/` tests (8 files for 19 sources — the layer where bugs
go silent); smoke-test the 9 untested UI primitives and `TransactionForm.tsx`;
install `@vitest/coverage-v8`; verify whether
`backend/tests/{installer,parity,e2e}/` actually run; confirm the
`ui/pages/_*_query.py` → `readmodels/` migration happened, since the `ui/`
deletion is gated on it.

---

## 7. Decisions needed from the owner

1. **Amend the v6 plan's Phase 5?** `v6_one_app_plan.md:308-311` specifies a
   tool-calling LLM chat assistant, which **cannot** satisfy the stated privacy
   constraint (§5.3a). Replace it with a push-a-redacted-payload summariser?
2. **Include whole-portfolio XIRR/TWR in the LLM payload?** Argued yes — they
   are dimensionless and make the summary honest (§5.3e). Agree?
3. **The weights trade-off** (§5.3f) — UI-side mitigation only (recommended),
   or coarse weight buckets in the payload?
4. **Ticker disclosure** (§5.3h) — accept that any news-by-ticker query
   discloses the holdings list to a third party on a schedule?
5. **Lots: tranche history, or real FIFO cost basis?** (§5.1b) The first is
   cheap and cosmetic; the second touches every return number in the app and
   needs a parity run. Recommended: tranche history, clearly labelled.
6. **Does the German tax / sector-allocation direction matter for v7?** If yes,
   enriching the instrument master (§2.1) becomes the first dependency.
7. **Finish the missing research?** Specifically the page-by-page UI audit
   (§4) and the OpenRouter verification (§5.3i).
8. **Cutover timing** — the ~90k-line v5 deletion still waits on approval and a
   parallel-run week.

---

## 8. Changelog and release status

**Not done.** This document is a docs-only addition and would belong under
`[Unreleased]` per AGENTS.md. No `CHANGELOG.md` entry has been added, no
version bumped, nothing committed. Do that when the plan is finished and real.
