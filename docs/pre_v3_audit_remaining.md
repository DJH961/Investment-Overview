# Pre-v3.0 Audit — Remaining Work

This document tracks what the pre-v3.0 deep audit identified but that has **not
yet been implemented**. It is the companion to the work already landed.

It re-baselines the audit against the current code (app version **2.11.1**) and
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
| **H2** | Full-metrics golden-master regression harness for `compute_portfolio_metrics`. | `tests/services/test_metrics_golden_master.py`, `tests/services/golden/portfolio_metrics.json` |
| **F1** (partial) | README status pill re-synced from v2.9.4 → v2.11.1. | `README.md` |

### Verified already fixed (no change needed)

* **A4 — Modified-Dietz on padded future periods.** `ui/pages/_period_query.py`
  already guards `period_open > today` and sets growth to `None`
  (≈ lines 453–457), so the −200 % edge no longer occurs.
* **A5 — `_amount_eur` ZERO vs None.** The unconvertible non-EUR/USD path
  already returns `None` (≈ line 180); only the genuinely-no-amount case
  (`net_native is None`) returns `ZERO`, which is harmless to a Modified-Dietz
  denominator. No further change required.

---

## ⏳ Remaining

### A. Correctness

* **A2 — Silent 1:1 FX fallback for non-EUR holdings/cash.**
  `services/positions_service.py::_eur_rate_for` still falls back to
  `Decimal(1)` when a rate lookup fails, and `total_portfolio_value` does the
  same for cash. Latent today (only EUR+USD are live) but a correctness trap
  the moment a third currency is added for 3.0. **Deferred because** a correct
  fix is a *policy* decision that ripples through the return types of
  `compute_positions` / `total_portfolio_value` and every caller; it should
  land together with the B-series valuation engine (below) under golden-master
  protection, not as an isolated edit. Recommended policy: "FX missing ⇒
  value unavailable (`None`/blank), never par."

### B. Performance / execution — the structural refactor

The metrics path re-rolls the whole ledger from inception many times per
render, with nested N+1 price/FX lookups. The single recommended fix is **a
reusable, in-request portfolio-valuation engine that walks the ledger once and
exposes value-at-date, holdings, and cashflows**, reused across the metric set.

* **B1** — `compute_portfolio_metrics` calls `total_portfolio_value()` for
  today, year-start, month-start, and inside daily-growth — each a full
  recompute. Memoise `(session, as_of) → value` / single-pass valuation.
* **B2** — N+1 `latest_close` / `close_as_of` / `cumulative_split_factor_after`
  per held instrument in `compute_positions`. Replace with batched
  "closes/splits for these instrument-ids as-of date" queries.
* **B3** — `_best_effort_ytd_start_value` day-by-day loop (up to 31 full
  valuations). Replace the linear scan with a nearest-snapshot lookup (daily
  snapshots now exist).
* **B4** — `snapshots_service.warm_range` walks day-by-day from inception each
  day. Carry the prior day's holdings forward incrementally.
* **B5** — `build_portfolio_cashflows` loops the full ledger twice (EUR then
  USD). Build both legs in one pass.
* **B6** — `backfill_missing_legs` / deposit queries load whole tables then
  filter in Python. Push the filter into the query.

> ⚠️ **Land B under the H2 golden-master.** The harness committed in this pass
> (`tests/services/test_metrics_golden_master.py`) exists precisely so the
> B-series can prove "same numbers, fewer round-trips." Extend the fixture if a
> KPI it doesn't currently exercise is touched.

### C. Data-safety & storage

* **C1** — `PRAGMA synchronous=NORMAL` for the ledger (`db.py:110`). Consider
  `FULL` for the ledger tier specifically (cache can stay NORMAL), since these
  DBs can live in cloud-sync folders exposed to power loss.
* **C2** — ✅ done (atomic sidecar writes).
* **C3** — Sidecar repair ordering (`storage/sidecar.py`): it checkpoints →
  deletes sidecars → flips `journal_mode`; a crash mid-sequence can leave the
  DB un-openable. Reorder so `journal_mode` is set before/with the checkpoint
  and make the operation restart-safe. *(Verify current ordering first.)*
