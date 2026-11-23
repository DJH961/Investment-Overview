# 7.3.0 handover (sessions 2–3 of 7.3; updated 2026-11-23, keep current)

Read first: `docs/v7_plan.md` §5.1 "7.3 as settled", `docs/v7_3_contract.md`,
`docs/v7_3_handover.md` (session 1, shipped in 7.2.1).

**Branch:** `feat/v7.3.0` (worktree `.claude/worktrees/v7-3-planning-dev-144c07`), based on
main (7.2.1 #429 and the 360 px chip fix #430 merged in). One release, 7.3.0; PR against main.
No version bump yet; CHANGELOG entries sit under `[Unreleased]`, folded into
`## [7.3.0]` at release. Nothing pushed.

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

1. Merge lane B's undo and the Impact fix; regenerate openapi/api-types/fixtures; targeted tests.
2. Full frontend `npm run test` and one clean `npm run test:overflow` (add `/currency` and
   `/recurring` to the overflow route list).
3. Known gaps to judge: Data Health `estimated_rows` is warning-level (there is no info
   severity); rate-chart marker tap on phones is weak (SVG title); no frontend tests for
   SettleSheet/Recurring beyond stepper maths; setup flow is 3 separate POSTs.
4. Screenshots of changed views (Conversions page, Currency Conversions section, rate chart
   markers, Recurring list + setup, settle sheet, Transactions est. chip, Import update rows,
   Wise import, Impact) at 360/390/768/1280 both themes; critique each; owner approves.
5. Bump 7.3.0 in lockstep (backend/pyproject, web/ + frontend/package.json, lockfiles,
   openapi), CHANGELOG `## [7.3.0] — date`, plan status line; PR; CI green.
