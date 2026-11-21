# v7 contracts between parallel pushes

> Written 2026-11-21 when 7.1 (holding deep-dive), 7.2 (Currency page) and
> 7.3 (conversions) started at the same time in separate worktrees. This file
> exists so that merging the three streams is no hassle.
>
> **The spirit:** these are guidelines that keep merges easy, not walls. Any
> stream may improve another's code when there is a good reason. Keep such
> changes additive (add rather than rename) and mention them in the PR. The only
> hard rules are the project's own (AGENTS.md: the currency rule, layering,
> tests green).
>
> **Merge order (owner, 2026-11-21):** 7.1 → 7.2 → 7.3. 7.2 does not ship
> before 7.1. Before each merge a conciliator agent checks the "Conciliator
> checks" lists below against the merged tree.

## 7.1 → 7.2: per-holding daily values (P16)

7.2's per-holding currency split (price gain · dividends · currency, for any
range) builds on 7.1's per-holding stored value series. The items below are
what 7.2 **needs**, meaning the semantics and the invariant. 7.1 is free to
choose names, table layout and storage, and to do more. 7.2 codes against a
`Protocol` with a fake in its tests, and the conciliator adapts that
`Protocol` if a name differs.

1. **Daily per-holding values, stored.** One per (date, instrument, account)
   held at that day's close, with: date, instrument id, account id, quantity,
   close price (native), value (native) and native currency. Native only, with
   no EUR or other derived-currency column (currency rule).
2. **Complete and current.** Covers every day from the first ledger date to the
   last close. It is recomputed from the trade date onward when a transaction is
   added, edited or deleted, and split-adjusted the same way as the positions
   service.
3. **A service read** that returns plain dataclasses, not ORM rows. For
   example `holding_values(session, start, end, instrument_ids=None) ->
   list[HoldingDayValue]`. 7.2 reads it only through this service (the
   cache-tier rule).
4. **Dividends per holding per day, native** (amount and currency), from that
   service or an existing one.
5. **Invariant, tested in 7.1:** on every day, the sum of the native values per
   currency equals the portfolio's native book for that day (what
   `metrics_service.book_holdings` and `PositionSnapshot.total_value_usd`
   reflect for USD holdings).
6. **Rebuildable:** the series is derived, so it may live in a tier that a cache
   reset rebuilds, as long as it can be rebuilt from the ledger plus prices.
7. **Nice to have:** the planned intraday per-symbol prices. 7.2 reads them
   only for a 1D/1W per-holding effect, if they are there.

**Conciliator checks before 7.2 merges:**

- items 1–5 exist on `main` with these semantics
- the invariant test is present and green
- 7.2's `Protocol` matches the real signature
- the Alembic migrations chain linearly (re-parent the later one)

## 7.2 ↔ 7.3: Conversions on the Currency page

7.2 rebuilds the Currency page as **one page with a sticky section bar**:

- the EUR/USD chart first
- then Impact · The dollar · What if
- then Conversions (7.3)

7.3's analysis (costs, timing, pool, idle dollars) becomes the Conversions
section. Editing stays on the Conversions page.

**What 7.2 provides:**

1. **A section registry**, `frontend/src/pages/Currency/sections.ts`:
   `CURRENCY_SECTIONS: { id, label, Component, subPages? }[]`. The sticky bar,
   the load-on-scroll and the `/currency/:sub` sub-page routes all read it. 7.3
   adds its `conversions` entry there.
2. **A section shell**, `frontend/src/components/CurrencySection/`: the title,
   a one-line explainer, a `StatStrip` fed by server `stats`, load-on-scroll and
   the skeleton, empty and error states. Using it keeps every section looking
   and behaving the same.
3. **Conversion markers on the rate chart:**
   - `GET /api/currency/rate-history` returns `markers`. Each marker has
     `{ date, rate, amount_from, from_ccy, to_ccy, kind, conversion_id }`, where
     `kind` is `above_reference`, `below_reference` or `null`.
   - 7.2 fills the list from the existing `FxConversion` rows with
     `kind = null`, drawn as a neutral marker sized by amount.
   - 7.3 can fill `kind`, compared with the settled fixing of the conversion's
     own date.
   - 7.2 builds both marker styles and adds them to the CVD pair list.
4. **Lifetime block stability:**
   - 7.2 does not rename or redefine any existing `lifetime` field.
   - 7.2's cards read `avg_invest_rate`, `breakeven_rate` and `fx_pnl_eur`, so
     they follow automatically when break-even moves to "your rate".

**How 7.3 fits in (guidelines):**

- **Preferred home for new work**, since new files merge without conflicts:
  - `pages/Currency/sections/Conversions/**`
  - `readmodels/currency_conversions.py` and `api/currency_conversions.py`
    (routes under `/api/currency/conversions/…`, the `/both` + ETag pattern,
    activity labels)
  - its own schemas and its own section strip
- **Touching 7.2's files is fine when it helps**, for example a new strip tile,
  a `StatKey` or a field on the rate-history payload. Keep it small and
  additive.
- **The lifetime card's "Your rate" row:**
  - add it however reads best
  - add new `lifetime` fields (`your_rate`, `ecb_avg_rate`,
    `conversion_cost_eur`, `breakeven_basis`, …) rather than changing existing
    ones in place
  - where a meaning really does change (break-even moving to your rate), say so
    in the docstring and the CHANGELOG
- **Shared files:**
  - `tokens.cvd.test.ts`, `CHANGELOG.md`: append
  - fixtures `full.json`, `openapi.json` / `api-types.ts`, version bumps:
    regenerate after rebasing
- **If 7.3 is ready before 7.2:** ship the analysis on the Conversions page
  and move it into the Currency section once 7.2 has landed.

**Conciliator checks before 7.3 merges:**

- the Currency page renders every section, including markers with
  `kind = null`
- any change to the meaning of an existing `lifetime` field is intended and
  documented
- the generated API files and fixtures were regenerated on the merged tree
