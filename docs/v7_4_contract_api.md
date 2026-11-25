# 7.4 contract, part 2: the service seam and the API (lanes B2, C, D)

> This file goes with [`v7_4_contract.md`](v7_4_contract.md); §0 (rules) applies to every lane.
> Pydantic schemas live in `api/schemas/`. The names below are the JSON field names.
> Money is a decimal string, rates have 4 decimals, dates are ISO.

## 7. Service seam (lane B2 owns it; lane C codes against the signature)

```python
# services/cash_pool_service.py  (B2)
@dataclass(frozen=True)
class PoolSnapshot:
    state: cash_pool.PoolState
    deposit_matches: fx_pool.PoolResult
    cash_outs: tuple[cash_out.CashOut, ...]
    basis: Literal["pool", "buy_date"]          # setting fx.holding_cost_basis

def build_pool_snapshot(ledger_session, *, as_of: date | None = None) -> PoolSnapshot: ...
```

- The snapshot is built once per ledger change and cached by ledger version, like the other
  `/both` read models.
- Lane C builds synthetic `PoolSnapshot`s in its tests. It never calls ledger repositories
  itself.

B2 wiring (owner of the files in contract §1):
- `overview_query._legs` and `build_instrument_cashflows` take a buy's EUR from
  `state.buy_cost_eur` when `basis == "pool"`.
