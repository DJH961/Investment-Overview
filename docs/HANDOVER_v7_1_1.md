# Handover Notes: `v7.1.1` Improvements (`fix_holding_graph_scaling`)

> **Temporary handover document** — delete `docs/HANDOVER_v7_1_1.md` before merging the final `v7.1.1` PR into `main`.

## 1. Git & Branch State

- **Branch:** `fix_holding_graph_scaling`
- **Base commit:** `56cb6113` (`origin/main`, `v7.1.0`)
- **Latest pushed code commit:** `b1de6c72` (`chore: wip v7.1.1 improvements snapshot`, 48 files changed)
- **Worktree / dev environment:** All code changes for the 7 requested improvements have been written into the branch and pushed so work can continue cleanly from another device.

---

## 2. Implemented Changes (`b1de6c72`)

### 1) Daily Brief ("Since you last looked") timestamp reference
- Anchors `window_move` on the actual `visit_from` intraday 1D sample (`start_basis="intraday"`) rather than snapping back to session close/start when part of a session was already watched live.
- Handles stock intraday bars (`intraday_symbol_prices`, `kind="holding"`), twin-estimated NAV mutual funds (`twin_estimates`), and same-day cash/flows before `visit_from` so movers and headline deltas reflect the true window move.
- **Files:**
  - `backend/src/investment_dashboard/services/brief_window_service.py`
  - `backend/src/investment_dashboard/readmodels/brief.py`
  - `backend/tests/api/test_brief.py`
  - `frontend/src/components/DailyBrief/DailyBrief.tsx`
  - `frontend/src/components/DailyBrief/DailyBrief.test.tsx`

### 2) Risk Attribution totals formatting
- Moved Risk Attribution totals out of the external strip underneath the table into column-aligned `<tfoot>` rows in `DataTable` on desktop and a paired summary card on mobile.
- **Files:**
  - `frontend/src/components/DataTable/DataTable.tsx`
  - `frontend/src/components/DataTable/DataTable.scss`
  - `frontend/src/components/DataTable/DataTable.test.tsx`
  - `frontend/src/pages/Risk/Risk.tsx`
  - `frontend/src/pages/Risk/Risk.scss`
  - `frontend/src/pages/Risk/Risk.test.tsx`

### 3) Holding deep-dive Back button origin tracking
- Opening a holding deep dive from Overview (or via `LookupSearch` from another page) now returns to the originating page instead of always linking back to `/holdings`, and preserves the origin across tab switches.
- **Files:**
  - `frontend/src/pages/Holding/Holding.tsx`
  - `frontend/src/pages/Holding/HoldingHeader.tsx`
  - `frontend/src/pages/Holding/Holding.test.tsx`
  - `frontend/src/pages/Lookup/Lookup.tsx`
  - `frontend/src/pages/Lookup/Lookup.test.tsx`
  - `frontend/src/components/OverviewHoldings/OverviewHoldings.tsx`
  - `frontend/src/components/OverviewHoldings/OverviewHoldings.test.tsx`
  - `frontend/src/components/LookupSearch/LookupSearch.tsx`

### 4) Health & Repair (Diagnostics) tabs on mobile
- Fixed the cramped 6-tab `SegmentedControl` and tightened mobile card/layout wrapping and spacing in Diagnostics -> Health & Repair.
- **Files:**
  - `frontend/src/pages/Diagnostics/Diagnostics.tsx`
  - `frontend/src/pages/Diagnostics/Diagnostics.scss`
  - `frontend/src/pages/Diagnostics/HealthTab.tsx`
  - `frontend/src/pages/Diagnostics/RepairTab.tsx`
  - `frontend/src/pages/Diagnostics/Diagnostics.test.tsx`

### 5) Backfilling 1W per-holding intraday bars (`kind="holding"`)
- Added `HoldingIntradayCoverage`, `_holding_intraday_gaps`, `assess_holding_intraday_coverage`, and `backfill_holding_intraday_prices` in `intraday_snapshots_service.py` (also wired into `backfill_graphs`, `reload_week_graph`, and `reload_graphs`), populating `intraday_symbol_prices` without wiping stored portfolio `intraday_value` points.
- Surfaced gap detection in Health (`holding_intraday_graph`) with a one-click Repair action (`graphs.backfill_holdings`).
- **Files:**
  - `backend/src/investment_dashboard/services/intraday_snapshots_service.py`
  - `backend/src/investment_dashboard/services/diagnostics_service.py`
  - `backend/src/investment_dashboard/readmodels/diagnostics.py`
  - `backend/src/investment_dashboard/services/maintenance_service.py`
  - `backend/tests/services/test_holding_intraday_backfill.py` (new)
  - `backend/tests/api/test_maintenance.py`

### 6) Individual holding chart Y-axis scaling + Display setting
- Added `display.holding_chart_cost_scale` (`"auto"` default: omits `Avg cost` / `Invested` from Y-domain scaling when it would flatten the curve; `"always"`; `"never"` / `"Data only"`).
- Exposed in Settings (`Display`) and wired through presentation cache invalidation, `displayPrefs`, `Chart`, and `PerformanceTab`.
- **Files:**
  - `backend/src/investment_dashboard/services/settings_registry.py`
  - `backend/src/investment_dashboard/services/read_cache.py`
  - `frontend/src/lib/queries/invalidation.ts`
  - `frontend/src/lib/displayPrefs.tsx`
  - `frontend/src/lib/displayPrefs.test.tsx`
  - `frontend/src/pages/Settings/SettingField.tsx`
  - `frontend/src/components/Chart/Chart.tsx`
  - `frontend/src/components/Chart/Chart.scss`
  - `frontend/src/components/Chart/Chart.test.tsx`
  - `frontend/src/pages/Holding/PerformanceTab.tsx`

