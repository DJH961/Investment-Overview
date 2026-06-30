# Pre-v3.0 Audit — Remaining Work

> 🗄️ **Archived — historical.** This pre-v3.0 audit has been superseded by the
> shipped v3.x/v4.x line and the active `docs/maintenance_audit.md` backlog. Kept
> for design context only; see `CHANGELOG.md` for the authoritative history.

This document tracks what the pre-v3.0 deep audit identified but that has **not
yet been implemented**. It is the companion to the work already landed.

It re-baselines the audit against the current code (app version **3.0.0**) and
records, for each cluster, what is done, what is deferred, and why.

---

## ✅ Done in this pass

| Item | Summary | Where |
| --- | --- | --- |
| **A1** | `_value_in_both` no longer relabels EUR as USD when FX is missing — the daily-growth USD leg degrades to `None`. | `services/metrics_service.py` |
| **A3** | XIRR on a zero-span (single-date) cashflow set returns `None` instead of the seed guess (0.10). | `domain/returns.py` |
| **A6** | The fetched risk-free rate is range-checked (`0 ≤ rate ≤ 1`); a bad tick keeps the last good cached value. | `services/risk_free_service.py` |
| **D1** | Bounded retry/backoff for the yfinance and Frankfurter clients; HTTP 429 handled distinctly with `Retry-After`. | `adapters/_retry.py`, `adapters/yfinance_client.py`, `adapters/frankfurter_client.py` |
| **C2** | Backup manifests, the `publish-web` blob, and the snapshot export now write through one atomic-write (+ fsync) helper. | `storage/atomic_io.py`, `tools/backup.py`, `tools/publish_web.py`, `tools/export_snapshot.py` |
| **C5** | Publishing now pre-flights the GitHub PAT (token validity, repo reachability, `Contents: write`, and expiry) before any release write, and a process-wide log filter plus per-message sanitising keep tokens out of logs/error text. | `services/publish_service.py`, `redaction.py`, `logging.py` |
| **C1** | Durable tiers (ledger/config) now commit with `PRAGMA synchronous=FULL`; the rebuildable cache keeps `NORMAL`. Survives power loss in cloud-sync folders without slowing the cache. | `db.py` |
| **C4** | `--passphrase` is no longer the only non-interactive path: one shared resolver prefers the env var, falls back to a `getpass` prompt on a TTY, and warns that the CLI flag leaks into `ps`/shell history. | `tools/_passphrase.py`, `tools/backup.py`, `tools/split_db.py`, `tools/repair_sidecar.py` |
| **D2** (partial) | The Vanguard XLSX parser now refuses an import when a data cell lands under a column the header doesn't name (mis-aligned layout), instead of silently dropping it via `zip(strict=False)`. | `adapters/vanguard/xlsx_parser.py` |
| **H2** | Full-metrics golden-master regression harness for `compute_portfolio_metrics`. | `tests/services/test_metrics_golden_master.py`, `tests/services/golden/portfolio_metrics.json` |
| **F1** | README status pill re-synced from v2.9.4 → v3.0.0; the false "UI never reaches into repos" claim corrected. | `README.md`, `requirements_and_project_overview.md` |
| **A2** | The silent 1:1 FX fallback is gone: `positions_service._eur_rate_for` now returns `None` when a rate is missing, and a non-EUR holding/cash with no rate values to **blank** (ZERO + `value_warning`) in EUR — never the native amount relabelled at par. `total_portfolio_value` omits unconvertible cash instead of adding a par figure. | `services/positions_service.py`, `tests/services/test_services.py` |
| **B1** | `compute_portfolio_metrics` now threads a per-request `_ValuationCache` memoising `compute_positions`/`total_portfolio_value` by date, so today/year-start/month-start/daily-growth/expense roll-ups are computed once each instead of repeatedly. Byte-stable under H2. | `services/metrics_service.py` |
| **B2** | The N+1 `close_as_of`/`latest_close`/`cumulative_split_factor_after` per held instrument in `compute_positions` is replaced by three batched lookups (`prices_repo.latest_closes` window query, `splits_repo.cumulative_factors_after`). Parity tests assert batched == singular. | `repositories/prices_repo.py`, `repositories/splits_repo.py`, `services/prices_service.py`, `services/positions_service.py` |
| **B3** | `_best_effort_ytd_start_value` prefers the earliest positive stored daily snapshot in the window, falling back to the bounded live loop only when no snapshots cover it. | `services/metrics_service.py` |
| **B4** | `snapshots_service.warm_range` bulk-reads the window once and skips already-cached historical days instead of reopening a cache session per day. | `services/snapshots_service.py` |
| **B5** | `build_portfolio_cashflows_dual` builds the EUR and USD cashflow streams in a single ledger pass; `compute_portfolio_metrics` uses it for both the full-ledger and YTD legs. | `services/metrics_service.py` |
| **B6** | `backfill_missing_legs` (non-force) and `missing_fx_dates` now select only rows with a NULL leg via `transactions_repo.list_transactions_missing_legs` instead of loading the whole ledger and filtering in Python. | `repositories/transactions_repo.py`, `services/transaction_fx_service.py` |