- A sell's EUR flow stays at its own date's rate (currency rule for the holding's EUR XIRR).
  Its realised market part is `state.sale_market_eur`.
- `ledger_query`'s `eur_amount` hook (lane A) gets the pool resolver: deposits use the
  matched EUR, buys use `buy_cost_eur`, everything else the derived path. Plug it in
  after lane A is merged into the integration branch; until then leave `ledger_query`
  alone.
- Tranches get `cost_eur` (book) and `orig_eur`, pro-rated from the holding's EUR by
  `cost_native` share (FIFO view, labelled).
- Conversions:
  - `fx_conversion_service` writes and reads `from_ccy` / `to_ccy`; `direction` is derived
    as `"to_usd"` or `"to_eur"`;
  - `fx_pool` gets only EUR→USD rows; conversions back go to `cash_pool` as `ConversionBack`;
  - the pins table holds withdrawal pins, with `deposit_txn_id` = the withdrawal id.
- Setting `fx.holding_cost_basis` (`pool` | `buy_date`, default `pool`) in a new `currency`
  settings section. `fx.tracked_quotes` and `fx.stale_after_seconds` move there too and become
  visible (not advanced).
- P18: one `ledger_cash_balances` rule. Broker cash outside money-market funds counts in the
  Overview total. Negative cash counts as 0 and produces a Data Health flag
  (`negative_broker_cash`, lane C's check reads B2's helper).

## 8. Endpoints (lane C), all on the `/both` + ETag pattern where they are reads

### `GET /api/currency/journey` → `JourneyBoth { eur: JourneyView, usd: JourneyView }`

```
JourneyView {
  stats: {                                     # always four tiles, never an empty one
    usd_account:  { usd, eur_cost, eur_now, currency_eur }
    broker_cash:  { usd, eur_cost, eur_now, currency_eur }
    invested:     { usd, eur_cost, eur_now, market_eur, currency_eur }
    your_rate:    { rate, ecb_avg, now }        # pool blend · ECB over the same dates · live
  }
  bridge: null | {                             # EUR view only; null in the USD view
    lines: [ { key: "conversion_cost"|"waiting"|"cash"|"holdings"|"realised", eur } ]
    total_eur                                  # == Overview card fx gain (test)
  }
  idle: [ { conversion_id, date, usd, days } ] # > 30 days, oldest first
  back_in_euros: null | { count, eur_received, orig_eur, realised_eur }
  cash_outs: [ CashOutOut ]
  flagged: { uncovered_buys, ecb_fallback_deposits }   # counts
}
CashOutOut {
  conversion_id, date, usd_sent, eur_received, fees_eur,
  eur:  { put_in, market, currency, conversion_cost, realised, realised_pct, xirr }
  usd:  { put_in, market, realised, realised_pct, xirr }   # dollars only, from native USD flows
  note                                         # server sentence: "you kept 2.1 points a year less in euros than in dollars"
  flagged
}
```

- In the USD view, every figure is dollars from native USD (never `eur / fx`). It hides the
  euro-only lines (`bridge: null`, the EUR cost in the stats).
- The dollar side of a cash-out has `put_in` = the dollars originally deposited behind those
  lots, and an XIRR over the native USD deposit flows against the USD sent.

### `GET /api/trail/{kind}/{id}`, where kind is deposit | buy | sell | withdrawal | conversion

```
TrailOut {
  kind, id,
  paths: [                                     # usually 1; more when a buy drew from several deposits
    { usd_share, steps: [ Step ] }
  ]
  more_paths: int                              # paths beyond the first 3, shown as "and N more"
  split: null | { market_eur, currency_eur, conversion_cost_eur, total_eur }  # for a buy: value now; for a cash-out: realised
  your_rate, ecb_rate                          # the rate chip values
  flagged
}
Step {
  key: "sent"|"converted"|"waited"|"deposited"|"bought"|"sold"|"withdrawn"|"back"|"worth_now"
  date, label, figure, figure_ccy, detail, link   # detail ≤ 24 chars (the alignment rule: no box wraps)
}
```

### Other additions (lane C owns the read models and schemas)

- `TrancheRowOut` gets `cost_eur`, `orig_eur`, `your_rate`, `gain_eur`, `market_eur`,
  `currency_eur`, and `back_in_euros: bool | null` (null = still in dollars).
- Holding performance (`KeyFacts`): `your_rate`, `ecb_buy_avg`, `fx_effect_pp` (EUR growth
  minus USD growth, each computed on its own, a residual).
- `HoldingPeek`: `your_rate`.
- `CurrencyLifetime` (Overview):
  - adds `your_rate`, `ecb_avg`, `conversion_cost_eur`, `realised_eur | null`, and
    `vs_impact_note` (the one sentence);
  - `breakeven_rate` is now your rate;
  - `fx_pnl_eur` = the journey bridge total.
- Holdings KPI: `fx_your_rate`.
- Transaction record:
  - `eur_basis: "your_rate" | "pool" | "ecb" | "native"`;
  - `trail_kind: null | "deposit" | "buy" | "sell" | "withdrawal"`.
- Conversions:
  - each row has `direction`;
  - the list takes a `direction` filter;
  - the KPI strip adds `back_in_euros_eur` and `realised_eur` (null until the first cash-out).
- `POST /api/cash-out/preview { withdrawal_id?, usd_sent, eur_received, fees_eur, date }` →
  `CashOutOut`, without saving. Saving uses the existing conversion API with
  `direction: "to_eur"`, plus the existing transaction API for the withdrawal.
- The Deposits page and Periods rows get `cashed_out_eur` (0 when there is none).
- Data Health checks, each with a fix link: `idle_dollars`, `uncovered_buys`,
  `negative_broker_cash`, `withdrawals_not_converted` (info), `conversion_back_uncovered`.
- Activity: the journey, trail and preview reads need no line. A conversion back saves
  through the existing `changes` subject.

## 9. Lane D (UI) works against fixtures

- Lane D writes fixture JSON for these shapes under `frontend/src/fixtures/` (the nice and
  stress sets, including one cash-out), plus temporary types in
  `frontend/src/lib/journey-types.ts`. The orchestrator swaps those for the generated
  `api-types.ts` at merge.
- Lane D owns:
  - `components/MoneyTrail/`, `components/CashOutCard/`;
  - `pages/Currency/sections/Dollars/` and its `sections.ts` entry;
  - `pages/CashOut/` (the guided flow);
  - the edits in `pages/Transactions/RateChip.tsx` / `RateSheet`,
    `pages/CurrencyConversions/`, `pages/Holding/` (`TranchesTab`, `PerformanceTab`
    `KeyFacts`), `components/HoldingPeek`, `components/CurrencyLifetime`,
    `pages/Holdings/HoldingsKpis.tsx`;
  - the Deposits and Periods cashed-out column, the Impact bridge "Cashed out" line, the
    Diagnostics fix links, `components/Tour/steps.ts` (one step), `lib/glossary.ts`, and
    `tokens.cvd.test.ts` pairs.
- **Not lane D:** `tokens.scss` (ask the orchestrator for any new token), `RecapCard` and
  Periods real return (lane E). The Periods table is touched by both D and E: D adds only
  the `cashed_out` column, E only the real-return column.
