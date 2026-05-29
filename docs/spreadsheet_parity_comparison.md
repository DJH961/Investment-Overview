# Spreadsheet ↔ Dashboard Parity Comparison

This document compares the original source spreadsheet
(`docs/Comparison Files/Investments.xlsx`) — the model the whole project is
built from — against the **current dashboard implementation**, and lists,
constructively, what still needs to be added so the dashboard reaches feature
parity with the spreadsheet.

Scope rule (per the request): functionality that exists in the spreadsheet but
is **missing or incomplete** in the dashboard is called out below. Functionality
the dashboard adds *beyond* the spreadsheet (e.g. the whole `/analytics` page:
Sharpe/Sortino/Calmar/Ulcer, VaR/CVaR, skew/kurtosis, beta/alpha, attribution,
benchmark equity curve) is intentionally **out of scope** and ignored here.

---

## 1. The spreadsheet at a glance

The workbook has seven sheets:

| Sheet | Purpose | Dashboard counterpart |
|---|---|---|
| **Total** | Per-instrument return grid + portfolio KPI block + embedded rebalance calculator | `/overview` + `/calculator` |
| **Deposits** | Cash-movement ledger + Start/Total/YTD/MTD roll-ups | `/deposits` |
| **Lots** | Per-lot transaction ledger + per-ETF aggregation engine (the maths behind `Total`) | `/transactions` + `services` |
| **Growth** | Month-by-month balance / gain / growth history | `/monthly` |
| **Yearly** | Year-by-year balance / gain / growth / div-yield history | `/yearly` |
| **Vanguard** / **Fidelity** | Per-broker buy-amount / share-count planners | `/calculator` |

The dashboard already covers the **shape** of every sheet. The gaps are in the
**columns/metrics within** the Overview, Monthly and Yearly views, plus a few
portfolio-level KPIs.

---

## 2. Sheet-by-sheet parity

### 2.1 `Total` → `/overview`

The spreadsheet's `Total` sheet has, **for every instrument**, a wide row of
return metrics (columns A–N) plus a portfolio KPI block (rows 15–23) and an
embedded "theoretical investment / missing-for-%" calculator (columns P–T).

**Per-instrument columns in the spreadsheet:**

| Col | Metric | In dashboard? |
|---|---|---|
| Symbol | ticker | ✅ |
| Stock/ETF/Mutual Fund | name | ✅ |
| Type | category | ✅ |
| Price | latest close | ✅ |
| Expense | expense ratio | ✅ shown as the `Expense` column in the positions grid |
| Amount | shares | ✅ |
| **TG** | total growth % (USD, dividend-inclusive) | ✅ `total_growth_pct` is now dividend-inclusive (`current_value + dividends − cost`) |
| **XIRR** | per-instrument money-weighted return | ✅ `InstrumentMetrics.xirr`, shown as the `XIRR` column |
| **TG YTD** | year-to-date total growth | ✅ `InstrumentMetrics.ytd_growth_pct`, shown as the `YTD Growth` column |
| **TWR** | per-instrument time-weighted return | ❌ |
| **YTD TWR** | YTD time-weighted return | ❌ |
| **€ TG** | total growth in EUR | ❌ (per-instrument EUR return not computed) |
| **€ YTD TG** | YTD total growth in EUR | ❌ |
| **Today** | 1-day price change % | ❌ |

**Portfolio KPI block (rows 15–23):**

| Spreadsheet KPI | In dashboard? |
|---|---|
| TOTAL VALUE | ✅ "Total Value" card |
| Profit (absolute gain) | ✅ "Total Gain" card |
| XIRR | ✅ "XIRR" card |
| Performance Growth / Total Growth % | ✅ shown as growth % under Total Gain |
| YTD Growth | ✅ "YTD Growth" card |
| **MTD profit / month-to-date growth** | ✅ `PortfolioMetrics.mtd_growth_pct`, shown as the "MTD Growth" card |
| **Capital Increase** (contribution delta) | ❌ as a headline |
| **Weighted expense ratio** (`SUMPRODUCT(expense, weight)`) | ✅ `PortfolioMetrics.weighted_expense_ratio`, shown on the "Expense Ratio" card |
| **Annual expense cost in €** (`Σ price·expense·amount`) | ✅ `PortfolioMetrics.annual_expense_cost_eur`, shown as the €/yr sub-line on the "Expense Ratio" card |
| **Beating / Losing the market** verdict | ✅ `MarketVerdict`, shown as the "Vs Market" card |
| **End-of-year portfolio value (2023/24/25)** | ❌ as discrete marks (history exists via snapshots, not surfaced) |