### Verified already fixed (no change needed)

* **A4 — Modified-Dietz on padded future periods.** `ui/pages/_period_query.py`
  already guards `period_open > today` and sets growth to `None`
  (≈ lines 453–457), so the −200 % edge no longer occurs.
* **A5 — `_amount_eur` ZERO vs None.** The unconvertible non-EUR/USD path
  already returns `None` (≈ line 180); only the genuinely-no-amount case
  (`net_native is None`) returns `ZERO`, which is harmless to a Modified-Dietz
  denominator. No further change required.
* **G — Stale split/price cache after a manual ticker change.** Already wired:
  `ui/pages/settings.py` calls `prices_service.invalidate_instrument_prices`
  whenever the symbol changes, and that helper drops closes **and** the split
  cache (`splits_repo.delete_for_instrument`). No further change required.
* **E5 — Projection empty-state division/`inf`.** Already guarded: the seed
  builder gates the implied-FX ratio on `metrics.total_value_eur > 0`
  (`_projection_view.py` ≈ line 116) and `_render_implied_fx` returns early on
  `final_eur <= 0`. No further change required.

---

## ⏳ Remaining

### A. Correctness

* **A2 — ✅ done.** The silent 1:1 FX fallback for non-EUR holdings/cash is
  removed. `services/positions_service.py::_eur_rate_for` now returns `None`
  (not `Decimal(1)`) when a rate lookup fails; a non-EUR holding with no rate
  values to **blank** in EUR (`current_value_eur == 0` + `value_warning`) rather
  than relabelling the native amount as EUR at par, and `total_portfolio_value`
  omits an unconvertible non-EUR cash balance instead of adding a par figure.
  Policy applied: "FX missing ⇒ value unavailable, never par." Regression tests:
  `test_missing_fx_values_non_eur_holding_blank_not_par` /
  `test_missing_fx_excludes_non_eur_cash_from_total`. (Tests that previously
  leaned on the par fallback now seed an FX rate or use an EUR-native holding.)

### B. Performance / execution — the structural refactor — ✅ done

The metrics path used to re-roll the whole ledger from inception many times per
render, with nested N+1 price/FX lookups. The B-series lands the targeted fixes
below; all stay **byte-stable under the H2 golden-master** (same KPI numbers,
fewer round-trips). Direct parity tests back the batched primitives.

* **B1 — ✅ done.** `compute_portfolio_metrics` threads a per-request
  `_ValuationCache` that memoises `compute_positions` and
  `total_portfolio_value` by date. The terminal value, daily-growth holdings
  and expense figures now reuse the single `as_of` roll-up, and year-start /
  month-start / daily-growth dates are valued once each. `total_portfolio_value`
  gained an optional `positions=` parameter so a precomputed roll-up is reused.
* **B2 — ✅ done.** The per-instrument `close_as_of` / `latest_close` /
  `cumulative_split_factor_after` calls in `compute_positions` are replaced by
  batched lookups: `prices_repo.latest_closes` (a single `ROW_NUMBER()` window
  query, with/without an `on_or_before` bound) and
  `splits_repo.cumulative_factors_after` (one grouped query). Service wrappers
  `prices_service.latest_closes` / `closes_as_of` /
  `cumulative_split_factors_after` keep the cache-tier routing. Parity tests
  (`test_latest_closes_batch_matches_singular`,
  `test_cumulative_factors_after_batch_matches_singular`) assert the batched
  results equal the singular helpers id-for-id.
* **B3 — ✅ done.** `_best_effort_ytd_start_value` first consults
  `snapshots_repo.list_in_range` for the earliest positive stored snapshot in
  the bounded window (persisted snapshots already hold the EUR total), only
  falling back to the original day-by-day live valuation when no snapshot covers
  the window (brand-new portfolios).
* **B4 — ✅ done (round-trip reduction).** `snapshots_service.warm_range`
  bulk-reads the window via `stored_snapshots_in_range` and skips
  already-cached historical days instead of reopening a cache-tier session per
  day; today is still always recomputed. *Deferred:* the deeper
  "carry-holdings-forward" incremental engine — it would have to reproduce
  `compute_positions`' split/FX/money-market valuation per day exactly, which is
  outside the golden-master safety net and higher-risk than the round-trip win
  justifies right now.
