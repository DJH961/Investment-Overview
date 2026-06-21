# Maintenance Audit — resolution pass & remaining backlog

_Originally generated 2026-05-31 against `v2.9.4`._
_Re-verified 2026-06-21 against `v2.11.1` — see "Resolution status" below._

This was the single source-of-truth backlog for three things that had drifted
out of sight across the project's many iterations:

1. **Bugs** that were not previously caught.
2. **Legacy material** — outdated comments, code and markdown.
3. **TODOs / caveats / deferred work** scattered across code and docs.

## Resolution status (2026-06-21, `v2.11.1`)

The original audit was written against `v2.9.4`. Five releases shipped since
(`2.9.6`–`2.11.1`), and a re-verification of every item against the current
tree shows that **all of the actionable §0/§1/§2 items have been resolved** —
either by the intervening releases or in this pass. Only the explicitly
large / future-version items in §3 remain open; they are carried forward below
as the live backlog.

| Section | Status | Notes |
|---|---|---|
| §0 do-soon list | ✅ Done | Items 1–7 resolved (see per-item notes below). |
| §1 bugs (1.1–1.8) | ✅ Done | Every site now degrades to `None`/blank or is correct-and-documented. |
| §2A stale docs | ✅ Done | README/user_guide/architecture/CONTRIBUTING/requirements all refreshed. |
| §2B dead code | ✅ Done | All six flagged symbols removed from the tree. |
| §2C code comments | ✅ Done | Resolved in the original pass. |
| §3 remaining backlog | ⏳ Open | Large / future-version features — see §3 below. |

### §0 — do-soon list (all resolved)

1. **Risk-free tooltip `^IRX`** — _no change needed (audit obsolete)._ The
   recommendation was to switch the tooltip to `^TNX`, but the live default is
   `^IRX` again (`services/risk_free_service.py:46`, `DEFAULT_SYMBOL = "^IRX"`;
   the module docstring explains the `^TNX` work-around is no longer needed).
   The tooltip (`ui/copy/tooltips.py:116`) and the docs that say `^IRX` are
   therefore **correct**.
2. **Silent EUR-as-USD fallback** — ✅ fixed. All sites now return `None`/blank
   when the FX rate is missing (`_overview_query.py:283-288`,
   `_period_query.py:_display_value/_convert_to_usd`, `metrics_service.py:102`).
3. **User-facing docs** — ✅ refreshed (README status is `v2.11.1`; user_guide
   describes the standalone Projection page and editable storage; architecture
   and CONTRIBUTING state "UI may read repositories directly").
4. **CHANGELOG coherence** — ✅ the `2.9.4` entry exists and history is
   continuous through `2.11.1`; the orphaned `2.11.1` portable-bundle bug-fix
   block was given its missing `## [2.11.1]` heading in this pass, and a
   regression test now guards it (`tests/test_changelog_version.py`).
5. **Per-tier Alembic version tables** — ✅ done (boot stamps each tier).
6. **Onboarding passphrase + recovery file** — ✅ done (Settings → Storage).
7. **True daily-snapshot TWR per period** — ✅ done
   (`_period_query._chained_twr` geometrically links per-sub-period
   Modified-Dietz across stored daily snapshots).

### §1 — bugs (all resolved)

- **1.1 / 1.2 EUR-relabelled-as-USD** — fixed; see §0 #2.
- **1.3 Modified-Dietz on padded future periods** — fixed: future periods are
  guarded (`_period_query.py` — `if period_open > today: growth = None`).
- **1.4 `native_to_eur_rate` for USD** — correct-and-documented: it is the
  quote-per-1-EUR (EUR→native) rate consumed as `net_native / rate`, matching
  the general branch; a clarifying comment now prevents a future inversion.
- **1.5 / 1.6 single FX rate for non-EUR positions/cash** — fixed:
  `positions_service` now keys a per-currency `rate_cache` and fetches
  `quote=ccy`.
- **1.7 CAGR total loss** — fixed: `end_value == 0` returns a clean −100 %
  (`domain/returns.py`).
- **1.8 `_amount_eur` returns `ZERO`** — fixed: unconvertible non-EUR/USD rows
  return `None` so they are skipped rather than poisoning the bucket.

### §2 — legacy material (all resolved)

