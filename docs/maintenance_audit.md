# Maintenance Audit — resolution pass & remaining backlog

_Generated 2026-05-31 against `v2.9.4`._
_Re-baselined 2026-06-21 against `v3.0.0` (see the status block below)._

> ## ♻️ Re-baseline against v3.0.0 (F3)
>
> Most of the §0 "do-this-soon" list has since shipped. Current status:
>
> | Item | Status @ 3.0.0 | Evidence |
> | --- | --- | --- |
> | 🔴 1 — risk-free tooltip | ✅ **closed** | The code default *is* `^IRX` now (`services/risk_free_service.py:46`, `DEFAULT_SYMBOL = "^IRX"`), and the tooltip text matches (`ui/copy/tooltips.py:116`). The earlier "should be `^TNX`" note is obsolete — yfinance's `Ticker.history` serves `^IRX` reliably, so the workaround was reverted. |
> | 🔴 2 — EUR-as-USD fallback | ✅ **mostly closed** (A1) | `_overview_query.py` degrades a missing USD leg to `None` (`cv_usd = cv_eur * today_rate if today_rate not in (None, 0) else None`), and `metrics_service` no longer relabels EUR as USD. The remaining policy-level fallback in `positions_service::_eur_rate_for` is tracked as **A2** in `pre_v3_audit_remaining.md` (latent until a third currency lands). |
> | 🔴 3 — docs that lie | ✅ **closed** (F1) | README status pill re-synced to 3.0.0; `docs/architecture.md`, `CONTRIBUTING.md` and `requirements_and_project_overview.md` now state that read-heavy UI pages may read ledger-tier repositories directly (the old "UI never touches repos" claim is gone). |
> | 🟠 4 — CHANGELOG / version | ✅ **closed** | `pyproject.toml` and `__init__.__version__` are `3.0.0`; the CHANGELOG documents the `3.0.0` release. |
> | 🟠 5 — per-tier Alembic | ✅ **closed** (already noted below). |
> | 🟠 6 — onboarding passphrase | ✅ **closed** (already noted below). |
> | 🟢 7 — true daily-snapshot TWR | ✅ **closed** | Per-period growth on Monthly/Yearly is now a true daily-chained TWR (`ui/pages/_period_query.py::_chained_twr` geometrically links each sub-period's Modified-Dietz return across stored daily snapshots, degrading to a single Modified-Dietz only when interior snapshots are sparse). Tracked as **G2** in `pre_v3_audit_remaining.md`. |
>
> The detailed sections below are preserved verbatim as the original
> 2.9.4 first-pass; treat this block as the authoritative current status.


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

## 5. Performance / efficiency backlog (added 2026-06-21 — ✅ fully cleared)

A profiling pass over the hot render path, the synchronous cold-start path and
the repository layer surfaced the following inefficiencies. They were tracked
here as a live checklist; **every item below is now resolved** (5A–5D batched /
gated / indexed, 5E closed — see per-item notes), so the performance audit is
complete. Add any newly-found inefficiency here as a fresh `5x.N ⏳` item.

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
- **5C.11 `compute_positions` historical valuation N+1** — ✅ done.
  When `as_of < today` (every YTD start-of-year valuation and every cached
  period-closing snapshot), `compute_positions` issued
  `prices_service.close_as_of(instr.id, as_of)` **and**
  `cumulative_split_factor_after(instr.id, as_of)` once per held instrument — an
  N+1 over the holdings table on top of the already-batched daily-growth path
  (5A.1). Both are now batched by `instrument_id`: a single window query
  (`prices_repo.closes_as_of`) forward-fills every held instrument's close as of
  the date, and one grouped lookup (`splits_repo.cumulative_factors_after`)
  returns each instrument's post-`as_of` split factor (absent ⇒ "no cached split
  data, fall back to ledger rows"). _Found along the way:_ the **today** path
  (`as_of == today`) shared the identical N+1 via per-instrument `latest_close`,
  so it was batched too (`prices_repo.latest_closes`). Historical and live
  valuation are now O(1) round-trips, completing the spirit of 5A.4 / 5E.B.

### 5D — Missing index (low–medium impact)

- **5D.10 `fx_history` index for its actual query shape** — ✅ done. The PK is
  `(date, base, quote)` (date leading) but every lookup filters
  `WHERE base=? AND quote=?` then orders by `date` (`fx_repo.py`). Added an
  index on `(base, quote, date)`. (`price_history` was re-checked and its
  `(instrument_id, date)` PK already covers its queries — no change needed.)

### 5E — Cross-cutting ideas (resolved)

- **5E.A Defer slow cold-start work off the critical path** — ✅ resolved by
  cadence-gating. `5B.5`/`5B.6` interval-gate the rolling backup (hourly) and
  the integrity check (daily), so on the overwhelming majority of cold starts
  both are skipped entirely and cost nothing on the path before the UI opens.
  The further step of moving them onto the deferred background thread is
  **deliberately declined**: both currently run _before_ `_run_migrations()`, so
  they act as a pre-migration safety net (a clean-integrity snapshot taken
  before any schema mutation). Relocating them after the UI opens would run them
  post-migration and forfeit that guarantee — a real safety regression for only
  a few milliseconds of perceived-startup gain. The gating already captured the
  win at no risk.
- **5E.B Request-scoped valuation cache** — ✅ resolved (made moot). The idea was
  a shared per-session memo to collapse the overlapping N+1s that 5A.1–5A.4 each
  recomputed. With every one of those paths — plus 5C.11's historical/live
  valuation — now individually batched to O(1) round-trips, the per-instrument
  fan-out the cache was meant to absorb no longer exists. A request-scoped cache
  would now save only whole-call recomputes across pages within one navigation,
  which the existing snapshot cache (`snapshots_service`) already covers for the
  expensive historical series. No further work needed; revisit only if profiling
  surfaces a new shared hot path.

### 5F — Periods pages blocked the render path (added 2026-06-21 — ✅ done)

- **5F.12 Monthly/Yearly built their heavy body synchronously** — ✅ done.
  Unlike Overview/Analytics/Projection (which already used the `deferred`
  spinner-then-build helper), `ui/pages/monthly.py` and `ui/pages/yearly.py`
  ran their full `aggregate(...)` roll-up (plus the Yearly daily value series)
  **inside** the `@ui.page` body, so NiceGUI couldn't send the page until all
  of it finished. On a real ledger that left the tab blank for seconds and,
  because the synchronous build also blocked the event loop, rapidly toggling
  Monthly ↔ Yearly could trip the socket reconnect window and "break it every
  time". Both pages now paint a header immediately and run the heavy work via
  `deferred(_build_body)`, matching the other pages.
- **5F.13 Rapid view switching piled work onto dead tabs** — ✅ done. `deferred`
  now captures the request's `context.client` and skips the heavy `build`
  entirely if `client.has_socket_connection` is false by the time its one-shot
  timer fires — so clicking through views again and again never stacks expensive
  database work on tabs the user already navigated away from.

### 5G — Heavy work still ran on the event loop (added 2026-06-22 — ✅ done)

3.3.0 added a `compute` hook to `deferred` (gather on a worker thread via
`nicegui.run.io_bound`, render back on the loop) but only Overview used it; the
other pages and the update/upload actions still crunched on the asyncio loop, so
one slow gather/scan/import could stall the websocket and trip the reconnect
storm. 3.4.2 closes the gap:

- **5G.14 Heavy pages now gather off the loop** — ✅ done. **Holdings**,
  **Analytics**, **Monthly**, **Yearly** and **Projection** were split into a
  render-free `_gather` (`compute=`) and an on-loop render, matching Overview.
- **5G.15 Data Health scanned the DB on the loop** — ✅ done. `render_body` now
  paints its shell first and runs `check_health` through `deferred(compute=…)`.
- **5G.16 CSV import + republish ran on the loop** — ✅ done. The Transactions
  import handler is async and runs `import_csv` and the live-web `run_trigger`
  via `run.io_bound`, disabling the Import button while it works.
- **5G.17 Support-bundle build ran on the loop** — ✅ done. The Data Health
  download builds the bundle via `run.io_bound` so a large log can't stall the UI.

### 5H — Live-web credit economy: idle-market polling (added 2026-06-23 — ✅ done)

The `web/` companion's free-tier credit budget (8/min, 800/day) was being spent
re-fetching prices that could not have changed:

- **5H.18 Market symbols were re-polled while the exchange was closed** — ✅ done.
  Stocks/ETFs kept refreshing on the configured cache window overnight, at
  weekends, and on market holidays even though their settled close was already in
  hand. `marketCacheTtlMs` (`web/src/quotes.ts`) + a new holiday-aware
  `latestSettledSessionDate` (`web/src/market-hours.ts`) now rest a closed-market
  symbol on a long window once we hold its latest close, snapping back to the live
  window the moment the regular session reopens. The reclaimed credits fund
  late-arriving fund NAVs.
- **5H.19 A late NAV was abandoned until the next evening** — ✅ done. The old
  fixed "catch-up window" stopped polling a not-yet-published NAV at a cut-off
  (capped at midnight), so a NAV that struck late waited ~a day to appear.
  `navCacheTtlMs` now simply polls a fund like a normal symbol whenever it is
  behind its expected NAV — no upper cap — and a manual Refresh re-pulls a behind
  NAV (via `loadQuotes`' `forceFetch`) while still sparing an up-to-date one.
- **5H.20 The live 1D graph re-fetched intraday bars every ~minute while open** —
  ✅ done. With the dashboard left open to auto-update, `loadOrBuildSessionCurve`
  (`web/src/intraday.ts`) refreshed all of the 1D sleeve's intraday bars on a 60s
  throttle, so a 20-minute watch re-spent a free-tier credit per symbol several
  times over for interior points that barely move. The open-market cadence
  re-fetch is now **disabled by default** (`DEFAULT_OPEN_REFETCH_MS` = `Infinity`):
  the **live-tip breadcrumb trail** (each whole-book headline total, already
  computed for the dashboard, so free — persisted ~once a minute, *finer* than the
  5-minute bars) is spliced onto the curve and carries it forward on every build,
  so a session needs **just one bar fetch** and a long open watch adds no further
  bar pulls. A caller can still pass a finite `minRefetchMs` (e.g. 15 min) to opt
  back into periodic interior top-ups; missing symbols are always backfilled. The
  1W curve already fetched its daily closes only once
  per window advance, so it was already economical; the history (1M+) graphs end
  on the same appended live tip (`renderValueChart`), so their final value tracks
  the live total on each refresh too.

- **5H.21 A log-out / log-in-again left a flat gap in the live 1D curve** —
  ✅ done. The breadcrumb trail (5H.20) only grows while the tab is visible and
  auto-refresh is ticking; locking the app or hiding the tab pauses refresh, so an
  absence stops the trail. On return, the curve jumped in a single straight line
  from where it was left to the live tip — a dead span that looked like a glitch.
  `loadOrBuildSessionCurve` now takes a `resumeBackfillMs` window
  (`DEFAULT_RESUME_BACKFILL_MS` = 10 min, safely above the slow ~5-min refresh
  cadence). While open, if the session's freshness anchor — `max(updatedAt, newest
  breadcrumb)`, i.e. the last time the dashboard actually touched the session — has
  aged past the window, the next build repulls the **whole** session (every symbol
  plus the FX track), bridging the gap with real bars instead of a jump. A
  continuously-open dashboard lays breadcrumbs faster than the window, so it never
  trips; only a genuine absence does. Since the credit is spent on return anyway,
  the repull grabs the full session for the best possible curve. Pass
  `resumeBackfillMs = Infinity` for pure breadcrumb mode.

## 6. Observability / shareable diagnostics (added 2026-06-21 — ✅ done)

- **6.1 No persistent log file to share** — ✅ done. `logging.configure_logging`
  added a `RotatingFileHandler` (default `logs/dashboard.log` beside the active
  DB; size/backup/dir configurable via `INV_DASHBOARD_LOG_*`) alongside the
  existing stderr stream. It is best-effort: a read-only data dir falls back to
  console-only logging instead of blocking boot. The secret-redacting filter is
  applied to the file sink too, so nothing sensitive is written to disk.
- **6.2 One-click support bundle** — ✅ done. `services/support_bundle.py` builds
  a single plain-text file — app version, platform, redacted config summary and
  the tail of `dashboard.log` — surfaced as a "Download support bundle" button on
  the Data Health page so a slow/broken session can be reported with the actual
  logs attached.