* **C4** — `--passphrase` on the CLI (`tools/backup.py`, `split_db.py`,
  `repair_sidecar.py`) leaks into `ps`/shell history. Prefer env-var/keyring
  or interactive prompt.
* **C5** — Pre-flight validation for publish (`services/publish_service.py`):
  validate the GitHub PAT scope/expiry *before* upload, and sanitise HTTP error
  bodies so a token can't be echoed into logs.

### D. Adapters / importers

* **D1** — ✅ done (retry/backoff + 429).
* **D2** — Silent row/symbol loss. Surface yfinance empty-dict (delisted/typo)
  results to the user, and switch the Vanguard XLSX `zip(..., strict=False)` to
  a length check rather than silent truncation.
* **D3** — Import aborts on the first unknown action. Collect row-level errors
  and report them together so one `MERGER` row doesn't discard a 100-row
  import.
* **D4** — No input validation on parsed rows. Add light consistency checks
  (positive price; `amount ≈ quantity × price` for non-dividend rows).
* **D5** — US-only decimal/date assumptions. Document the assumption explicitly
  and fail loudly rather than silently mis-parse an EU-locale export.

### E. UI / UX

* **E1** — Make silent degradation (missing FX/prices, dropped rows, failed
  enrichment) visible in the UI.
* **E2** — Loading indicators on heavy pages (Overview, Analytics, Projection)
  — less necessary once B lands.
* **E3** — Currency-toggle inconsistency: attribution tables are hard-coded to
  EUR; make them respect the display-currency switch.
* **E4** — Inline form validation (symbol existence, decimal/date bounds, live
  allocation-weight total) instead of save-time-only.
* **E5** — Projection page empty-state guard (a zero-value portfolio can drive
  division/`inf`).
* **E6** — Consolidate duplicated `_fmt_pct` and inline `f"€{…}"` formatting in
  `overview.py` / `analytics.py` / `calculator.py` onto `money_format`.
* **E7** — Confirmation dialogs for destructive actions (e.g. "Seed default
  setup" overwriting allocations).

### F. Documentation & version hygiene

* **F1** (partial) — README pill done. Still to re-sync: `docs/architecture.md`,
  `CONTRIBUTING.md`, `docs/user_guide.md`, `requirements_and_project_overview.md`
  (the "UI never calls repositories" claim is false; the single-file-DB /
  embedded-projection description is stale).
* **F2** — Archive delivered plan docs (`v2.0_split_cloud_security_plan.md`,
  `v2.2-feature-bump-plan.md`, `v2.8-cleanup-plan.md`) under `docs/history/`.
* **F3** — Re-baseline `docs/maintenance_audit.md` against 2.11.1 (several of
  its items — `^IRX` tooltip, CAGR total-loss, most EUR-as-USD sites, per-tier
  Alembic + onboarding passphrase — are now closed).
* **F4** — Remove confirmed dead code after a final caller check
  (`db.py` legacy `get_engine`/`get_session_factory`, `money_format.fmt_pair`,
  unused repo helpers).

### G. Functionality gaps for 3.0

* `transfer_in` / `transfer_out` enum kinds are reserved but have no
  importer/UI logic — implement or remove from the enum.
* True daily-snapshot TWR per period (currently a Modified-Dietz approximation;
  daily snapshots now exist, so exact TWR is cheap).
* Stale split-cache after a manual ticker change —
  `prices_service.invalidate_instrument_prices` exists but nothing calls it when
  `instruments.symbol` is edited.

### H. Cross-cutting ideas

* **H1 — "Data Health / Diagnostics" page.** A single surface listing FX-coverage
  gaps, instruments with stale/missing prices, unmapped import actions, and
  incomplete transaction legs — converting today's *silent* degradations into
  one actionable view. (Larger feature; deferred.)
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