**Embedded calculator (cols P–T: Theoretical Investment / Missing for % / Investment shares):**
✅ Implemented as the standalone `/calculator` page (`plan_rebalance`).

### 2.2 `Deposits` → `/deposits`

| Spreadsheet feature | In dashboard? |
|---|---|
| Date / Amount (USD) / EUR / Comment ledger | ✅ |
| Year & Month bucketing | ✅ |
| Start / Total / per-broker / current-year roll-ups | ✅ |
| Uninvested cash balance | ✅ (cash-account balance) |
| Final balance last year | ✅ via period closing values |
| YTD contributions | ✅ `ytd_contrib_eur` |
| MTD contributions | ✅ `mtd_contrib_eur` |
| **MTD / YTD portfolio *profit*** (rows H8–K12: Profit/Perf-Growth/Total-Growth/Capital-Increase, both YTD and MTD) | ❌ only *contribution* roll-ups exist; the profit/performance roll-ups are missing |

> The `Deposits` sheet doubles as the spreadsheet's KPI engine (its H–N block
> feeds `Total`). The dashboard splits these between `/deposits` (contributions)
> and `/overview` (returns); the **MTD profit** and **Capital Increase** numbers
> fall through the cracks in both.

### 2.3 `Lots` → `/transactions` + services

The per-lot ledger (Date / Code / Amount / Price / Value / € Value / Dividend
flag / Cashflow) is fully represented by the `transactions` table and
`positions_service`.

The **per-ETF aggregation block** (cols Q–AW) is the spreadsheet's analytics
engine. Most outputs surface on `Total`, so the gaps are the same as §2.1, plus:

| Aggregation column | In dashboard? |
|---|---|
| Total Amount / Starting Investment / Total Cost Basis | ✅ (cost basis) |
| Cost Basis excl. Dividends | ⚠️ partial — cost basis includes reinvested dividends; the "excl. div" variant is not separated |
| Average Price | ✅ |
| **End of Year Value 2023 / 2024 / 2025** (per instrument) | ❌ |
| **Yearly Dividends / Total Dividends** (per instrument, incl. reinvested "X") | ⚠️ only `cumulative_dividends_cash` is tracked; reinvested-dividend totals per instrument are not surfaced |
| Capital Gain (`End − CostBasis + Dividends`) | ✅ dividend-inclusive capital gain is now the `Capital Gain (native)` column (`InstrumentMetrics.capital_gain_native`) |
| **Performance Gain** (`gain / starting investment`) | ❌ |
| **Percental Gain** (`gain / total cost basis`) | ❌ |
| **YTD Gain** (per instrument) | ❌ |
| Period Return / Log R+1 / TVPT (the TWR building blocks) | ✅ equivalent TWR maths exists in `domain/returns.py` (portfolio-level) — but **not run per instrument** |

### 2.4 `Growth` → `/monthly`

| Spreadsheet column | In dashboard? |
|---|---|
| Month/Year | ✅ |
| Starting Balance / Closing Balance | ✅ opening/closing value |
| Contribution | ✅ |
| Dividends | ✅ |
| Growth % | ✅ (Modified Dietz) |
| USD/EUR rate / € Growth / € Value | ✅ (display-currency FX-aware path) |
| **Total Gain** (`Closing − Start − Contribution`) | ⚠️ growth % is shown but the absolute total-gain € amount is not a column |
| **Capital Gain** (`Total Gain − Dividends`) | ❌ the capital-vs-total split is not shown |

### 2.5 `Yearly` → `/yearly`

| Spreadsheet column | In dashboard? |
|---|---|
| Year / Starting / Closing balance | ✅ |
| Gain/Loss / Growth % | ✅ growth %; ⚠️ absolute Gain/Loss € not a column |
| Contribution / Dividends | ✅ |
| **Div Yield** (`Dividends / Closing Balance`) | ❌ |
| USD/EUR / € Growth / € Value | ✅ |
| **YGC / "HYPOTHETICAL!"** forward growth scenario | ✅ covered by `/yearly` + `/monthly` projection (`_projection_query`) |

### 2.6 `Vanguard` / `Fidelity` → `/calculator`

