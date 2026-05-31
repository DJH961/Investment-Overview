# Investment Dashboard — Requirements and Project Overview

A single-user, locally-hosted, Python-based investment tracking dashboard that unifies brokerage positions at Vanguard and Fidelity with a German savings account (Direct Savings (Tagesgeld)), exposes a rich set of return metrics (XIRR, TWR, CAGR, etc.) in both USD and EUR, and allows every operation through a web UI accessible from the host laptop as well as any device on the same Wi-Fi network.

This document is written so that an engineer with no access to the original `Investments.xlsx` source spreadsheet can fully implement the system.

---

## 1. Goals and Non-Goals

### 1.1 Primary goals

1. Replace a hand-maintained Excel spreadsheet with a queryable, auditable, version-controlled system whose ground truth is a transaction ledger.
2. Compute, per holding and at the portfolio level: total return %, CAGR, XIRR, TWR, YTD variants of all of the above, plus simple period-bound growth rates.
3. Provide simultaneous USD and EUR views, with every USD cashflow converted to EUR at the spot rate of the transaction date.
4. Allow ingestion via (a) broker CSV imports, (b) manual entry through the UI, (c) automated price refresh via market data API, including near-real-time intraday quotes during market hours so the user can watch positions move.
5. Provide an investment-calculator workflow: "I have €X cash to allocate; given my current holdings and target allocation, how many shares of each ticker should I buy?"
6. Be accessible from the user's phone over local Wi-Fi without paid hosting.
7. Be red-green-colorblind-safe in every chart, table heatmap, and status indicator.

### 1.2 Non-goals

