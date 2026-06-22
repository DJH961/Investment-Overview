# Mobile export schema

`investment_dashboard.readmodels.mobile_export.build_mobile_export()` emits the
v3.0 Live Web Companion JSON contract. All `Decimal` values are serialized as
plain strings with `format(value, "f")`; `None` is JSON `null`; dates and
timestamps are ISO-8601 strings.

## Top-level object

| Key | Type | Notes |
| --- | --- | --- |
| `meta` | object | Export metadata and currency context. |
| `holdings` | array | Live-recomputed inputs, one row per open position. |
| `portfolio_cashflows` | array | EUR-leg signed portfolio XIRR cashflows. |
| `cash` | array | Non-market savings/cash balances that count in total value. |
| `period_openings` | object | Month/year opening values for live current-period recompute. |
| `monthly` | object | Existing monthly read-model, shown as-of-export. |
| `yearly` | object | Existing yearly read-model, shown as-of-export. |
| `analytics` | object | Existing analytics read-model, shown as-of-export. |
| `deposits` | object | Existing deposits read-model, shown as-of-export. |
| `transactions` | object | Optional; present only with `include_transactions=True`. |

## `meta`

- `schema_version`: integer, currently `1`.
- `app_version`: package version string.
- `generated_at`: UTC ISO timestamp.
- `as_of`: ISO date used for all Python valuations.
- `display_currency`: current UI display currency.
- `fx_pivot`: `"EUR"`. This is only the FX conversion reference, not the
  user's base currency.
- `fx_rate_eur_usd`: string decimal or `null`.
- `currency_note`: clarifies that each holding carries `native_currency` and
  USD is the booked currency for most ledger rows.

## `holdings[]`

Each row is sourced from `positions_service.compute_positions()`:

- `symbol`, `name`, `asset_class`, `broker`, `account`, `native_currency`.
- `shares`: string decimal, split-adjusted as of `as_of`.
- `cost_basis_native`: string decimal in the account native currency.
- `cumulative_dividends_cash_native`: string decimal in the account native
  currency.
- `price_symbol`: ticker for live quoting; defaults to `symbol`.
- `price_type`: `"market"` for ETFs/stocks, `"nav"` for mutual funds, cash,
  savings, and money-market holdings.
- `last_known_price_native`: string decimal or `null`.
- `cashflows[]`: EUR-leg signed holding cashflows (`date`, `amount`) using the
  returns convention: contributions/buys negative; sells/dividends positive.

## `portfolio_cashflows[]`

Rows are `{ "date": ISO date, "amount": string decimal }` in EUR. They reuse
`metrics_service.build_portfolio_cashflows()` with the same retained cash-account
logic as desktop portfolio XIRR.

## `cash[]`

Rows are savings/cash accounts:

- `account_label`, `broker`, `native_currency`.
- `balance_native`: string decimal from `compute_cash_balance()`.

## `period_openings`

- `month_start_value_eur`, `year_start_value_eur`: total EUR opening values.
- `holdings`: map of `symbol` to `month_start_value_eur` and
  `year_start_value_eur`.

These values are live-recompute inputs for the current month/year. Completed
periods remain in `monthly` and `yearly` as-of-export; the browser decides which
current period to recompute.

## `monthly` / `yearly`

Each is `{ "rows": [...] }`. Every row carries (EUR figures are what the web
companion renders; `*_display` fields exist for the desktop's display currency
and are ignored by the web build):

- `label`: `YYYY-MM` for monthly rows, `YYYY` for yearly rows.
- `contributions_eur`, `dividends_eur`, `interest_eur`, `net_flow_eur`.
- `opening_value_eur`, `closing_value_eur`.
- `growth_pct`: string decimal ratio or `null`.
- `display_currency` plus `*_display` siblings
  (`contributions_display`, `dividends_display`, `interest_display`,
  `net_flow_display`, `opening_value_display`, `closing_value_display`,
  `growth_pct_display`): the same figures converted with the EUR→quote FX rate
  **in force on each trade/boundary date** (not today's spot). The mobile export
  always builds these against a **USD** context, so `display_currency` is
  `"USD"` and a USD reader gets the wallet they actually experienced. They are
  `null` only when FX history is too sparse to convert, in which case the
  browser falls back to the EUR figure.

The browser **overlays the current period live** (proposal §3.C): the row whose
`label` matches `meta.as_of`'s month/year is recomputed against live prices, so
its growth and closing value reflect today; completed prior rows stay frozen.

## `analytics`

The as-of-export risk bundle (`readmodels/analytics.py`), shown stamped "as of
export". Notable fields: `as_of`, `start`, `currency`, the return metrics
(`cagr`, `twr`, `xirr`, `alpha`, `beta`, `risk_free_rate`), the risk metrics
(`volatility`, `sharpe`, `sortino`, `max_drawdown`, `calmar`, `ulcer`, `var_95`,
`cvar_95`, `skew`, `kurtosis`), `benchmark_symbol`, `risk_free_symbol`, a
`curve[]` equity series (`date`, `portfolio_value`, `cumulative_contributions`,
`benchmark_value`) and an `attribution[]` list (`symbol`, `absolute_pnl`,
`pct_of_total_return`, …). Any metric may be `null`.

## `deposits`

Contributions read-model (`readmodels/deposits.py`): a `summary`
(`total_contrib_eur`, `ytd_contrib_eur`, `mtd_contrib_eur`, and their
per-trade-date `*_usd` counterparts `total_contrib_usd`, `ytd_contrib_usd`,
`mtd_contrib_usd`) and `rows[]` (`date`, `account`, `kind`, `amount_eur`,
`amount_usd`, `amount_native`, `currency`, `description`, …). The `*_usd` /
`amount_usd` figures convert each cash flow at the EUR→USD rate **on its own
date** (USD-native deposits use their booked amount), so the browser must use
them directly in USD mode rather than rescaling the EUR totals by today's spot
— doing so would double-convert any deposit originally booked in USD.

## Precision targets

Browser parity should compare money within `1e-6`, rates/percentages within
`1e-8`, and XIRR within `1e-6`.