- **2A docs** — every stale claim in the original table has been corrected.
- **2B dead code** — `get_engine`, `get_session_factory`, `list_snapshots`,
  `delete_transaction`, `list_accounts_currency_map`, `driver_available`, and
  `fmt_pair` are all gone from `src/`.

---

## 3. Remaining backlog (carried forward)

These are the only open items. They are intentionally large / future-version
and are **not** quick fixes — track them here until scheduled.

### 3.1 Medium

- **Auto-populate instrument category/asset-class** beyond the current
  yfinance `category`/`sector` capture — downgrade the Settings field to
  read-only + "refresh" (`docs/v2.0_split_cloud_security_plan.md:80-82`).
  _(Partially done: `yfinance_client` already captures `category`; the
  read-only UI flip is the remainder.)_

### 3.2 Low / large effort

- **Android app (Phase 3)**, Settings→Mobile panel, optional snapshot
  encryption — `docs/mobile_android_app_proposal.md:179-186`.
- **In-app mobile update check** — `docs/mobile_android_app_proposal.md:160`
  (depends on the Android app).
- **Multi-device write queue / "secondary device" mode** (explicitly v3) —
  `docs/v2.0_split_cloud_security_plan.md:452-453`.
- **Document the Tailscale mesh-VPN exposure path** (docs-only) —
  `docs/mobile_android_app_proposal.md:112`.
- **Planned-purchase persistence + execution tracking** (`planned_transactions`
  table) — `requirements_and_project_overview.md:596,804`.
- **Savings Bank PDF Kontoauszug parser** —
  `requirements_and_project_overview.md:803`. (The *CSV* importer is
  permanently out of scope — the broker has no CSV export.)
- **APScheduler background daily refresh** —
  `requirements_and_project_overview.md:806`. Currently a deferred boot thread.

### 3.3 Permanent caveats / non-goals (kept for reference)

- No real-time intraday quotes (EOD prices only).
- No multi-user / no auth beyond local-network binding.
- No tax-lot / capital-gains accounting.
- No trading execution (read-only re: brokers).
- Fidelity 2-decimal price granularity since May 2024 (handled by recompute in
  `adapters/fidelity/parser.py`).
- Vanguard 18-month export window.
- Savings CSV importer out of scope (no broker export).

---

## 4. Suggested next maintenance improvements (proposed, not yet scheduled)

Beyond clearing the backlog, two guard-rails would stop this audit's two most
common failure modes from recurring:

1. **CHANGELOG-vs-version guard** — ✅ added this pass.
   `tests/test_changelog_version.py` fails CI if `pyproject.toml`'s version has
   no matching `## [x.y.z]` heading in `CHANGELOG.md`, which is exactly the
   orphaned-`2.11.1`-block bug that prompted §0 #4.
2. **Audit-freshness check (idea)** — a tiny test (or pre-commit hook) that
   asserts the `_Re-verified … against vX.Y.Z_` line at the top of this file
   matches the current `pyproject` version, so a stale backlog can't silently
   drift more than one release behind the code again.

### How to use this file
Pick items from §3 and they'll be actioned in order. The §3.1 instrument
category read-only flip is the smallest remaining piece; everything else in
§3.2 is a deliberate future-version feature.

---

## 5. Performance / efficiency backlog (added 2026-06-21)

A profiling pass over the hot render path, the synchronous cold-start path and
the repository layer surfaced the following inefficiencies. They are tracked
here as a live checklist; status is updated as each is resolved.

### 5A — Hot-path inefficiencies (run on every page render)

- **5A.1 Overview N+1 daily-growth price lookups** — ✅ done.
  `_instrument_daily_growth` (`ui/pages/_overview_query.py`) issued
  `recent_price_dates` + two `close_as_of` per held position (3 DB round-trips ×
  N). Now the print dates and closes are batched once for all instruments and
  the per-row helper indexes into the prebuilt dicts.
- **5A.2 Analytics computes `compute_portfolio_metrics` twice** — ✅ done.
  `build_bundle` already computed `portfolio_metrics` internally, then
  `analytics.py` called `compute_portfolio_metrics(session)` again — a full
  XIRR/contribution recompute per render. The metrics are now returned on
  `AnalyticsBundle.metrics` and reused.
