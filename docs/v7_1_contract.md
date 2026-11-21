# 7.1 contract — holding deep-dive

> Written 2026-11-21 at the start of push 5 (plan §8, row 5). Lanes code against
> this file; where code and this file disagree, fix this file in the same commit.
> The 7.2 dependency (P16) follows `docs/v7_contracts.md` on the 7.2 branch.
> All money fields are decimal strings (`DecStr`), all times ISO. Ratios are
> fractions (0.05 = 5 %), like the rest of the API.

## Storage (lane A, migration `0024`, down revision `f6b2d8a4c913`)

- `intraday_twin_prices` → **`intraday_symbol_prices`** (cache tier), adds
  `kind` `String(8)` NOT NULL, server default `'twin'`, values `holding` |
  `twin`. Primary key becomes `(symbol, kind, captured_at)`. Pruning unchanged.
- New **`holding_daily_values`** (cache tier), primary key
  `(date, instrument_id, account_id)`: `quantity`, `close_price_native`,
  `value_native` (`Numeric(18,6)`), `currency` (`String(3)`),
  `net_flow_native` (buys − sells, net of fees, native), `dividends_native`
  (cash + reinvested, native), `computed_at`. Native only.
- One row per (date, instrument, account) held at that trading day's close,
  from the first ledger date to the last close.

## Services (plain dataclasses, never ORM rows)

`services/holding_values_service.py` (lane A):

```python
@dataclass(frozen=True)
class HoldingDayValue:
    date: date; instrument_id: int; account_id: int
    quantity: Decimal; close_price_native: Decimal; value_native: Decimal
    currency: str; net_flow_native: Decimal; dividends_native: Decimal

@dataclass(frozen=True)
class HoldingDayDividend:
    date: date; instrument_id: int; account_id: int
    amount_native: Decimal; currency: str

def holding_values(session, start, end, instrument_ids=None) -> list[HoldingDayValue]
def holding_dividends(session, start, end, instrument_ids=None) -> list[HoldingDayDividend]
def invalidate_instrument_from(session, instrument_id, from_date) -> None
```

- A transaction add, edit, delete, import or import-undo drops and rebuilds that
  instrument's rows from the trade date (alongside today's portfolio
  `invalidate_for_trade_dates`). Price, FX and split changes drop all rows from
  their date. Rebuild is lazy on read, like `PositionSnapshot`.
- Split handling equals `positions_service` (`cumulative_split_factors_after`).
- **Invariant (tested):** per date and currency, Σ `value_native` equals the
  native book of `metrics_service._book_holdings` / `PositionSnapshot`.

`services/symbol_prices_service.py` (lane A):
`prices(session, symbols, start, end, kind=None) -> list[SymbolPrice(symbol, kind, captured_at, price_native)]`.

## Endpoints

### `GET /api/holdings/{instrument_id}/history?range=&mode=` (lane A, additive)

- `range`: `1d | 1w | 1m | 3m | 6m | ytd | 1y | all` (default `1y`). For NAV
  funds (`row.is_nav_fund`), `1d` / `1w` return 422.