### 7) Faster 1W previews (`HoldingPeek`) on Holdings page
- Added cached batch endpoint `GET /api/holdings/peeks` + idle batch preloading (`usePrefetchHoldingPeeks`) and hover/focus prefetch (`prefetchHoldingPeek`) to populate individual peek query cache entries before a row is expanded.
- **Files:**
  - `backend/src/investment_dashboard/api/holdings.py`
  - `backend/src/investment_dashboard/api/schemas/holdings.py`
  - `backend/src/investment_dashboard/readmodels/holding_peek.py`
  - `backend/tests/api/test_holding_peek.py`
  - `frontend/src/lib/queries/holding-detail.ts`
  - `frontend/src/pages/Holdings/Holdings.tsx`
  - `frontend/src/pages/Holdings/HoldingMobileRow.tsx`
  - `frontend/src/pages/Holdings/Holdings.test.tsx`

---

## 3. Verification Status So Far

### Passed earlier in session (before final snapshot commit, re-verify after remaining edits)
- `backend/tests/services/test_settings_registry.py` (5/5 passed)
- `backend/tests/readmodels/test_holdings.py` & `backend/tests/services/test_holding_deep_dive.py` (17/17 passed)
- `frontend`: `npm run typecheck`, `npm run lint`, `npm run test` (96 test files, 873/873 passed, including `tokens.cvd.test.ts`)

### NOT YET VERIFIED (Priority 1 on next device)
> **Note on Windows sandbox:** Starlette `TestClient` tests (`tests/api/*.py`) hang inside the restricted Windows sandbox (`ProactorEventLoop._make_self_pipe` loopback socket restriction). Run `tests/api/*.py` outside the sandbox (or on Linux/macOS / CI).

1. Check & run backend formatting, lint, types, layering contracts, and service/domain tests on `b1de6c72` (especially `intraday_snapshots_service.py`, `brief_window_service.py`, `brief.py`, `diagnostics_service.py`, `maintenance_service.py`):
   ```bash
   cd backend
   uv run ruff format --check .
   uv run ruff check .
   uv run mypy src/investment_dashboard/domain
   uv run lint-imports
   uv run pytest tests/services/test_holding_intraday_backfill.py tests/domain/test_brief_window_move.py tests/services/test_settings_registry.py tests/readmodels/test_holdings.py tests/services/test_holding_deep_dive.py
   ```
2. Run backend API tests outside any socket-blocking sandbox:
   ```bash
   cd backend
   uv run pytest tests/api/test_brief.py tests/api/test_holding_peek.py tests/api/test_holdings.py tests/api/test_maintenance.py tests/api/test_diagnostics.py
   ```
3. Check activity logging expectations (`AGENTS.md` -> "Keep in step with every feature"): verify whether `graphs.backfill_holdings` or `GET /api/holdings/peeks` needs any additions in `activity_log.py` / `api/activity.py` / `deploy/RUNBOOK.md`.

---

## 4. Remaining Work Before `v7.1.1` Release & PR Merge

1. **Fixture mode support for `GET /api/holdings/peeks`:**
   - Update `frontend/src/fixtures/v71.ts` and `frontend/src/fixtures/install.ts` so `GET /api/holdings/peeks` returns `{ peeks: ... }` using the existing `peek(...)` helper (prevents 404s in offline demo / fixture mode).
2. **Version bump `7.1.0` -> `7.1.1` in lockstep:**
   - `backend/pyproject.toml`
   - `frontend/package.json`
   - `web/package.json`
   - Regenerate lockfiles: `uv lock` (in `backend/`), `npm install` (in `frontend/` and `web/`).
3. **OpenAPI & TypeScript contract regeneration (AFTER version bump):**
   - `cd backend && uv run python -m investment_dashboard.tools.export_openapi openapi.json`
   - `cd frontend && npm run gen:api`
   - Update `HoldingPeeksDto` in `frontend/src/lib/queries/holding-detail.ts` to use `S["HoldingPeeksResponse"]` if appropriate.
   - Check `frontend/src/lib/queries/__snapshots__/invalidation.test.ts.snap` if `invalidation.ts` snapshot tests need updating (currently untouched vs `v7.1.0` except `PRESENTATION_SETTINGS` edit).
4. **Update `CHANGELOG.md`:**
   - Add dated `## [7.1.1] — YYYY-MM-DD` section above `## [7.1.0] — 2026-11-21` covering all 7 improvements under `### Added` / `### Fixed`.
5. **Clean up temporary handover doc:**
   - Remove `docs/HANDOVER_v7_1_1.md` before opening/merging the final release PR to `main`.
6. **Final Quality Gate (`AGENTS.md`):**
   - `backend/`: `ruff format --check .`, `ruff check .`, `mypy src/investment_dashboard/domain`, `lint-imports`, targeted + full API/service `pytest`.
   - `frontend/`: `npm run typecheck`, `npm run lint`, `npm run test` (verifying `tokens.cvd.test.ts` passes).
   - `web/`: `npm run typecheck`, `npm run test`.
7. **Push & open/update PR against `main`.**
