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
