# Maintenance Audit — bugs, legacy material & open TODOs

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


This is the single source-of-truth backlog for three things that had drifted
out of sight across the project's many iterations:

1. **Bugs** that were not previously caught (flagged here — **not fixed**).
2. **Legacy material** — outdated or incoherent comments, code and markdown
   (flagged here — **not changed**, except outdated *code comments*, which were
   resolved immediately; see the bottom section for the list).
3. **TODOs / caveats / deferred work** scattered across code and docs,
   consolidated with a recommended **"do soon"** action plan.

Nothing in sections 1–2B has been changed in code/markdown — they are waiting
on your go-ahead. Pick what you want and I'll execute.

---

## 0. Do-this-soon action plan (the short list)

These are the items that actually improve correctness / user-facing
functionality. Ordered by impact.

| Priority | What | Where | Why it matters |
|---|---|---|---|
| 🔴 1 | Fix the wrong risk-free tooltip (`^IRX` → `^TNX`) | `ui/copy/tooltips.py:116` | User-facing text states the wrong default; the actual default has been `^TNX` since v2.4. One-line content fix. |
| 🔴 2 | Decide on the silent **EUR-as-USD fallback** | `_overview_query.py:268,278`; `metrics_service.py:249`; `_period_query.py:250-258` | When an FX rate is missing the USD column shows the EUR number *relabelled* as USD instead of blank — silently wrong figures. Should degrade to `None`/blank. (Bug #1, #2.) |
| 🔴 3 | Refresh the user-facing docs that now lie | `README.md`, `docs/user_guide.md`, `CONTRIBUTING.md` | Status pill says v2.0.0, risk-free shown as `^IRX`, "Storage is not editable", "UI never calls repositories" — all now false. Misleads the only reader (you). |
| 🟠 4 | Wire the **v2.9.4 CHANGELOG entry** | `CHANGELOG.md` | `pyproject.toml` is `2.9.4` but the changelog tops out at `2.9.3` and even has a stale `2.9.1 — Unreleased` block below it. Version history is incoherent. |
| 🟠 5 | Per-tier **Alembic** version tables | `boot.py:349-363`; plan doc | Migrations only run against the ledger DB in split-DB mode. The next schema migration to config/cache tiers will silently not apply for split-DB users. _(done — see CHANGELOG)_ |
| 🟠 6 | Onboarding **passphrase + recovery-file** prompts | `storage/encryption.py:12,84` | Plumbing (`store_passphrase_in_keyring`) exists but no UI calls it; encrypted-mode users can lose data with no recovery path. _(done — Settings → Storage + onboarding now collect the passphrase and offer a recovery file)_ |
| 🟢 7 | True daily-snapshot **TWR per period** | see TODO #12 | Currently a Modified-Dietz approximation; daily snapshots now exist, so the "easy follow-up" is finally cheap. |

Everything below is the full detail behind this list.

---

## 1. Bugs found (flagged, not fixed)

Confidence/severity are first-pass estimates — verify before fixing. Items 5–6
are **latent** (only bite once a third currency is added).

### 1.1 — Silent "EUR value relabelled as USD" fallback  ·  Medium · High confidence
- **Where:** `ui/pages/_overview_query.py:268,278`, `services/metrics_service.py:249`
- When the EUR→USD rate is `None`/`0`, the code does
  `cv_usd = cv_eur * rate if rate else cv_eur` — i.e. it returns the **EUR**
  amount as the USD amount. XIRR(USD), total growth(USD) and YTD growth(USD)
  are then computed against a terminal value that is EUR pretending to be USD.
- **Effect:** wrong USD metrics instead of a clean blank/`None`.

### 1.2 — `_convert_to_usd` / `_display_value` return EUR as USD  ·  Medium · High
- **Where:** `ui/pages/_period_query.py:250-258`
- Same shape as 1.1: on missing FX the EUR value is shown in the USD column.

### 1.3 — Modified-Dietz on padded **future** periods  ·  Medium · Medium
- **Where:** `ui/pages/_period_query.py:362-376`
- For periods that haven't started, opening (and closing) are forced to `ZERO`.
  `_modified_dietz(0, 0, contrib)` evaluates to `-2` (−200 %) rather than
  `None` for any padded future month that carries a contribution. Unlikely in
  practice (future months rarely have contributions) but it's a real edge.

### 1.4 — Wrong `native_to_eur_rate` for USD (latent / dead path)  ·  Low · High
- **Where:** `services/transaction_fx_service.py:88`
- `native_to_eur_rate = eur_to_usd` is the **EUR→USD** rate (~1.08) where a
  "native→EUR" rate should be its inverse (~0.92). Currently harmless because
  `split_native_to_dual_legs` short-circuits for USD before consuming it, but
  it will break if that control flow ever changes.

### 1.5 — Single FX rate used for **all** non-EUR accounts  ·  Medium · High (latent)
- **Where:** `services/positions_service.py:103,126`
- `get_rate_eur_to_quote(...)` defaults to `quote="USD"`. Every non-EUR
  position is then divided by that one USD rate. A GBP/CHF/DKK account would be
  mis-converted. Safe today (only EUR+USD supported since DKK was dropped in
  v2.4) but a correctness trap for any future currency.

### 1.6 — Same single-rate issue for cash balances  ·  Medium · High (latent)
- **Where:** `services/positions_service.py:177-185` — identical to 1.5 for cash.

### 1.7 — CAGR rejects a total loss (`end_value == 0`)  ·  Low · High
- **Where:** `domain/returns.py:233`
- `if start_value <= 0 or end_value <= 0 ...: return None`. A €10k→€0 wipeout
  returns `None` instead of a well-defined −100 % CAGR.

### 1.8 — `_amount_eur` returns `ZERO` instead of `None`  ·  Low · Medium
- **Where:** `ui/pages/_period_query.py:169-172`
- The comment says "leave the figure out" but it returns `ZERO`, which is
  *included* in the bucket — shrinking the Modified-Dietz denominator and
  inflating growth % for unconvertible non-EUR/USD transactions.

---

## 2. Legacy material (flagged — awaiting your go-ahead)

### 2A. Markdown docs that are now stale

| Doc | What's wrong |
|---|---|
| `README.md:10` | Status line says **v2.0.0** (should be 2.9.4). |
| `README.md:276-291` | Roadmap "⏳ follow-ups" lists the Settings sync-folder editor, which shipped in v2.8. |
| `docs/user_guide.md:64-65` | Says risk-free default is **^IRX**; it's **^TNX** since v2.4. |
| `docs/user_guide.md:73-82` | "Storage… nothing here is editable" — v2.8 made the cloud/sync link editable. |
| `docs/user_guide.md:43` | Describes the "Calculator" as the projection tool; projection is now its own `/projection` page (v2.8). |
| `docs/architecture.md:32-35` | "UI never reaches past services" — UI pages now import repositories directly. |
| `CONTRIBUTING.md:39-42` | Same false "UI only calls services, never repositories" claim. |
| `requirements_and_project_overview.md:48,90-92` | Describes a single SQLite DB; system is now 3-tier (ledger/config/cache). |
| `requirements_and_project_overview.md:561-584` | Projection described as embedded in monthly/yearly; now standalone. |
| `requirements_and_project_overview.md:767-816` | Implementation roadmap / "open questions" — all completed work. |
| `CHANGELOG.md` | Missing the **2.9.4** entry; a stale `2.9.1 — Unreleased` block sits *below* the 2.9.3 entry. |
| `docs/v2.0_split_cloud_security_plan.md` | Fully-shipped plan (Phases 1-5). Only stragglers remain — see TODO #1/#2/#3. Candidate to archive. |
| `docs/v2.2-feature-bump-plan.md` | Fully shipped; still mentions DKK and `^IRX` (both replaced in v2.4). Candidate to archive. |
| `docs/v2.8-cleanup-plan.md` | Every checklist box is ticked. Candidate to archive. |

> **Suggestion:** keep the three completed plan docs but move them under a
> `docs/history/` (or prepend a "✅ COMPLETED — historical" banner) so they're
> clearly archival, and bring `README` / `user_guide` / `CONTRIBUTING` /
> `requirements_and_project_overview` back in line with the current code.

### 2B. Legacy / likely-dead code (verify callers before removing)

| Where | What | Assessment |
|---|---|---|
| `db.py:186-193` | `get_engine()`, `get_session_factory()` | Marked "Legacy"; **zero callers** in `src/` or `tests/`. Safe to remove. |
| `repositories/snapshots_repo.py:20` | `list_snapshots()` | No callers found — verify no CLI/API use. |
| `repositories/transactions_repo.py:67` | `delete_transaction()` | No callers found. |
| `services/transaction_fx_service.py:223` | `list_accounts_currency_map()` | No callers found. |
| `storage/encryption.py:61` | `driver_available()` | No callers found. |
| `ui/money_format.py:46` | `fmt_pair()` | No callers — superseded by v2.9.1 single-currency display. |

**Intentionally kept (NOT legacy — leave alone):**
- `_overview_query.py:127-132,299` — native-currency fields kept for
  `readmodels/overview.py` + `/api/overview` back-compat.
- `_period_query.py` EUR/USD spot-rate fallback — still the active
  degrade-gracefully path when FX history is unavailable.

### 2C. Outdated code comments — ✅ already fixed in this pass

Per your instruction these were resolved immediately (comment/docstring text
only — no logic touched):

| File | Change |
|---|---|
| `ui/pages/_projection_model.py:1-5` | Docstring said the tool lived on `/monthly` + `/yearly`; updated to the standalone `/projection` page (v2.8). |
| `ui/pages/_overview_query.py:454` | `# pragma: no cover - DKK removed in v2.4` → `defensive: unsupported native currency`. |
| `ui/pages/_period_query.py:107` | "legacy v1.3 behaviour" reworded to "degrade-gracefully fallback… still active". |
| `ui/style.py:1` | Dropped the stale "v1.5" version label from the module docstring. |
| `ui/layout.py:12` | "v1.5 rebuild" → "introduced in the v1.5 rebuild, iterated since". |
| `db.py:75` | "(or the legacy db_url)" → "(defaults to the configured ledger URL)". |

> `ui/copy/tooltips.py:116` (`^IRX` → `^TNX`) is **user-facing string content**,
> not a comment, so it is flagged under §0 item 1 / §2A rather than auto-fixed.

---

## 3. Full TODO / caveat backlog

### 3.1 Outstanding — SOON / IMMEDIATE
1. ~~**Per-tier Alembic version tables**~~ — _done._ Boot now stamps each tier's
   `alembic_version` table in split-DB mode (`boot.py`).
2. ~~**Onboarding passphrase screen**~~ — _done._ Settings → Storage and the
   first-run onboarding page now collect the synced-tier passphrase and store
   it via `store_passphrase_in_keyring` (`storage/encryption.py:84`).
3. ~~**Recovery-file save prompt**~~ — _done._ Both surfaces offer a downloadable
   recovery document (`storage.encryption.build_recovery_file`), giving
   encrypted-mode users a key-recovery path.

### 3.2 Outstanding — MEDIUM
4. ~~Settings "Move ledger…" picker~~ — _done._ Settings → Storage now has a
   "Move ledger…" folder picker that relocates the ledger + config tiers via a
   safe copy-verify-delete move (rolling backup + integrity check), persists the
   new paths to `app_config`, and prompts for a restart
   (`storage/move.py`, `ui/pages/settings.py`).
5. Auto-populate instrument category/asset-class from market-data metadata,
   downgrading the Settings field to read-only + "refresh" —
   `docs/v2.0_split_cloud_security_plan.md:80-82`.
6. Surface remaining spreadsheet-parity KPIs (MTD profit, weighted expense
   ratio, expense cost, div yield, market verdict) —
   `docs/spreadsheet_parity_comparison.md:220-223`.
7. Android app (Phase 3), Settings→Mobile panel, optional snapshot encryption —
   `docs/mobile_android_app_proposal.md:179-186`.
8. In-app mobile update check — `docs/mobile_android_app_proposal.md:160`
   (depends on #7).
9. Multi-device write queue / "secondary device" mode (explicitly v3) —
   `docs/v2.0_split_cloud_security_plan.md:452-453`.
10. Document/support Tailscale mesh-VPN exposure path —
    `docs/mobile_android_app_proposal.md:112` (docs-only).
11. Implement `transfer_in` / `transfer_out` transaction kinds — enum reserved
    but no importer/UI logic — `requirements_and_project_overview.md:170`.
12. **True daily-snapshot TWR per period** (currently Modified-Dietz approx) —
    `CHANGELOG.md:940-943`. Daily snapshots now exist, so this is cheap.

### 3.3 Outstanding — LOW (someday / large effort)
13. Planned-purchase persistence + execution tracking (`planned_transactions`
    table) — `requirements_and_project_overview.md:596,804`.
14. Savings Bank **PDF** Kontoauszug parser —
    `requirements_and_project_overview.md:803`. (Note: the *CSV* importer is
    permanently out of scope — the broker has no CSV export.)
15. APScheduler background daily refresh —
    `requirements_and_project_overview.md:806`. Currently a deferred boot
    thread.

### 3.4 Permanent caveats / non-goals (won't be "done" — kept for reference)
- No real-time intraday quotes (EOD prices only) — `requirements…:23`.
- No multi-user / no auth beyond local-network binding — `requirements…:24`.
- No tax-lot / capital-gains accounting — `requirements…:25`.
- No trading execution (read-only re: brokers) — `requirements…:26`.
- Fidelity 2-decimal price granularity since May 2024 (handled by recompute in
  `adapters/fidelity/parser.py:117`) — `requirements…:267-268`.
- Vanguard 18-month export window — `requirements…:300-301`.
- Savings CSV importer out of scope (no broker export) — `CHANGELOG.md:945`.
- `ytd_start_value` best-effort when no Jan-1 tick (graceful fallback in
  `metrics_service.py:316`) — `CHANGELOG.md:979-984`.

### 3.5 Obsolete deferred-notes (safe to delete from docs/CHANGELOG)
- Monthly/yearly closing balances "deferred to v1.1" — shipped v1.1.0.
- Yearly hypothetical-projection sub-table "not yet wired" — shipped v1.1.0.
- Settings inline editing "comes in v1.1" — shipped v1.1.0.
- "No snapshots table yet" — table exists (`models/position_snapshot.py`).
- `split` transaction kind "reserved for v1.1" — implemented
  (`positions_service.py:96`).
- Cache-tier `session_scope()` back-compat note — already struck through &
  marked resolved in `docs/v2.0_split_cloud_security_plan.md:409-418`.

---

### How to use this file
Tell me which sections to action and I'll do them in order. My default
recommendation is to clear §0 items 1–4 first (all small, all user-visible),
then tackle the latent FX-fallback bugs (§1.1/1.2) and the Alembic/encryption
follow-ups (§3.1).
