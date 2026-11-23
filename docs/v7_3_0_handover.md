# 7.3.0 handover (sessions 2–3 of 7.3; updated 2026-11-23, keep current)

Read first: `docs/v7_plan.md` §5.1 "7.3 as settled", `docs/v7_3_contract.md`,
`docs/v7_3_handover.md` (session 1, shipped in 7.2.1).

**Branch:** `feat/v7.3.0` (worktree `.claude/worktrees/v7-3-planning-dev-144c07`), based on
main (7.2.1 #429 and the 360 px chip fix #430 merged in). One release, 7.3.0; PR against main.
No version bump yet; CHANGELOG entries sit under `[Unreleased]`, folded into
`## [7.3.0]` at release. Nothing pushed.

## RELEASE STATE (2026-11-23, latest)

- 7.3.0 bumped and committed on feat/v7.3.0 (4ba083b3: versions, lockfiles, openapi, CHANGELOG
  `## [7.3.0] — 2026-11-23`, plan status line). Pushed; **draft PR #431**
  (https://github.com/DJH961/Investment-Overview/pull/431), bound to this session.
- Merged since the state below: recurring polish round 3, American English (dates exception:
  "14 Nov 2026" default + "Nov 14, 2026", "14.11.2026", ISO), setup polish afba4ba3, fixture
  fund renamed FAKEMM (public repo: fake tickers only). Date/locale scan of all 16 routes clean
  (`.claude/scan-text.cjs`).
- Still open: lane C final fix (mixed cadences per-run inheritance monthly→biweekly→weekly with
  notes, Add plan/setup dialog near the top on desktop, more 390 setup shots) → owner approval →
  merge → regenerate fixtures/openapi if changed → push → mark PR ready → CI green → merge.
  Fold any new `[Unreleased]` lines into 7.3.0 at that merge.
- Local release checks script: scratchpad `release_checks.sh` (backend gate + targeted pytest,
  vitest, web tests, overflow, sequential).

## CURRENT STATE (read this first; 2026-11-23 evening)

**Work loop (owner rule, AGENTS.md "UI feedback loop: screenshots first"):** UI agents shoot
as soon as it compiles; you and the agent reject bad shots first; only good shots go to the
owner (SendUserFile); full tests run ONCE after his approval. Shot script:
`.claude/shots73.cjs` (from `frontend/`: `NODE_PATH=$(pwd)/node_modules node
../.claude/shots73.cjs <outDir> [view…]`, fixture dev server on 5273 via
`preview_start frontend-fixtures`; `CLIP_Y`/`CLIP_H` env for slices of long phone pages).
Language: **American English** everywhere (memory `american-english`), except dates.

**Approved by the owner and merged into feat/v7.3.0:** Currency › Conversions section (costs,
timing, markers, By-year phone mini table, provider side-by-side), Conversions page (year folds,
no month level, indent, "Paid for deposits on…", 4-line phone rows), `/currency` overflow fixes
(overflow 16/16 incl. `/currency`). All four 7.3 lanes + P15 undo merged earlier.
Impact "Mixed" tag REVERTED (d4ad2df2) → 7.3.1 (`docs/v7_3_1_money_math_issues.md`).

**In flight (not merged):**
1. `lane/v7.3-recurring-polish` (lane C agent; last sha be97e27c, round 2 running). Owner notes
   being done: Import button on Wise conversion reminders (→ Wise statement card); desktop
   reminder = one row per item with Import + Settle side by side (Import first), short left text;
   phones stacked, Import first; plan titles in the app's normal card-title style (amounts as
   title, "Every month on the 25th · Next 12 Dec" muted, account 2nd muted line); currency on
   Total / Price per share (and €/$ on conversion fields); in EUR mode only a muted line under
   Total "≈ €86.12 at your 14 Nov conversion (1.1586)" using the flow's conversion-plan rate
   (latest on/before due date), else the latest real conversion, else "at the ECB rate"
   (server-side fields on `GET /estimates`); smart minus (100.00 − 0.01 = 99.99; owner saw
   100.09: stepper bug) with golden tests; Edit/Pause/End/Delete on one line at 360; shots of
   every "Set up your routine" step and the Add plan form → then walk the owner through setup
   (top buttons: "Set up your routine" = guided 3-step conversion → deposit → buys, prefilled
   from the last 120 days, nothing created until confirmed; "Add plan" = one plan).
   Already done there: multi-fund buy plans (`recurring_plan_legs` in migration 0027,
   `transactions.estimate_leg_id` in the unique key), Total/Shares-first stepper with derived
   price + "Edit price", aligned reminder actions, no "Accept as estimated" (UI only, backend
   `/settle` unchanged by owner's wish), no est. note, VMFXX fixture fund, capitalized weekdays,
   price at 4 dp.
2. `lane/v7.3-american-english` (locale agent, from feat/v7.3.0): remove the en-GB preset
   (en-US default; stored "en-GB" reads as en-US), "$" not "US$", American spelling in
   user-visible text, AGENTS.md language line, CHANGELOG Changed. **Dates exception:** separate
   date setting, default "14 Nov 2026" (month name, day first), options "Nov 14, 2026",
   "14.11.2026" (German), "2026-11-14", each with a live example; "Sep" not "Sept"; never
   MM/DD/YYYY by default. Hands back shots of Overview, Transactions, Conversions,
   Settings › Display.

If an agent is gone: its branch has wip commits; read `git log feat/v7.3.0..<branch>`.

## Owner decisions (2026-11-22)

- 7.3.0 = conversion costs + Currency "Conversions" section + P15 + P14 + Wise import.
  P6 (lump sum) dropped from 7.3.
- **Owner's real journey** (design everything around it): a Revolut automation converts
  EUR→USD from checking accounts he does NOT want in the app → a fixed monthly automatic
  deposit from USD checking to Vanguard/Fidelity lands in the money-market (core) fund →
  weekly automatic buys draw down the MMF. The conversion paying a deposit is often much
  earlier (FIFO pool).
- P14 plan kinds: **conversion, deposit, buy**. Deposits: est. row, never prompts. Conversions:
  est. at settled ECB × (1 + provider's EUR-weighted avg off-ECB, fees excluded) plus the
  plan's expected fee; settled by typing USD received. Buys: est. at the day's close + a
  matching **MMF drawdown leg** that follows the settled buy total.
- **KEY: hand-settling a draft must be effortless** (−/+ steppers on the last stored decimal,
  ×10, hold to repeat, one Save, next draft). A later broker import only matches/updates.
- Wise CSV preset only (Revolut statements are useless); per-row disregard; setting "ignore
  conversions not into USD" (default on). Owner's sample lines never go in the repo.
- `kept_usd` per conversion (dollars kept in USD checking, never matched); no idle-dollars
  warning. "Received in USD" deposit mark; info-only health check.
- Extras: chart markers YES (on/off chip), timing panel YES; Brief line NO; exports NO.
- **Conversions page = a place to add conversions, light stats only**; the Currency page's
  Conversions section is the deep dive.
- 2026-11-23: fix in this release: Impact can claim a positive EUR total and "tailwind" while
  the % impact below is negative (bug lane, below).

## Lanes

| Lane | Branch | State |
|---|---|---|
| A costs + Currency section + markers + timing | `lane/v7.3-costs` | merged |
| B P15 import matching | `lane/v7.3-import-match` | merged; **undo of updated rows in progress** (same agent, on top of feat/v7.3.0) |
| C P14 recurring plans | `lane/v7.3-recurring` | merged; migration 0027 `c5e1a7d3f902` |
| D Wise import + kept_usd + Received in USD | `lane/v7.3-wise` | merged; migration re-parented as **0028** `c4e8a2f6b0d7` (down `c5e1a7d3f902`) |
| Impact sign bug | `fix/v7.3-impact-sign` (from main) | in progress |

Merge wiring already done on feat/v7.3.0: placeholder provider offset replaced by
`fx_cost_service.provider_avg_off_pct`; estimated conversions left out of costs, markers and
the offset (`fx_cost_service.conversions_with_fixings`); `apply_import_update` calls
`recurring_service.confirm_estimate`. openapi, api-types and fixtures regenerated.
Targeted backend tests: 120 passed after the last merge; frontend typecheck clean.

## Screenshot review round 1 (2026-11-23), polish lanes running

Owner: no Impact/"Mixed" changes in 7.3.0 (reverted, d4ad2df2); money-maths inconsistencies go
to 7.3.1 (`docs/v7_3_1_money_math_issues.md`). Polish branches off feat/v7.3.0, merge when done:
- DONE (merged, checked at 360/390/1280: year folds, indent, "Paid for deposits on…", kept line, 4-line phone rows) `lane/v7.3-conv-folds`+`conv-polish{,2,3}`: Conversions page: every year foldable (current year too), no month
  level (year → conversions), consistent vertical spacing so entries never touch.
- DONE (merged, checked) `lane/v7.3-costs-polish`: Currency Conversions section; still running: By-year phone rows + `/currency` overflow fixes (lane A): Best/Worst as one tile (no lone
  tile on a 2nd row), By-year/provider tables fit without horizontal scroll.
- `lane/v7.3-recurring-polish`: proper provider/account names and short plan titles, a fixture
  account with an MMF, price shown at stepped precision, 360/390 checks.
Then: shots at 360/390/1280 (both themes) of Conversions page, Currency section + rate chart
markers, Recurring + settle sheet, Transactions est. chip, Wise import card → owner.

## Impact € vs pp: real inconsistency found (2026-11-23, waiting for the owner's go)

The "Mixed" tag (fix/v7.3-impact-sign, merged) only hides the symptom. Root cause:
`readmodels/fx_attribution_rows.py` feeds the EUR flows **with the FX-pool overrides** (a matched
deposit's euro flow = the conversion's EUR cost), while the book is valued at that day's rate.
So the currency move while the dollars waited outside the app (conversion date → deposit date),
plus the conversion spread, land in the residual **market** part `M_t` and in the EUR TWR chain
(so in the pp gap), but never in the € currency total `ΣC_t`. With conversions made months
before deposits during a falling dollar this gives e.g. −9 pp next to +€500.
Proposed fix: value deposit flows at that day's rate inside the attribution, and show the
difference as its own lines: "while your dollars waited" (`usd/r_deposit − usd/r_conv_ecb`) and
"conversion cost" (fx_spread). The € total = book + waiting + cost then agrees with the pp gap;
"Mixed" stays only for genuine timing cases. Needs golden tests (convert at 1.03, deposit at 1.17).

## Left to do

1. Owner approves Recurring round 2 shots + the setup walkthrough; merge
   `lane/v7.3-recurring-polish`.
2. Owner approves the American English shots; merge `lane/v7.3-american-english` (expect
   conflicts with recurring polish in format calls / snapshots; regenerate fixtures).
3. Still unshot for the owner: Transactions est. chip, Import page update rows (P15), Wise import
   card. Shoot, self-review, send.
4. Small leftovers: By-year title ~8 px further in than its rows on desktop; Data Health
   `estimated_rows` is warning-level (no info severity exists); rate-chart marker tap on phones
   is weak (SVG title); setup flow = 3 separate POSTs.
5. Then ONE full check round: backend targeted pytest (fx, recurring, import, wise, migration
   roundtrip, schema, app contract), `npx vitest run --testTimeout=20000`, `npm run
   test:overflow` (kill stale listeners on 4173 first), ruff/mypy/lint-imports; regenerate
   openapi/api-types/fixtures once.
6. Bump 7.3.0 in lockstep (backend/pyproject + `uv lock`, web/ + frontend/package.json +
   `npm install`, openapi), CHANGELOG `## [7.3.0] — date` (fold Unreleased; drop the reverted
   Impact "Fixed" line if any remains), plan status line; commit, push, PR to main; CI green;
   merge (owner trusts merging green PRs).