- `mode`: `value | price` (default `price`, so the old client keeps working).
- Response `HoldingHistoryResponse` gains:
  - `mode`, `x_mode`: `"date" | "time"` (`time` for 1d/1w), `sessions`:
    `[{open, close}]` for 1d/1w (same shape as the portfolio graph).
  - each point: `t`, `v` (price native, as today), `value_native`,
    `value_eur`, `value_usd` (value at that instant's / day's rate, null in
    price mode), `invested_eur`, `invested_usd` (cumulative net flows at each
    flow's own date rate; null in price mode).
  - `trades`: `[{t, kind: "buy"|"sell", quantity, price_native}]` inside the range.
  - `avg_price_native` (for the price-mode cost line).
  - `period`: `{change_eur, change_usd, return_eur, return_usd, bought_eur,
    bought_usd, dividends_eur, dividends_usd}` for the range, server-computed
    (Modified Dietz on the holding's flows; the client never computes it).

### `GET /api/holdings/{instrument_id}/twin?range=` (lane A)

`range`: `1d | 1w | 1m | 3m | 6m | ytd | 1y`. 404 if the instrument has no twin.

```
{ instrument_id, symbol, twin_symbol, twin_reason: "same_index"|"close_index"|"manual",
  range, x_mode, sessions,
  twin_points:     [{t, price_native}]              # 1d/1w: intraday; 1m+: closes
  estimate_points: [{t, price_native}]              # 1d only, prev_NAV × twin_now / twin_prev_close
  nav_points:      [{t, nav_native}]                # one per session close (1w dots, 1d close point)
  rebased:         [{t, fund_pct, twin_pct, gap_pp}] | null   # 1m+: % from range start, server-side
  twin_now: {price_native, day_pct, captured_at},
  stats: {median_gap_pp, bias_pp, bias_label: "runs_high"|"runs_low"|"none", sessions},
  recent: [{session_date, estimate_pct, nav_pct, gap_pp}]      # last 5 sessions
}
```

Changing the twin stays `PATCH /api/instruments/{id}` (`intraday_twin`).

### `GET /api/holdings/{instrument_id}/tranches` (lane B)

```
{ instrument_id, symbol, currency, method: "fifo_view", as_of, price_native,
  rows: [{ id, account_id, account_name, acquired_on, source: "buy"|"reinvest"|"transfer_in",
           quantity_bought, quantity_left, cost_per_share_native, cost_native,
           age_days, long_term_on, days_to_long_term,            # null once long-term
           status: "long"|"soon"|"short",                        # soon = ≤ 60 days
           gain_native, gain_pct }],
  groups: [{ account_id, source: "reinvest", count, quantity_left, cost_native,
             avg_cost_per_share_native, gain_native, gain_pct, long_count, short_count,
             row_ids: [...] }],
  totals: { quantity_left, position_quantity, matches_position: bool,
            long_quantity, short_quantity, fully_sold_count } }
```

`long_term_on` = acquisition date + 1 year + 1 day (29 Feb → 1 Mar next year
+ 1 day: a lot bought 29 Feb 2024 is long-term on 2 Mar 2025). Tranche figures
never feed any aggregate.

### `GET /api/holdings/{instrument_id}/peek` (orchestrator, at integration)

`{ week: {points: [{t, value_native}], change_pct}, tranches: {open_count,
next_long_term_on, next_long_term_days}, last_trade: {date, kind, quantity} |
null, last_dividend: {date, amount, currency} | null, twin: TwinView | null }`

### `GET /api/dividends/both` (lane B, additive)

Each `by_holding` entry gains `by_year: [{year, amount}]`, `last_12m`,
`yield_ttm` (fraction), in the reporting currency at each payment's own date.

### `/api/analytics/both` attribution rows (lane B)

Add `share_of_pnl` (P&L ÷ total P&L; null when |total| < 0.5 % of average
capital) and `own_return` (Modified Dietz of the row in the window).
`pct_of_total_return` stays for one release, marked deprecated; the client
stops reading it.

### Lookup (lane C)

- `GET /api/lookup/search?q=` → `{results: [{symbol, name, exchange, type,
  currency, held_instrument_id | null}]}` (max 10, `q` ≥ 1 char).
- `GET /api/lookup/{symbol}/quote` → `{symbol, name, exchange, type, currency,
  price_native, day_change_native, day_pct, captured_at, week52_low,
  week52_high, fx_eur_usd}`.
- `GET /api/lookup/{symbol}/history?range=1d|1w|1m|3m|6m|ytd|1y|all` →
  `{symbol, currency, range, x_mode, sessions, points: [{t, price_native,
  fx_eur_usd}]}` (the client converts each point at that point's own rate: one
  instant, one rate, allowed by AGENTS.md).
- In-memory TTL cache (15 min, 50 symbols). No instruments row, nothing in the
  ledger. Activity subject `lookup` (symbol and range only).
