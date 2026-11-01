# Known bugs in v5.3.1 (not fixed here)

v5 stays frozen: none of these are fixed on this branch. They were found while
building v6 (PR #325, branch `feat/v6-one-app`) and fixed **only in v6**. This
note exists so that, if you ever roll back to v5, you know which numbers to
distrust and where the v6 fix lives.

Paths below are the v5 layout (`src/investment_dashboard/...`). In v6 the code
moved to `backend/src/investment_dashboard/...` and the `ui/pages/_*_query.py`
modules moved to `readmodels/queries/*_query.py`.

## 1. Analytics: USD figures are built from EUR cashflows

- **Symptom:** on the Analytics page with USD selected, the money-weighted
  return (XIRR) and the contribution-adjusted curve use the EUR amount of each
  deposit/withdrawal. The "USD XIRR" is really the EUR XIRR.
- **Where:** `ui/pages/_analytics_query.py`, `_build_curve`: contributions are
  summed from `net_eur` regardless of the selected currency.
- **Impact:** every USD analytics figure that depends on cashflows. EUR figures
  are correct.
- **v6 fix:** commit `4cedec7` (a USD cashflow per transaction at its own
  date's rate), test `backend/tests/readmodels/test_analytics_usd.py`.

## 2. USD-native transactions without a EUR leg are counted as euros

- **Symptom:** a transaction on a USD account whose frozen `net_eur` is empty
  is counted with its dollar amount as if it were euros.
- **Where:** `services/metrics_service.py` `_txn_eur_amount` (falls back
  `net_eur` → `net_native` → 0) and its verbatim copy in
  `services/benchmark_service.py` `_txn_eur_amount`.
- **Impact:** EUR invested/returns and benchmark comparisons, but only for rows
  missing `net_eur` (rare: normally the importer freezes both legs).
- **v6 fix:** commit `8273ada` (one cashflow module, `services/cashflows.py`).

## 3. Missing FX rate becomes 0 or a rate of 1

- **Symptom:** when no EUR/USD rate exists for a date, some helpers return 0
  (shrinking totals and return denominators) or use a rate of 1 (showing a EUR
  value labelled USD) instead of leaving the figure blank.
- **Where:** `services/metrics_service.py` `_txn_usd_amount` (returns 0, also
  imported by `readmodels/mobile_export.py` and `ui/pages/_period_query.py`),
  plus None-to-0 coercion in `ui/pages/_overview_query.py`.
- **Impact:** only on dates with an FX gap; the figure is silently wrong rather
  than missing.
- **v6 fix:** commit `8273ada` (one missing-FX policy: no figure rather than a
  wrong one).

## 4. Dividend reinvestment matched across accounts

- **Symptom:** a cash dividend in account A and a same-day reinvestment of the
  same instrument in account B are matched, so A's cash dividend is dropped
  from income.
- **Where:** the reinvest key ignores the account in
  `domain/dividends.py` `reinvest_keys` (used by `metrics_service`) and in
  `ui/pages/_overview_query.py`; `services/positions_service.py` does include the
  account, so the two disagree.
- **Impact:** only if the same instrument pays out on the same day in two
  accounts and one of them reinvests.
- **v6 fix:** commit `8273ada` (one `(account, instrument, date)` key).

## 5. "Today" is the laptop's local date, not the exchange day

- **Symptom:** about 46 places use `date.today()` (local clock) where the
  New York exchange day is meant. Between local midnight and New York midnight
  (roughly 00:00 to 06:00 in Germany) "today" is one day ahead of the market,
  so FX lookups, period boundaries (YTD/MTD) and "today" price checks can point
  at a day that has no data yet.
- **Where:** `services/*_service.py`, `ui/pages/_*_query.py`,
  `readmodels/live_graphs.py` (uses the UTC date).
- **Impact:** brief oddities after midnight; no stored data is wrong.
- **v6 fix:** commit `9ab4c8e` (one exchange-day clock).

## Not a v5 bug

- Holdings "capital gain" including dividends was a bug in the **new v6**
  Holdings code only; the v5 Holdings page is unaffected.