* **B5 — ✅ done.** `build_portfolio_cashflows_dual` emits the EUR and USD
  streams in one ledger pass; `compute_portfolio_metrics` uses it for both the
  full-ledger and YTD legs (replacing four single-currency passes with two
  dual passes). The original `build_portfolio_cashflows` stays for other
  callers.
* **B6 — ✅ done.** `transactions_repo.list_transactions_missing_legs` pushes
  the `net_eur IS NULL OR net_usd IS NULL` predicate into SQL;
  `backfill_missing_legs` (non-force path) and `missing_fx_dates` use it instead
  of loading the whole ledger and filtering in Python. `force=True` still
  recomputes every row.

> ⚠️ **Land B under the H2 golden-master.** The harness committed in this pass
> (`tests/services/test_metrics_golden_master.py`) exists precisely so the
> B-series can prove "same numbers, fewer round-trips." Extend the fixture if a
> KPI it doesn't currently exercise is touched.

### C. Data-safety & storage

* **C1** — ✅ done. `synchronous=FULL` for the ledger/config tiers; the cache
  tier (and only the cache tier, unless it shares a file with a durable tier)
  stays on `NORMAL`. `db.py` threads a `durable` flag through `make_engine`.
* **C2** — ✅ done (atomic sidecar writes).
* **C3** — Sidecar repair ordering (`storage/sidecar.py`). *Verified:*
  `repair_sidecars` runs `integrity_check` → `wal_checkpoint(TRUNCATE)` →
  `journal_mode=TRUNCATE` on a short-lived connection, then deletes any
  survivors — i.e. the journal mode is already flipped *before* the unlink, and
  re-running the tool simply re-checkpoints. The order is restart-safe as-is; no
  change required. (Original audit note described a checkpoint→delete→flip order
  that the current code doesn't use.)
* **C4** — ✅ done. A shared `tools/_passphrase.resolve_passphrase` prefers the
  `INV_DASHBOARD_DB_PASSPHRASE` env var, falls back to an interactive `getpass`
  prompt on a TTY, and warns when the leak-prone `--passphrase` flag is used.
  Wired into `backup`, `split_db`, and `repair_sidecar`.
* **C5** — ✅ done. `publish_service.preflight_token` does one cheap
  `GET /repos/{repo}` before any write and fails fast with an actionable message
  when the PAT is invalid (401), can't reach the repo (404), lacks
  `Contents: write` (`permissions.push` false), or has already expired — warning
  when expiry is imminent. Surfaced/logged API messages are run through
  `redaction.redact_secrets` (with the live token masked), and a process-wide
  `SecretRedactingFilter` installed by `configure_logging` scrubs GitHub PAT
  shapes (`ghp_…`/`github_pat_…`/`gho_…`) and `Bearer`/`token` credentials from
  every log record as defence-in-depth (the audit's recommendation #3).

### D. Adapters / importers

* **D1** — ✅ done (retry/backoff + 429).
* **D2** (partial) — ✅ XLSX misalignment now fails loudly: a data cell under an
  unnamed header column raises rather than being dropped by `zip(strict=False)`.
  ✅ yfinance empty-dict (delisted/typo) results now surface to the user:
  `enrich_instrument` reports the symbol via an `on_unresolved` callback and the
  importer collects them into `ImportResult.unresolved_symbols`, shown in the
  Transactions import status.
* **D3** — ✅ done. The parsers no longer abort on the first unknown action: each
  unmapped/`un-parseable` row is collected as a `RowIssue` (and skipped) so one
  `MERGER` row no longer discards a 100-row import. Reported via
  `ParseReport.errors` / `ImportResult.errors`.
* **D4** — ✅ done. Light per-row consistency checks (`adapters/row_validation.py`):
  non-negative price, non-zero quantity on trade rows, and
  `amount ≈ quantity × price` (± fees) for buy/sell/reinvest. Failures are
  *warnings* — the row is still imported but flagged in
  `ImportResult.warnings`.
* **D5** — ✅ done. The US-locale decimal/date assumption is documented and
  enforced in one place (`adapters/locale_parsing.py`): an EU-locale value
  (comma decimal, `DD/MM` date) now raises `LocaleError` and is reported as a
  per-row error instead of being silently mis-parsed by `replace(",", "")`.

### E. UI / UX

* **E1** — ✅ done. A new **Data Health** page (`/diagnostics`, **H1**) plus a
  header shield badge (tinted amber/red, present on every page via
  `ui/layout.py`) surface the previously-silent degradations — transactions
  missing a EUR/USD leg, instruments with missing/stale/corrupt prices,
  holdings that value to nothing, and provider failures — in one actionable
  view. The overview's existing zero-value / corrupt-price banners remain.
* **E2** — ✅ done. A reusable `deferred` component (`ui/components/deferred.py`)
  paints a centered spinner immediately, then runs the heavy build on a one-shot
  timer so the page shell appears before the metrics/positions/projection crunch
  finishes. Wired on the three heaviest pages — Overview, Analytics and
  Projection — replacing their previously synchronous up-front render.
* **E3** — ✅ done. The per-instrument attribution table on `/analytics` now
  respects the display-currency switch: every monetary column is converted from
  EUR to the chosen currency (at the window's as-of rate) and the headers are
  relabelled accordingly; the rate-invariant `% of total return` column is
  unchanged. EUR display keeps the values unconverted.
* **E4** — ✅ done. New pure, unit-tested validators (`ui/forms.py`:
  `validate_date`/`validate_decimal`/`validate_symbol`) are wired as NiceGUI
  inline `validation=` callbacks on the manual "New Transaction" form (date
  bounds, numeric/sign bounds, and symbol presence/shape per kind, re-checked
  when the kind changes), gating Save instead of validating only on submit.
  The "Create target allocation" dialog gained a live running weight total that
  turns green at 100 %.
* **E5** — ✅ verified already guarded (see "Verified already fixed" above):
  the projection seed gates the implied-FX ratio on a positive EUR value and
  `_render_implied_fx` returns early on a non-positive horizon value, so a
  zero-value portfolio can't drive a division/`inf`.
* **E6** — ✅ done. The duplicated local `_fmt_pct` in `overview.py` and
  `analytics.py` was removed in favour of `money_format.fmt_pct`, and the inline
  `f"€{…}"` / `f"${…}"` literals in `calculator.py` now route through
  `money_format.fmt_money`, so currency/percent rendering has a single source.
* **E7** — ✅ done. A reusable `confirm_dialog` component
  (`ui/components/confirm.py`) now gates the overwriting/irreversible data
  actions on Settings: "Seed default setup" (may duplicate on a populated
  ledger) and "Recalculate FX-derived values" (`backfill_missing_legs(force)`
  overwrites every stored leg) both pop a Cancel/confirm modal before running.
  The factory-reset flow already had its own typed-`RESET` confirmation.

### F. Documentation & version hygiene

* **F1** — ✅ done. README status pill re-synced to v3.0.0. The false "UI layer
  only calls services, never reaches into repos" claim in
  `requirements_and_project_overview.md` is corrected to match reality (and
  `docs/architecture.md` / `CONTRIBUTING.md`, which already documented that
  read-heavy UI pages may read ledger-tier repositories directly). Stale version
  baselines (v2.9.4 / v2.11.1) in the docs were bumped to v3.0.0.
* **F2** — ✅ done. Delivered plan docs (`v2.0_split_cloud_security_plan.md`,
  `v2.2-feature-bump-plan.md`, `v2.8-cleanup-plan.md`, and the also-shipped
  `v2.10.1-plan.md`) moved under `docs/history/` with an index `README.md`;
  the remaining live references (`README.md`, `CHANGELOG.md`) were repointed.
* **F3** — ✅ done. `docs/maintenance_audit.md` re-baselined against 3.0.0: a
  status block at the top records each §0 "do-soon" item's current state — the
  `^IRX` tooltip (now correct: the code default *is* `^IRX`), the EUR-as-USD
  fallback (closed by A1, residual A2 cross-referenced), CHANGELOG/version,
  per-tier Alembic and onboarding passphrase (all closed), with true-TWR (G)
  and the doc re-sync (F1) flagged as still open.
* **F4** — ✅ verified complete. The named symbols (`db.py` legacy
  `get_engine`/`get_session_factory`, `money_format.fmt_pair`) were already
  removed by the v3.0 work that landed on `main`; a repo-wide search confirms
  zero remaining references. A `vulture` pass (≥80 % confidence) reports no
  remaining dead code, and the lower-confidence hits are NiceGUI page
  callbacks, enum members consumed by `.value`, or repo/service helpers still
  exercised by the test-suite — i.e. not *confirmed* dead. No removal made:
  the only candidates left are covered by tests, so deleting them would mean
  deleting their tests.

### G. Functionality gaps for 3.0

* **G1** — ✅ resolved (kept + documented, not removed). `transfer_in` /
  `transfer_out` are *not* dead: they are offered in the manual "New
  Transaction" form (`transactions._kinds()` enumerates the whole enum) and are
  treated as external contributions / withdrawals everywhere flows matter
  (`metrics_service`, `benchmark_service`, `_deposits_query`, `_period_query`).
  CSV importers deliberately normalise broker "transfer in/out" rows to
  `deposit` / `withdrawal` via the per-broker action maps, so the kinds exist
  for manual inter-account moves. A class-level comment on `TransactionKind`
  now records this contract so they aren't mistaken for dead code again.
* **G2** — ✅ resolved (already implemented; stale labels corrected). The
  per-period growth on Monthly/Yearly is a true daily-snapshot TWR:
  `_period_query._chained_twr` geometrically links each sub-period's
  Modified-Dietz return across the stored daily snapshots, degrading to a single
  Modified-Dietz only when interior snapshots are sparse. The user-facing
  footnotes on `/monthly` and `/yearly` (which still called it "Modified Dietz")
  were corrected to describe the chained TWR.
* ~~Stale split-cache after a manual ticker change~~ — ✅ done (see "Verified
  already fixed" above): the symbol-edit path invalidates closes and splits.

### H. Cross-cutting ideas

* **H1 — "Data Health / Diagnostics" page.** ✅ done. `services/diagnostics_service.py`
  runs one **read-only** sweep (`check_health` for the page, the lighter
  `quick_status` for the header badge) that reuses the live services, and
  `ui/pages/diagnostics.py` renders it at `/diagnostics` (in the sidebar nav,
  with a header shield badge that tints amber/red). It lists FX-coverage gaps /
  incomplete legs, missing/stale/corrupt prices, zero-value holdings, and the
  last provider outcome. Unmapped import actions remain surfaced at import time
  (`ImportResult.unknown_actions`); persisting them for the page is a future
  extension noted under the importer row-ledger recommendation (#4 below).
* **H2** — ✅ done (golden-master harness).

---

## Agent's additional recommendations (beyond the original list)

1. **A typed `FxResult` / fail-closed sentinel shared across the valuation
   sites.** A2, A1, and the B-engine all hinge on one question — "what do we do
   when a rate is missing?" Rather than each call site re-deciding (`Decimal(1)`
   here, `None` there, `ZERO` elsewhere), introduce one small value type that
   makes "unavailable" unrepresentable-as-a-number. It would let the compiler
   (mypy, already strict on `domain/`) enforce the policy uniformly and kill the
   whole *class* of "EUR-as-USD"/par-value bugs A1/A2 are instances of.

2. **Promote the golden-master into its own fast CI gate, and extend it with a
   property-based invariant.** Beyond byte-stability, add a Hypothesis test
   asserting structural invariants that must hold regardless of the refactor —
   e.g. "with a constant EUR→USD rate `r`, every `*_usd` monetary field equals
   its `*_eur` counterpart × `r`," and "all `*_growth_*` fields are `None` or in
   `[-1, ∞)`." Byte-stability locks the *current* numbers; invariants lock the
   *relationships*, catching a wider class of B-series regressions.

3. **A process-wide secret-redaction log filter.** ✅ **Landed with C5.** C4
   (passphrase-on-CLI) and C5 (token echoed in HTTP error bodies) are two
   instances of the same hazard: a secret reaching a log sink. `redaction.py`
   now provides `redact_secrets` plus a `SecretRedactingFilter` that
   `configure_logging` installs on the root handler, scrubbing known secret
   shapes (GitHub PATs `ghp_…`/`github_pat_…`/`gho_…`, `Bearer`/`token`
   credentials) from every record — a small, central, defence-in-depth net that
   keeps the *next* accidental `log.exception(resp.text)` from leaking a
   credential. (The mobile/SQLCipher passphrases are masked at the call sites
   that hold them via the `extra=` argument.)

4. **Make the Vanguard/Fidelity importers report a structured row-ledger.** ✅
   **Landed.** D2/D3/D4 all wanted the importer to *collect* per-row outcomes
   (imported, dropped, unknown-action, validation-failed) instead of aborting on
   the first problem. `adapters/importer_types.ParseReport` (rows, sweeps,
   `unknown_actions`, `errors[]`, `warnings[]`) is now returned by all three
   parsers and folded into `ImportResult` (plus `unresolved_symbols` from
   enrichment), so the Transactions import surface renders one reconciliation
   summary. The XLSX misalignment guard remains a fail-fast structural stop on
   top of this per-row reporting. This is the natural feed for the H1
   Data-Health page when it lands.
