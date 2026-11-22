# 7.3.0 handover (sessions 2–3 of 7.3; written 2026-11-22, keep current)

Read first: `docs/v7_plan.md` §5.1 "7.3 as settled", `docs/v7_3_contract.md`,
`docs/v7_3_handover.md` (session 1, shipped in 7.2.1).

**Branch:** `feat/v7.3.0` (worktree `.claude/worktrees/v7-3-planning-dev-144c07`), stacked on
the unmerged 7.2.1 PR (#429, `release/7.2.1`, merged in up to 588d4b8e). One release, 7.3.0,
after 7.2.1 merges (owner choice). No version bump yet; lanes write CHANGELOG under
`[Unreleased]`, folded into `## [7.3.0]` at release. Nothing pushed.

## Owner decisions (2026-11-22)

- 7.3.0 = conversion costs + Currency "Conversions" section + P15 + P14. P6 (lump sum) dropped
  from 7.3.
- **Owner's real journey** (design everything around it): a Revolut automation converts EUR→USD
  from checking accounts he does NOT want in the app → a fixed monthly automatic deposit from
  USD checking to Vanguard/Fidelity lands in the money-market (core) fund → weekly automatic
  buys draw down the MMF. The conversion paying a deposit is often much earlier (FIFO pool).
- P14 plan kinds: **conversion, deposit, buy**. Deposits have zero variation → est. row, never
  prompts. Conversions: est. at settled ECB × (1 + provider's EUR-weighted avg off-ECB), plus
  the plan's expected fee (default: last real fee for that provider); settled by typing USD
  received (Revolut statements are useless). Buys: est. at the day's close + a matching **MMF
  drawdown leg** that follows the settled buy total automatically.
- **KEY: hand-settling a draft must be effortless**: open the draft, −/+ steppers on the last
  stored decimal (precision as seen in that account's imports), ×10 toggle, hold to repeat, one
  Save, next draft. A later full broker import only matches/updates (P15), never duplicates.
- One grouped reminder per plan saying what input is needed (Transactions badge, info-level
  Data Health, Recurring list card). Nothing for deposits.
- Guided "Set up your routine" on the Recurring list creates all three plans; suggestions from
  ledger history, created only on confirm.
- Wise CSV import preset (no Revolut): per-row disregard (card purchases), setting "ignore
  conversions not into USD" (default on), dedupe by TransferWise ID, hidden-fee maths for
  CONVERSION rows (EUR total from Description). Owner's sample lines never go in the repo.
- `kept_usd` per conversion: dollars kept in the USD checking account, never matched.
  Replaces the "idle dollars" extra (owner does NOT want that).
- "Received in USD" deposit mark (family money) + an **info-level, non-intrusive** health check
  for ECB-only deposits.
- Extras: chart markers YES with an on/off chip; timing panel YES; Brief line NO; exports NO.
- **Conversions page = a usable place to add conversions, light stats only**; the Currency
  page's Conversions section is the deep dive.

## Lanes (implementer subagents, one worktree each under `.claude/worktrees/agent-*`)

| Lane | Branch | State |
|---|---|---|
| A costs + Currency section + markers + timing | `lane/v7.3-costs` (f0705805+) | first pass done; reworking onto the redesigned Conversions page with light stats |
| B P15 import matching | `lane/v7.3-import-match` 34f54b9a | **merged** into feat/v7.3.0. Undo of updated rows NOT done (needs schema, below) |
| C P14 recurring plans | `lane/v7.3-recurring` | running; owns migration 0027 (down `a7c3e9d1b5f2`) |
| D Wise import + kept_usd + Received in USD | `lane/v7.3-wise` | running; migration `0027a` (down `a7c3e9d1b5f2`) → re-parent after 0027 at merge |

If a lane's agent is gone, its branch holds its committed work: read `git log` there.

## Merge-time to-dos (main session)

1. Merge A, C, D; re-parent D's migration onto C's 0027; run migration roundtrip test.
2. Swap lane C's placeholder provider-offset helper for lane A's
   `domain.fx_spread.provider_avg_off_pct(rows, provider) -> Decimal | None`
   (service: `services.fx_cost_service.provider_avg_off_pct(session, provider)`).
3. Wire P15: lane B's `profile_for(existing)` reads `is_estimate` (works by itself once C's
   column exists); call C's `confirm_estimate(row)` from B's `apply_import_update`
   (`services/import_update_service.py`) so an import confirms est. rows (and the MMF leg).
4. P15 undo: C adds `import_batches.update_images` (JSON before-images) + `updated_count`;
   then store before-images in `apply_updates` and restore them in `import_undo_service`.
5. Lane A TODOs: skip `is_estimate` conversions in `conversionMarks` and
   `readmodels/currency_rate._markers`. Add `/currency` to the overflow route list.
6. Regenerate openapi.json, api-types.ts, fixtures once after all merges; full frontend tests.
7. Bump 7.3.0 in lockstep (backend/pyproject, web/ + frontend/package.json, lockfiles,
   openapi), CHANGELOG `## [7.3.0] — date`, plan status line.
8. Screenshots of changed views (360/390/768/1280, both themes), critique each, send to the
   owner for approval before release. PR after 7.2.1 merges; resolve conflicts with main.