- **5A.3 Periods page double ledger walk + per-period snapshot reads** — ✅ done.
  `_period_query.aggregate` now fills the EUR **and** display-currency buckets
  in a single ledger walk (previously it iterated the full `txns` list a second
  time whenever the display currency ≠ EUR) and batches every period boundary
  snapshot through `snapshots_service.get_or_compute_many` plus one bulk
  interior-range read, replacing the `get_or_compute` per period inside the
  bucket loop (2N cache round-trips). Display-currency boundaries are derived
  from the EUR batch in memory rather than re-read.
- **5A.4 Overview YTD second `compute_positions` walk** — ✅ done.
  `compute_instrument_metrics` now passes its already-loaded ledger to
  `compute_positions(as_of=year_start, transactions=…)`, so the start-of-year
  valuation reuses the in-memory `txns` (filtered to `date <= year_start`)
  instead of issuing a second full ledger query.

### 5B — Startup-path inefficiencies (synchronous, before the UI opens)

These run inside `run_boot_sequence(skip_network=True)` on the cold-start path.

- **5B.5 Rolling backup copies the full ledger + config DB on every boot** —
  ✅ done. `storage/backup.snapshot` always performed a complete
  `backup_database()` copy (decrypt+re-encrypt through SQLCipher) on every
  launch. Added a `min_interval` gate so a backup taken recently is skipped.
- **5B.6 Full `PRAGMA integrity_check` on every boot** — ✅ done.
  `boot._integrity_check_tiers` ran a whole-database scan of each tier
  synchronously before the UI. Now gated by a daily cadence via a marker file;
  it runs at most once per day per process.
- **5B.7 `detect_cloud_sync_root()` is uncached** — ✅ done. It re-ran every
  OneDrive/iCloud/Dropbox/Google-Drive detector (filesystem stats + a Dropbox
  JSON parse + a gdrive `iterdir`) with no memoization even though the result is
  deterministic per process. Now `@lru_cache`d.

### 5C — Repository-layer N+1s (background refresh, still wasteful)

- **5C.8 `prices_service` refresh loops issue per-instrument queries** — ✅ done.
  `refresh_prices` (`latest_price_date` + `earliest_price_date` per instrument →
  2N), `instruments_due_for_refresh` (`get_last_refreshed_at` per instrument →
  N) and `refresh_due_prices` (`latest_price_date` per due instrument) now use
  batched `GROUP BY instrument_id` (MAX/MIN date) / `IN (...)` queries.
- **5C.9 Load-then-filter-in-Python repo helpers** — ✅ done.
  `snapshots_repo.delete_from` SELECTed all matching rows and deleted them
  one-by-one; now a single `DELETE … WHERE`. `allocations_repo.set_active`
  loaded all allocations and flipped `active` in Python; now two bulk
  `UPDATE`s.
- **5C.11 `compute_positions` historical valuation N+1 (found 2026-06-21)** —
  ⏳ open. When `as_of < today` (every YTD start-of-year valuation and every
  cached period-closing snapshot), `compute_positions` issues
  `prices_service.close_as_of(instr.id, as_of)` **and**
  `cumulative_split_factor_after(instr.id, as_of)` once per held instrument — an
  N+1 over the holdings table on top of the already-batched daily-growth path
  (5A.1). Batching these by `instrument_id` (a `close_as_of`-style window query
  + a grouped split-factor lookup) would cut the historical valuation to O(1)
  round-trips, completing the spirit of 5A.4 / 5E.B.

### 5D — Missing index (low–medium impact)

- **5D.10 `fx_history` index for its actual query shape** — ✅ done. The PK is
  `(date, base, quote)` (date leading) but every lookup filters
  `WHERE base=? AND quote=?` then orders by `date` (`fx_repo.py`). Added an
  index on `(base, quote, date)`. (`price_history` was re-checked and its
  `(instrument_id, date)` PK already covers its queries — no change needed.)

### 5E — Cross-cutting ideas (proposed, larger refactors)

- **5E.A Defer slow cold-start work off the critical path** — partially via
  5B.5/5B.6 interval-gating. The next step is to also move the rolling backup +
  integrity check onto the existing deferred background thread (the network
  refresh already proved the pattern), shaving the most wall-clock off perceived
  startup for the least risk.
- **5E.B Request-scoped valuation cache** keyed by `(as_of, ledger-revision)`
  would let 5A.1–5A.4 collapse into shared work: Overview, Periods and Analytics
  each independently recompute positions/metrics/snapshots for overlapping dates
  within a single navigation. A tiny per-session memo (invalidated whenever the
  ledger is written) is a lighter first step than the full valuation engine.