| Spreadsheet feature | In dashboard? |
|---|---|
| Target weight per ticker | ✅ active target allocation |
| Price / expense per ticker | ✅ |
| Shares to buy / amount to invest for a cash injection | ✅ `plan_rebalance` (buy-only) |
| **Fixed recurring monthly buy amounts per ticker** (e.g. Vanguard "63 → 6930") | ❌ minor — the per-ticker fixed contribution plan isn't modelled |

---

## 3. Consolidated gap list — what to add for parity

Ordered roughly by how central each is to the spreadsheet's day-to-day use.

### Priority 1 — Per-instrument return grid on `/overview`
The single biggest gap. The spreadsheet's headline view is a per-instrument
table of **XIRR, TWR, Total Growth, and their YTD and EUR variants**; the
dashboard shows only one price-only growth column.

- [x] Compute **per-instrument XIRR** (re-use `domain/returns.xirr` with each
      instrument's own buy/sell/dividend cashflow stream + terminal mark).
      *(Implemented as `InstrumentMetrics.xirr`.)*
- [ ] Compute **per-instrument TWR** and **YTD TWR** (re-use the period-return /
      log-return TWR maths already in `domain/returns.py`, run per instrument —
      mirrors `Lots` cols L/M/N → AK/AL).
- [x] Add **YTD total growth** per instrument.
      *(Implemented as `InstrumentMetrics.ytd_growth_pct`.)*
- [ ] Add **EUR variants** (`€ TG`, `€ YTD TG`) — convert each instrument's
      cashflows at the trade-date FX rate (the machinery already exists in
      `_period_query`).
- [x] Make the headline per-instrument growth **dividend-inclusive**
      (`End − CostBasis + Dividends`) to match the spreadsheet's `TG`.
- [x] Surface the **expense ratio** column (already on the instrument record).

### Priority 2 — Portfolio KPIs on `/overview`
- [x] **MTD growth / profit** card (month-to-date portfolio profit, not just
      contributions). *(Implemented as `PortfolioMetrics.mtd_growth_pct`.)*
- [x] **Weighted portfolio expense ratio** (`SUMPRODUCT(expense, value-weight)`).
- [x] **Annual expense cost in €** (`Σ price · expense · shares`).
- [x] **"Beating / Losing the market"** verdict (compare portfolio XIRR/TWR to
      the benchmark series already fetched by `benchmark_service`).
- [ ] **Capital Increase** headline (net new contributions over the period).

### Priority 3 — Per-instrument detail (Lots parity)
- [ ] **Per-instrument dividend totals** — yearly + cumulative, including
      *reinvested* dividends (spreadsheet's "X" flag), not just cash dividends.
- [ ] **Performance Gain** (`gain / starting investment`) and **Percental Gain**
      (`gain / total cost basis`) per instrument.
- [ ] **YTD Gain** per instrument.
- [ ] **End-of-year value per instrument** (year-end marks for 2023/24/25…),
      driven off the existing snapshot history.
- [ ] **Cost Basis excluding reinvested dividends** as a separate figure.

### Priority 4 — Monthly / Yearly columns
- [ ] `/monthly`: add **Total Gain (€)** and **Capital Gain (€)** columns
      (Capital Gain = Total Gain − Dividends).
- [ ] `/yearly`: add **Gain/Loss (€)** absolute column and a **Div Yield**
      column (`Dividends / Closing Balance`).

### Priority 5 — Nice-to-haves
- [ ] **"Today" 1-day change %** per instrument and at portfolio level (requires
      keeping yesterday's close, which `price_history` already stores).
- [ ] `/calculator`: optional **fixed recurring monthly buy plan** per ticker
      (the `Vanguard`/`Fidelity` sheet's preset buy amounts), alongside the
      existing cash-injection rebalance.

---

## 4. Summary

The dashboard has reached **structural parity** — every spreadsheet sheet has a
corresponding page, and the hardest pieces (XIRR/TWR maths, FX-aware EUR
conversion, the rebalance calculator, forward projections) already exist in the
codebase. The remaining work is mostly **plumbing existing domain maths through
to per-instrument granularity** and **surfacing a handful of derived KPIs**
(MTD profit, weighted expense ratio, expense cost, div yield, market verdict)
that the spreadsheet shows but the UI does not yet expose.

No new external dependencies or schema changes are required for Priorities 1–4;
they reuse `domain/returns.py`, `positions_service`, `snapshots_service`,
`benchmark_service` and the existing FX history.