1. No multi-user, no authentication beyond binding to the local network.
2. No tax-lot accounting for capital-gains tax purposes (current spreadsheet doesn't do this; out of scope unless explicitly added later).
3. No trading execution — read-only with respect to brokers.
4. No mobile-native app — responsive web UI accessed via the phone's browser.

### 1.3 Constraints

- $0 hosting budget. Runs locally on the user's laptop (Windows, with Python).
- Single user. No need for auth, RBAC, or encryption beyond OS-level disk encryption.
- Source data:
  - Fidelity brokerage CSV export (up to 5 years of history; covers March 2023 onward).
  - Vanguard brokerage CSV export (limited to past 18 months — older history must be entered manually or migrated from the old spreadsheet only where strictly needed).
  - Direct Savings (Tagesgeld): manual entry of deposits, withdrawals, and monthly interest credits.

---

## 2. Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Language | Python ≥ 3.12 | User preference; numerical-Python ecosystem. |
| Web UI framework | **NiceGUI** (≥ 2.x) | FastAPI under the hood; event-driven (no Streamlit rerun); supports tables, forms, charts, multi-page; binds to `0.0.0.0` trivially; Quasar/Tailwind components built in. |
| Charting | **Plotly** (interactive) embedded in NiceGUI via `ui.plotly` | Better tooltips/zoom than matplotlib; honors custom colorblind palettes. |
| Tables | NiceGUI `ui.aggrid` (AG-Grid Community) | Sort, filter, inline edit, large datasets; matches the spreadsheet feel. |
| ORM / DB | **SQLAlchemy 2.x** + **SQLite** (ledger / config / cache tiers; WAL locally, TRUNCATE in cloud-sync folders) | Single-user, zero-config; the ledger tier is the file to back up. Tiers can be split across local + cloud-sync locations. |
| Migrations | **Alembic** | Schema evolution discipline. |
| Market data | **yfinance** | Free; covers all current tickers (VTI, VOO, VUG, VTV, VXUS, VGK, VT, VWO, SCHK, IAUM, MSFT, FXAIX, FSKAX, FSPSX, FTIHX, SCHD, FSELX, plus the Global X DAX Germany ETF, ticker `DAX`, NASDAQ-listed). |
| FX rates | **Frankfurter API** (`https://api.frankfurter.dev`) | Free, no key, ECB-sourced, full historical daily series since 1999. |
| Date handling | Python stdlib `datetime` + `zoneinfo` | Avoid pendulum. |
| Numerics | `numpy`, `pandas`, `scipy.optimize.brentq` (XIRR solver) | Standard. |
| Testing | `pytest`, `hypothesis` (property tests for return math) | XIRR/TWR math needs property tests. |
| Packaging | `pyproject.toml` + **uv** (preferred) or Poetry | Fast resolver, lockfile, reproducible. |
| Lint / format | `ruff` (lint + format), `mypy --strict` on `domain/` | Strict typing on the financial-math layer only. |
| CI | GitHub Actions: lint, type-check, test on push/PR | Free for personal repos. |
| Process management | `uvicorn` (auto-started by NiceGUI) | Single command launch. |

---

## 3. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  NiceGUI app (FastAPI + Quasar)                             │
│  bind: 0.0.0.0:8080                                         │
│                                                              │
│  Pages: /overview /deposits /transactions /monthly          │
│         /yearly /analytics /projection /calculator          │
│         /settings                                           │
└──────────────────────┬──────────────────────────────────────┘
                       │
   ┌───────────────────┼───────────────────────────────┐
   │                   │                               │
   ▼                   ▼                               ▼
┌────────────┐  ┌──────────────────┐         ┌──────────────────┐
│ services/  │  │ domain/          │         │ adapters/        │
│ orchestrate│  │ pure math:       │         │ external IO:     │
│ use-cases  │  │ XIRR, TWR,       │         │ - yfinance       │
│            │  │ CAGR, allocation │         │ - frankfurter    │
│            │  │ math, drawdown   │         │ - csv parsers    │
└─────┬──────┘  └──────────────────┘         │   (vg, fid)      │
      │                                       └────────┬─────────┘
      ▼                                                │
┌────────────────────┐                                 │
│ repositories/      │◄────────────────────────────────┘
│ SQLAlchemy session │
└─────────┬──────────┘
          ▼
   ┌──────────────────────────────────────────────┐
   │ SQLite tiers: ledger · config · cache        │
   │ (cache stays device-local; ledger/config may │
   │  live in a cloud-sync folder)                │
   └──────────────────────────────────────────────┘
```

Layering rules:

- `domain/` contains pure functions: no DB, no HTTP, no I/O. Easy to property-test.
- `adapters/` wraps every external thing (yfinance, Frankfurter, broker CSVs). One module per provider. Each adapter returns plain dataclasses, never ORM models.
- `repositories/` is the only layer that touches the DB. Returns and accepts ORM models.
- `services/` orchestrates use-cases by composing domain + adapters + repos. The UI layer only calls services, never reaches into repos or adapters directly.
- `ui/` (NiceGUI pages and components) is thin: read user input, call a service, render result.

---

## 4. Data Model

All monetary amounts are stored as `NUMERIC(18, 6)` in SQLite (`String`-backed via `sqlalchemy.types.Numeric`) to avoid float drift. Dates are stored as `DATE` (no time-of-day; brokers report at day granularity).

### 4.1 Tables

#### `accounts`
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| broker | TEXT NOT NULL | enum: `vanguard`, `fidelity`, `savings_bank` |
| account_label | TEXT NOT NULL | e.g. "Vanguard Brokerage" |
| native_currency | CHAR(3) NOT NULL | `USD` or `EUR` |
| account_type | TEXT | `brokerage`, `savings`, `cash` |
| opened_on | DATE | |
| notes | TEXT | |

(Schema supports multiple accounts per broker even though user currently has one each — cheap to add now, painful to retrofit.)

#### `instruments`
| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| symbol | TEXT UNIQUE NOT NULL | yfinance ticker; e.g. `VTI`, `FXAIX`, `EXS1.DE`. For Savings cash, a synthetic `SAVINGS_CASH`. |
| name | TEXT | "Vanguard Total Stock Market ETF" |
| asset_class | TEXT | enum: `etf`, `mutual_fund`, `stock`, `cash`, `savings` |
| category | TEXT | e.g. "Total US", "S&P500", "Growth", "Value", "International", "Euro", "World", "Emerging", "Gold", "Holding/Uninvested", "DAX" |
| native_currency | CHAR(3) | `USD`, `EUR` |
| expense_ratio | NUMERIC(7,5) | annual; e.g. `0.0003` for VTI |
| target_weight_pct | NUMERIC(5,2) | optional; per the user's allocation plan (see §8.6) |
| active | BOOLEAN | soft-delete |

#### `transactions`
The unified ledger. **Every** position change, dividend, and cash movement is one row.

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| account_id | INTEGER FK → accounts.id | |
| date | DATE NOT NULL | trade date |
| settlement_date | DATE | optional |
| kind | TEXT NOT NULL | enum below |
| instrument_id | INTEGER FK → instruments.id | NULL only for cash-only movements |
| quantity | NUMERIC(18,8) | shares; positive for inflow into portfolio (buy, dividend reinvested), negative for sell |
| price_native | NUMERIC(18,6) | price per share in instrument's native currency |
| gross_native | NUMERIC(18,6) | quantity × price, signed (negative = cash outflow into position) |
| fees_native | NUMERIC(18,6) | commissions + SEC/TAF fees |
| net_native | NUMERIC(18,6) | gross + fees, the cash leg |
| fx_rate_to_eur | NUMERIC(12,8) | EUR per 1 unit of `account.native_currency` on this date |
| net_eur | NUMERIC(18,6) | net_native × fx_rate_to_eur, redundant but cached |
| description | TEXT | raw broker description |
| external_id | TEXT | broker-supplied or hash; for dedup on re-import |
| source | TEXT | enum: `import_vanguard_csv`, `import_fidelity_csv`, `manual`, `migration` |
| created_at | TIMESTAMP DEFAULT CURRENT_TIMESTAMP | |
| UNIQUE(account_id, external_id) WHERE external_id IS NOT NULL | | dedup |

##### `kind` enum
- `buy` — position increases, cash decreases.
- `sell` — position decreases, cash increases.
- `dividend_cash` — cash dividend; cash increases; no position change.
- `dividend_reinvest` — dividend that becomes new shares same day; net_native = 0; quantity > 0; price = the reinvestment price. This matches the current spreadsheet's "X" flag.
- `deposit` — external cash in (e.g. wire from German bank to Fidelity, or to Savings). `instrument_id` NULL.
- `withdrawal` — external cash out. `instrument_id` NULL.
- `interest` — bank interest credited (Savings). `instrument_id` NULL.
- `fee` — standalone fee. `instrument_id` NULL.
- `transfer_in` / `transfer_out` — for inter-account or in-kind moves; out of scope v1 but reserved.
- `split` — stock split adjustment; quantity = new shares minus old; price = 0; net = 0.

##### Sign conventions
For a `buy`: `quantity > 0`, `net_native < 0`. For `dividend_reinvest`: `quantity > 0`, `net_native = 0`. For `deposit`: `quantity = NULL`, `net_native > 0`. For `interest`: `quantity = NULL`, `net_native > 0`. This sign convention makes the cashflow stream for XIRR straightforward: XIRR uses `-net_native` from the user's perspective (deposits/buys are negative cashflow from outside the portfolio... see §6.2 for the canonical sign rules).

#### `price_history`
Per-instrument price history in the native currency: one row per (instrument, date). For ETFs and stocks the latest row's close refreshes every couple of minutes during market hours (live intraday price); mutual-fund NAVs update about once a day.

| Column | Type |
|---|---|
| instrument_id | INTEGER FK |
| date | DATE |
| close_native | NUMERIC(18,6) |
| source | TEXT — `yfinance`, `manual` |
| PRIMARY KEY (instrument_id, date) | |

For Savings Cash, store the daily balance as the "price" (and quantity = 1), so it composes uniformly with positions.

#### `fx_history`
| Column | Type |
|---|---|
| date | DATE |
| base | CHAR(3) — always `EUR` |
| quote | CHAR(3) — `USD`, others later |
| rate | NUMERIC(12,8) — quote-per-base |
| source | TEXT — `frankfurter`, `manual` |
| PRIMARY KEY (date, base, quote) | |

Convention: store as `EUR→USD` (i.e. how many USD = 1 EUR). To convert a USD amount to EUR: `eur = usd / rate`.

#### `target_allocations`
| Column | Type |
|---|---|
| id | INTEGER PK |
| name | TEXT — e.g. "Default", "Aggressive 2026" |
| active | BOOLEAN — only one active at a time |
| created_at | TIMESTAMP |

#### `target_allocation_items`
| Column | Type |
|---|---|
| target_allocation_id | FK |
| instrument_id | FK |
| weight_pct | NUMERIC(5,2) — must sum to 100 per allocation |
| PRIMARY KEY (target_allocation_id, instrument_id) | |

(Keep the active-allocation pattern instead of stuffing `target_weight_pct` on `instruments` directly, so the user can iterate on allocations over time without losing history.)

#### `snapshots`
Daily portfolio-level closing values, pre-computed for the Growth/Yearly views so monthly graphs don't recompute on every page load. Implemented as a write-through cache in the cache tier (`models/position_snapshot.py`).

#### `app_config`
Key-value table for user-configurable settings (default base currency display, preferred broker for new transactions, last imported file checksum, etc.).

### 4.2 Derived views (SQL views or materialized in Python)

| Name | Definition |
|---|---|
| `v_positions_today` | For each (account, instrument), sum of quantity to date; current price from `price_history`; current native value; current EUR value. |
| `v_cashflows_xirr` | All `transactions` with the signed cashflow used by the XIRR solver, plus a synthetic final row `(today, -current_total_value)`. |
| `v_monthly_balance` | One row per month per account: starting balance, contributions, dividends, closing balance, EUR-equivalent. |

---

## 5. Data Ingestion

### 5.1 Fidelity CSV importer

Source: Fidelity → Accounts & Trade → Activity & Orders → History → Download.

Expected columns (order may vary slightly; importer must match by header name, case-insensitive, whitespace-stripped):

```
Run Date, Action, Symbol, Description, Type, Quantity, Price ($),
Commission ($), Fees ($), Accrued Interest ($), Amount ($),
Cash Balance ($), Settlement Date
```

#### Mapping rules

| Fidelity `Action` substring (uppercase) | Mapped `kind` | Notes |
|---|---|---|
| `YOU BOUGHT` | `buy` | quantity from `Quantity`, price from `Price ($)`, net = `Amount ($)` (negative). |
| `YOU SOLD` | `sell` | quantity negative; net positive. |
| `REINVESTMENT` | `dividend_reinvest` | `Amount ($)` ≈ 0; quantity > 0; price from `Price ($)`. |
| `DIVIDEND RECEIVED` | `dividend_cash` | quantity = 0; net positive. |
| `INTEREST EARNED` | `interest` | |
| `ELECTRONIC FUNDS TRANSFER RECEIVED` / `EFT FUNDS RECEIVED` | `deposit` | |
| `ELECTRONIC FUNDS TRANSFER PAID` / `EFT FUNDS PAID` | `withdrawal` | |
| `FOREIGN TAX PAID` / `FEE` | `fee` | net negative. |

The mapping table must live in `adapters/fidelity/action_map.py` and be unit-tested with known input rows. Unmapped actions raise a `UnknownActionError` rather than silently swallowing the row.

#### Deduplication
Generate `external_id = sha256(f"{run_date}|{action}|{symbol}|{quantity}|{price}|{amount}")`. The `UNIQUE(account_id, external_id)` constraint blocks duplicate imports.

#### Price granularity caveat
Fidelity changed in May 2024 to report `Price` to 2 decimals instead of 4. Importer must recompute `price_native = abs(amount - fees) / quantity` when quantity > 0 and use that for `price_native`; keep the CSV's price in `description` for audit.

### 5.2 Vanguard CSV importer

Source: Vanguard → Activity → Download Center → "A spreadsheet-compatible CSV file" → date range (max 18 months).

Expected columns (brokerage account):

```
Account Number, Trade Date, Settlement Date, Transaction Type,
Transaction Description, Investment Name, Symbol, Shares, Share Price,
Principal Amount, Commission Fees, Net Amount, Accrued Interest, Account Type
```

(Vanguard occasionally tweaks this; importer must be tolerant of missing trailing columns.)

#### Mapping rules

| Vanguard `Transaction Type` | Mapped `kind` |
|---|---|
| `Buy` | `buy` |
| `Sell` | `sell` |
| `Reinvestment` | `dividend_reinvest` |
| `Dividend` (cash) | `dividend_cash` |
| `Funds Received` / `Transfer (incoming)` | `deposit` |
| `Funds Withdrawn` | `withdrawal` |
| `Sweep In` / `Sweep Out` | ignored (internal sweep to/from VMFXX, double-counts cash); UI should display a count of skipped rows |
| `Fee` | `fee` |

#### Sweep handling
Vanguard generates `Sweep In/Out` rows when cash moves between the settlement fund (VMFXX) and the brokerage cash core. These are accounting artifacts and must not be turned into transactions, or every buy will appear twice. The reference is the underlying `Buy` row, which already captures the position change.

#### 18-month limitation
Document this loudly in the importer UI: "Vanguard only allows the last 18 months. For earlier history, use the Manual Entry tab or the legacy-migration utility."

### 5.3 Manual entry (in-UI)

For Savings Bank, pre-2024 Vanguard data, and one-off corrections. A modal form at `/transactions → + New`:

- Account selector (filtered by broker).
- Kind selector (drives which fields show).
- Date.
- Instrument selector (autocomplete; only required for buy/sell/dividend_reinvest).
- Quantity, price, fees (with live-computed net), or net (for cash kinds).
- Optional description.

Validation rules:
- `buy`/`sell`/`dividend_reinvest` require `instrument_id`, `quantity`, `price_native`.
- `dividend_reinvest` requires `net_native ≈ 0` (tolerance: ±0.05).
- `deposit`/`interest`/`withdrawal`/`fee` require only `net_native`.
- `account.native_currency` determines whether the user is entering USD or EUR amounts; FX is fetched automatically from `fx_history` for that date.

### 5.4 Legacy migration utility (one-shot)

Goal: re-populate transactions from March 27, 2023 forward without manually retyping every row.

Per the user, the existing `Investments.xlsx` is partially inaccurate. So strategy is:

1. **Trust the broker CSVs as primary truth** wherever they reach (Fidelity to 2023; Vanguard last 18 months).
2. **For Vanguard data older than the CSV cutoff**, optionally import from a stripped-down CSV that the user pre-cleans from the spreadsheet's `Lots` sheet, with the columns: `date, symbol, quantity, price, dividend_flag, description`. Source = `migration`.
3. Manually verify each holding's total share count after migration against the broker's current "Positions" page. Build a `/migration/verify` page showing per-symbol totals from the DB next to manually entered "expected" totals.

### 5.5 Market data fetcher

`adapters/yfinance_client.py`:

- Fetches daily closes for all `active` instruments since the earliest holding date.
- Runs on app start, and on demand via a "Refresh prices" button in `/settings`.
- Should batch via `yf.download(['VTI','VOO',...], start=..., auto_adjust=False)`. **`auto_adjust=False`** is critical: we want raw close prices because dividends are tracked separately in our ledger; auto-adjusted closes would double-count them.
- Stores into `price_history` with idempotent upsert.
- Handles weekends/holidays (no row written; "today's price" logic falls back to the latest available close).
- Failure mode: if yfinance throws, log a warning and continue with stale prices. The UI surfaces "Prices last refreshed: <timestamp>" in the footer.

The DAX-tracking ETF is the **Global X DAX Germany ETF**, yfinance ticker `DAX` (NASDAQ-listed, USD). A setting in `/settings` maps a friendly name to a yfinance ticker, and onboarding offers a validated ticker path.

### 5.6 FX fetcher

`adapters/frankfurter_client.py`:

- Endpoint: `GET https://api.frankfurter.dev/v2/rates?from={start_date}&base=EUR&quotes=USD`.
- On every transaction insert, ensure the date's rate exists; backfill if missing.
- Daily cron-style refresh at app start: fetch rates from `last(date in fx_history) + 1` to today.
- Frankfurter updates daily ~16:00 CET on business days; weekends inherit Friday's rate.
- Failure mode: if the API is unreachable, use the most recent prior rate and flag the transaction with `fx_rate_source = 'inherited'` (optional column for v1.1; for v1, just log).

---

## 6. Domain logic — financial math

All formulas below must be implemented in `domain/returns.py` as pure functions taking lists/arrays as inputs (no DB, no I/O). They must each be covered by ≥ 5 unit tests including known-answer tests against Excel's `XIRR` and `IRR` functions for the user's existing data.

### 6.1 Total return (simple)

For a single holding over a window `[t0, t1]`:

```
total_return = (current_value + cumulative_dividends_received - total_cost_basis) / total_cost_basis
```

`total_cost_basis = sum(buy_net) - sum(sell_proceeds_attributable_to_remaining_shares)`. Since the user does not sell, the basis simplifies to `sum(buy_net) + sum(dividend_reinvest_share_value_at_reinvest_price)`.

Spreadsheet parallel: column `AE` ("Performance Gain") in the `Lots` sheet.

### 6.2 XIRR

The internal rate of return on an irregular cashflow stream. Solve for `r` such that:

```
0 = Σ_i  cf_i × (1 + r) ^ ((t_today - t_i) / 365.0)
```

Where the cashflow stream consists of:
- For each `buy`: `cf = -|net_native|`, dated `transaction.date`.
- For each `dividend_cash`: `cf = +net_native`, dated `transaction.date` (the cash leg; for reinvested dividends, the cashflow is zero, and the share addition is captured by the final mark-to-market).
- For each `sell`: `cf = +net_native`.
- A final synthetic row: `cf = +current_market_value, t = today`.

Solver: `scipy.optimize.brentq` on `npv(r) = Σ cf × (1+r)^...` with bracket `[-0.99, 10.0]`. Fallback to `scipy.optimize.newton` if Brent fails (rare). Handle the degenerate case (all cashflows same sign — typically only at portfolio inception before any value has accrued) by returning `None`.

XIRR variants needed:
- Per-instrument XIRR (uses only that instrument's buys/sells/reinvests + that instrument's current value).
- Portfolio XIRR (all transactions across all accounts; current value = sum of all positions + cash balances).
- YTD XIRR: synthetic opening row at Jan 1 of current year with `cf = -value_at_start_of_year`; final row = `cf = +current_value, t = today`; plus all cashflows during the year.

Spreadsheet parallel: `Lots!AI:AJ` and `Total!H:I`.

### 6.3 TWR (time-weighted return)

Removes the effect of cashflow timing — the right metric for evaluating investment selection independent of when the user happened to deposit.

Implementation: split the timeline into sub-periods bounded by cashflow events. For each sub-period:

```
sub_period_return = (V_end_before_cashflow - V_start_after_cashflow) / V_start_after_cashflow
```

Chain:

```
TWR = ∏(1 + sub_period_return_i) - 1
```

For sub-period returns to be accurate, the system must know `V_end` and `V_start` at each cashflow boundary. Two implementations are acceptable:

- **Daily-snapshot TWR (correct)**: requires daily portfolio valuation. Compute by replaying transactions in chronological order, marking to market daily, and grouping daily returns into the TWR product. Use this for the portfolio-level TWR.
- **Per-transaction TWR (approximate, what the spreadsheet does)**: at each transaction row for an instrument, compute period return as `(new_price × prior_share_count - prior_TVPT) / prior_TVPT`, where `TVPT` (Time Value of Prior Transactions) is the previous share count × current price. This is fast and matches the current spreadsheet's column `M`/`N` math. Use this for per-instrument TWR if daily-snapshot is too expensive.

Annualized TWR:

```
twr_annualized = (1 + TWR) ^ (365 / days_in_window) - 1
```

YTD TWR uses Jan 1 to today as the window.

Spreadsheet parallel: `Lots!AK:AL`.

### 6.4 CAGR

```
CAGR = (V_end / V_start) ^ (1 / years) - 1
```

Where `V_start = total_cost_basis` for the position's first-purchase-to-today, and `years = days / 365.25`. Distinct from TWR — CAGR is a money-weighted compound return; TWR is time-weighted. Expose both.

### 6.5 Growth rate variants

Per the user's request to "expand XIRR to growth rates":

- **Total simple growth %**: `(V_today - cumulative_contributions) / cumulative_contributions` (the "How much more do I have than I put in" number — corresponds to spreadsheet's `Lots!AH`).
- **YTD growth %**: same but restricted to year-bounded contributions and starting from Jan-1 value.
- **MTD growth %**: month-to-date variant.
- **Rolling 1-yr / 3-yr growth**: same calculation over a sliding window.

### 6.6 Volatility, Sharpe, Sortino, max drawdown (extended metrics)

Per the user's "I would love to expand my analysis with further helpful metrics":

- **Annualized volatility**: stdev of daily portfolio log returns × √252.
- **Sharpe ratio**: `(annualized_return - risk_free_rate) / annualized_volatility`. Risk-free rate configurable in `/settings`, default = current ECB main refinancing rate (auto-fetched, fallback to 3.5%).
- **Sortino ratio**: same as Sharpe but using downside deviation only.
- **Max drawdown**: largest peak-to-trough decline over the period.
- **Best month / worst month**.
- **Win rate**: % of months with positive return.
- **Beta vs benchmark**: covariance of portfolio returns with VOO (S&P 500), normalized.
- **Alpha vs benchmark**: regression intercept.

Every metric in §6.6 has a tooltip in the UI explaining it in plain English (see §10).

### 6.7 Currency conversion

For every transaction with `account.native_currency = USD`:

```
net_eur = net_native / fx_rate_eur_to_usd_on_that_date
```

For aggregated portfolio EUR value:

```
eur_value_today = USD_position_value × (1 / fx_today_eur_to_usd) + EUR_position_value
```

EUR-denominated returns are computed using the EUR cashflow stream (each USD cashflow → EUR at its own date's rate). This produces FX-aware XIRR/TWR, which materially differs from converting only the endpoints — the spreadsheet does this correctly (columns `AM`/`AN`/`AO`), and the new system must preserve that property.

### 6.8 Target-allocation rebalancing math

Given:
- `cash_to_invest`: a number in EUR.
- Active target allocation: `{instrument_id → target_weight_pct}` summing to 100.
- Current holdings: `{instrument_id → current_eur_value}`.

Compute:
```
total_after = current_total + cash_to_invest
target_eur[i] = total_after × target_weight_pct[i] / 100
gap_eur[i] = max(0, target_eur[i] - current_eur_value[i])
```

If `sum(gap_eur) > cash_to_invest`, scale gaps proportionally so they sum to exactly `cash_to_invest` (purchase plan only adds cash, never sells to rebalance, by default). If `sum(gap_eur) < cash_to_invest`, the remainder is added to instruments in proportion to target weights.

Output rows:
| Symbol | Target % | Current % | Current EUR | Add EUR | Add Shares (rounded down) |

"Add Shares" uses `floor(add_eur / current_price_eur)`. Show the residual unallocated cash. Provide a "Allow fractional shares" toggle that uses `round(_, 4)` instead.

Spreadsheet parallel: `Total!P:T` columns, but cleaner.

---

## 7. Background and Scheduled Tasks

- On app start:
  1. Run Alembic migrations.
  2. Refresh FX history (incremental).
  3. Refresh price history (incremental).
  4. Recompute today's `v_positions` cache.
- On user-triggered "Refresh" button: same as above but forced.
- No background scheduler in v1 (it's a single-user desktop app — refresh-on-launch is sufficient). v1.1 may add APScheduler for daily 18:00 local refreshes if the app is left running.

---

## 8. User Interface — Pages

NiceGUI structure: a left-hand sidebar with the seven pages below. Header strip shows current portfolio value (USD + EUR) and price-refresh timestamp.

### 8.1 `/overview` — Main Overview

The home/landing page. One screen of vital signs.

**Top KPI strip** (4 cards):
1. **Total Value** — large USD value, smaller EUR underneath.
2. **Total Gain** — absolute USD/EUR and % since inception. (Colorblind palette: blue=gain, orange=loss; never green/red.)
3. **XIRR** — portfolio XIRR % annualized; tooltip on hover.
4. **YTD Growth** — YTD growth %; tooltip.

**Per-instrument table** (using `ui.aggrid`):

| Symbol | Name | Category | Shares | Avg Price | Current Price | Cost Basis (USD) | Current Value (USD) | Current Value (EUR) | Total Growth % | XIRR | TWR | YTD Growth | YTD XIRR | Target % | Current % | Drift |

Drift = current% − target%, shown as a small horizontal bar (left = under-allocated, right = over-allocated).

**Bottom**: one chart, allocation-pie or treemap, by `category`. Treemap preferred — it scales better visually and is the user's existing mental model.

### 8.2 `/deposits`

List of every `deposit`, `withdrawal`, and `interest` transaction across all accounts.

**Table** columns:
| Date | Account | Kind | Amount Native | Currency | Amount EUR | Comment | Actions (edit/delete) |

**Summary cards** at top:
- Total contributed to date (USD, EUR).
- YTD contributions.
- MTD contributions.
- Interest received YTD (Savings Bank).

Replicates the existing `Deposits` sheet.

### 8.3 `/transactions`

Master ledger view — every row in `transactions`.

**Table** columns:
| Date | Account | Kind | Symbol | Qty | Price | Fees | Gross | Net | Net EUR | Source | Actions |

**Filters**: date range, account, instrument, kind, source. Quick-filter chips for "Buys only", "Dividends only", "This year".

**Actions**:
- `+ New Transaction` → modal form (see §5.3).
- `Import CSV` → file picker → broker selector → preview diff → confirm.
- Per-row: edit, delete (with confirmation; deletes are soft via an `archived_at` column for v1.1).

### 8.4 `/monthly` — Monthly Growth with Projection

> **Note (v2.8+):** the live `/monthly` and `/yearly` pages show historical
> performance only. The interactive forward **projection** has graduated to its
> own standalone `/projection` page (covering both the monthly and yearly
> forecasts described below).

**Table** (one row per month):
| Month | Starting Balance | Contributions | Dividends | Capital Gain | Total Gain | Growth % | Closing Balance | USD/EUR | Closing EUR | EUR Growth % |

**Chart**: stacked area or dual-axis line. Closing balance (line), monthly contribution (bars). Plotly, colorblind palette: blue (#0072B2), orange (#E69F00), sky (#56B4E9), bluish-green only for "tertiary" if needed.

**Projection rows** (shaded background, e.g. light gray) — extend N months into the future. Projection assumptions:
- Future monthly contribution = average of last 12 months' contributions.
- Future monthly growth rate = `((1 + portfolio_XIRR) ^ (1/12)) - 1`.
- Future dividends = trailing-12-month average per month.

A small "Projection Settings" expander lets the user override the assumed contribution and growth rate.

Spreadsheet parallel: `Growth` sheet.

### 8.5 `/yearly` — Yearly Growth with Projection

**Table** (one row per year, 2023–N):
| Year | Starting Balance | Gain/Loss | Growth % | Contributions | Dividends | Div Yield | Closing Balance | USD/EUR avg | Closing EUR | EUR Growth % |

**Chart**: bar chart of yearly closing balances with a line overlay of yearly XIRR.

**Hypothetical projection block** (matches the existing `Yearly` sheet's "HYPOTHETICAL!" section): a separate sub-table extending 5–10 years forward, with editable assumptions (`expected annual return %`, `expected annual contribution`, `expected dividend yield %`).

### 8.6 `/calculator` — Investment Calculator

Inputs:
- Cash to invest (number, default currency = EUR).
- Allocation: dropdown of saved target allocations.
- Toggle: "Allow fractional shares" (default off).
- Toggle: "Rebalance by selling over-allocated positions" (default off, v1.1).

Output: table from §6.8.

A bottom-row CTA: "Save as planned purchase" — writes rows to a `planned_transactions` table (deferred to v1.1; for v1, just display).

### 8.7 `/settings`

- Manage accounts (add/edit/disable).
- Manage instruments (add ticker, set category, set yfinance symbol if differs from display symbol, set expense ratio).
- Manage target allocations (create new, activate, edit weights — UI enforces weights sum to 100).
- Refresh prices / refresh FX buttons.
- Database backup/restore: "Export DB" downloads `db.sqlite`; "Import DB" replaces it.
- Display preferences: primary display currency (USD/EUR), date format, decimals.

---

## 9. Statistics catalog (single source of truth)

Implemented in `domain/returns.py`. Each function exposed in `/overview` and detail pages.

| Metric | Function | Inputs | Used in |
|---|---|---|---|
| Total Growth % | `total_growth_pct` | cashflows, current_value | Overview, Total table |
| YTD Growth % | `ytd_growth_pct` | cashflows YTD, value at YE prior, current value | Overview, Monthly |
| MTD Growth % | `mtd_growth_pct` | similar | Overview |
| Capital Gain (abs) | `capital_gain` | cashflows, current value | Overview, Yearly |
| XIRR | `xirr` | cashflow stream | Overview, per-instrument |
| YTD XIRR | `xirr` w/ synthetic Jan-1 start | | Overview |
| TWR | `twr` | daily values + cashflow dates | Overview, per-instrument |
| YTD TWR | `twr` w/ Jan-1 window | | Overview |
| CAGR | `cagr` | start value, end value, years | Per-instrument |
| Annualized Vol | `annualized_volatility` | daily return series | Overview (collapsible) |
| Sharpe | `sharpe_ratio` | daily returns, rf | Overview (collapsible) |
| Sortino | `sortino_ratio` | daily returns, rf | Overview (collapsible) |
| Max Drawdown | `max_drawdown` | daily equity curve | Overview (collapsible) |
| Best/Worst Month | `best_worst_month` | monthly returns | Yearly |
| Win Rate | `monthly_win_rate` | monthly returns | Yearly |
| Beta vs VOO | `beta` | portfolio + VOO daily returns | Overview (collapsible) |
| EUR variants | every above with `eur=True` | EUR cashflow stream | Anywhere a EUR badge is shown |

---

## 10. Tooltips and explanations

Each metric label in the UI is rendered with a `ui.tooltip` that fires on hover (desktop) and tap (mobile, NiceGUI handles this). Copy must be plain English, ≤ 3 sentences. Example library to ship:

- **XIRR**: "The annualized return that makes the value of all your contributions and withdrawals (each weighted by when they happened) sum to your current portfolio value. Best for portfolios with irregular deposits."
- **TWR**: "How much the investments themselves grew, ignoring when you happened to deposit money. Best for comparing to a benchmark."
- **CAGR**: "If your money had grown at a single constant rate from start to today, that rate. Simpler than XIRR but assumes one initial lump sum."
- **Max Drawdown**: "The biggest peak-to-trough drop the portfolio experienced — a measure of worst-case pain."
- **Sharpe ratio**: "Return per unit of total volatility above the risk-free rate. Higher is better; >1 is solid."
- **Sortino ratio**: "Like Sharpe but only penalizes downside volatility. Higher is better."

Copy lives in `ui/copy/tooltips.py` so updates don't touch component code.

---

## 11. Accessibility and color

**Hard requirement**: user is red-green colorblind (deuteranopia/protanopia category).

- **Never use red/green as the only signal** for gain/loss. Use **blue (#0072B2) for gain, orange (#E69F00) for loss**, plus directional arrows (↑/↓).
- Approved palette (Wong, 2011, colorblind-safe):
  - Black `#000000`
  - Orange `#E69F00`
  - Sky blue `#56B4E9`
  - Bluish green `#009E73`
  - Yellow `#F0E442`
  - Blue `#0072B2`
  - Vermillion `#D55E00`
  - Reddish purple `#CC79A7`
- Plotly: ship a single `colorblind_template.py` that registers a custom template; every chart sets `template="colorblind"`.
- AG-Grid heatmap cells: use blue↔orange gradient.
- Contrast: WCAG AA on all text-over-background.

---

## 12. Project structure

```
investment-dashboard/
├── pyproject.toml
├── uv.lock
├── README.md
├── requirements_and_project_overview.md     ← this document
├── alembic.ini
├── migrations/
│   └── versions/
├── src/
│   └── investment_dashboard/
│       ├── __init__.py
│       ├── main.py                     # NiceGUI entry point
│       ├── config.py                   # Pydantic settings; reads env + ~/.config/inv-dashboard/config.toml
│       ├── db.py                       # engine + session factory
│       ├── domain/
│       │   ├── __init__.py
│       │   ├── returns.py              # XIRR, TWR, CAGR, etc.
│       │   ├── allocation.py           # rebalance math
│       │   ├── currency.py             # FX conversion helpers
│       │   └── risk.py                 # Sharpe, Sortino, drawdown
│       ├── adapters/
│       │   ├── yfinance_client.py
│       │   ├── frankfurter_client.py
│       │   ├── fidelity/
│       │   │   ├── parser.py
│       │   │   └── action_map.py
│       │   └── vanguard/
│       │       ├── parser.py
│       │       └── transaction_map.py
│       ├── models/                     # SQLAlchemy ORM
│       │   ├── account.py
│       │   ├── instrument.py
│       │   ├── transaction.py
│       │   ├── price_history.py
│       │   ├── fx_history.py
│       │   └── target_allocation.py
│       ├── repositories/
│       │   ├── transactions.py
│       │   ├── instruments.py
│       │   └── ...
│       ├── services/
│       │   ├── ingest_csv.py
│       │   ├── refresh_market_data.py
│       │   ├── portfolio_metrics.py
│       │   └── rebalance.py
│       └── ui/
│           ├── pages/
│           │   ├── overview.py
│           │   ├── deposits.py
│           │   ├── transactions.py
│           │   ├── monthly.py
│           │   ├── yearly.py
│           │   ├── calculator.py
│           │   └── settings.py
│           ├── components/
│           │   ├── kpi_card.py
│           │   ├── positions_table.py
│           │   ├── chart_template.py     # Plotly colorblind template
│           │   └── tooltip_label.py
│           └── copy/
│               └── tooltips.py
└── tests/
    ├── domain/
    │   ├── test_xirr.py
    │   ├── test_twr.py
    │   └── test_allocation.py
    ├── adapters/
    │   ├── test_fidelity_parser.py     # fixtures: small CSV samples
    │   └── test_vanguard_parser.py
    └── e2e/
        └── test_overview_renders.py
```

---

## 13. Setup and run

```bash
# clone + setup
git clone git@github.com:<user>/investment-dashboard.git
cd investment-dashboard
uv sync
uv run alembic upgrade head

# launch (bound to 0.0.0.0 so the phone on the same Wi-Fi can reach it)
uv run python -m investment_dashboard.main
```

The app listens on `http://0.0.0.0:8080`. On the laptop, open `http://localhost:8080`. From a phone on the same Wi-Fi, open `http://<laptop-LAN-IP>:8080` (find the IP via `ipconfig` on Windows or `ifconfig`/`ip a` on Linux/macOS). Optional: set a static LAN IP for the laptop so the URL doesn't change.

Optionally: a Windows `.bat` file + a Task Scheduler entry to auto-start on login.

---

## 14. Roadmap

> **Historical (✅ delivered).** This phased plan is the *original* v1 build
> roadmap and is preserved for context. All of Phases 0–6 shipped long ago; the
> project is now at v2.9.4 with split storage, cloud-aware paths, optional
> encryption, intraday price refresh, a standalone projection page, and an
> analytics page. See `CHANGELOG.md` for the authoritative history.

### Phase 0 — scaffolding (≈ 1 weekend)
- Repo, pyproject, ruff/mypy/pytest config, Alembic init, empty migration.
- NiceGUI hello-world page on `0.0.0.0:8080`.
- CI passing on push.

### Phase 1 — data model and ingestion (≈ 2 weekends)
- Schema for accounts, instruments, transactions, price_history, fx_history.
- Frankfurter + yfinance adapters, on-start refresh.
- Manual `/transactions` CRUD page.
- Fidelity CSV importer + tests with real sample.

### Phase 2 — core metrics (≈ 2 weekends)
- `domain/returns.py` with XIRR/TWR/CAGR + unit tests (golden-set from existing spreadsheet).
- `domain/currency.py`.
- `/overview` page with positions table and KPIs.

### Phase 3 — Vanguard + Savings (≈ 1 weekend)
- Vanguard CSV importer.
- Savings manual entry flow.
- Migration utility for pre-2024 Vanguard data.

### Phase 4 — Monthly/Yearly/Calculator (≈ 2 weekends)
- `/monthly` with projection.
- `/yearly` with hypothetical block.
- `/calculator` with rebalance math.

### Phase 5 — Extended metrics + polish (≈ 1 weekend)
- Risk metrics (vol, Sharpe, Sortino, drawdown, beta).
- Tooltips everywhere.
- Colorblind audit pass.
- Mobile-responsive layout pass.

### Phase 6 (optional, v1.1)
- Daily snapshots table for fast historical queries.
- Savings PDF Kontoauszug parser.
- Planned-purchase persistence + execution-tracking.
- Stock-split handling.
- APScheduler for background daily refresh.

---

## 15. Open questions to resolve before Phase 0

> **Historical (✅ resolved).** These were the pre-build decisions; all have
> long since been settled in code. Kept for context.

1. **DAX ETF ticker.** Confirmed: the **Global X DAX Germany ETF**, yfinance ticker `DAX` (NASDAQ-listed, USD).
2. **Pre-2024 Vanguard data.** Two paths: (a) accept that the legacy spreadsheet's data is "good enough" for that window and import it via the migration utility, or (b) accept that Vanguard returns will be partial pre-cutoff. Recommendation: (a), with verification against current share counts.
3. **Risk-free rate source.** Hardcode 3.5%, or fetch ECB main refi rate? Recommendation: hardcoded for v1, configurable in settings.
4. **GitHub repo visibility.** Public (showcase, more contributions possible) or private (financial data context, even though the repo would contain no real data)? Recommendation: **private**; the code itself reveals nothing sensitive, but keeping it private avoids any temptation to commit a real DB file.
5. **License.** If public: MIT. If private: none required.

---

## 16. References

- **Vanguard CSV format**: Bogleheads thread on Vanguard transaction CSV columns (mutual fund vs brokerage); Vanguard Activity → Download Center; 18-month export cap documented across multiple TradeLog/Trademetria guides.
- **Fidelity CSV format**: `Run Date, Action, Symbol, Description, Type, Quantity, Price ($), Commission ($), Fees ($), Accrued Interest ($), Amount ($), Cash Balance ($), Settlement Date` — confirmed via Infinite Kind/Moneydance integration docs; 5-year history limit per TradeLog Fidelity guide. May-2024 price-decimal change documented in same source.
- **Frankfurter FX API**: `https://frankfurter.dev/` — free, open-source, ECB-sourced daily rates since 1999.
- **yfinance**: `auto_adjust=False` semantics — raw close vs split/dividend-adjusted close.
- **Colorblind palette**: Wong, B. (2011). "Color blindness." *Nature Methods* 8, 441.
- **NiceGUI**: `https://nicegui.io` — FastAPI-based, single-process Python web UI.
- **TWR vs XIRR conceptual distinction**: CFA Institute curriculum, "Money-weighted vs Time-weighted Return."
