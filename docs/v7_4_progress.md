# 7.4 progress: resume here

Plan: [`v7_4_plan.md`](v7_4_plan.md) · Contract: [`v7_4_contract.md`](v7_4_contract.md)

- **Integration branch:** `claude/v7-4-currency-journey-ffb010`, in the worktree
  `.claude/worktrees/repository-setup-06d707`.
- **Lane branches:** each lane works in its own worktree and branch, named below. The
  orchestrator merges them into the integration branch in the order A → B → C → D → E.

**To resume after a stop:** read this file, then `git log --format='%h %s%n%b' <lane branch>`
for each lane. Every lane commit carries `Done:` and `Next:` lines. Send the same lane agent
a message if it still exists; otherwise start a new one with the lane's contract section
plus its last `Next:` line.

## Status

| Step | State | Branch | Notes |
|---|---|---|---|
| Plan approved | done 2026-11-25 | — | owner answers: recap + real return pulled in; no alert channel; sell keeps original cost; cash-out supported across the app |
| Contract + golden G1/G2 | done 2026-11-25 | integration | owner still checks the G1 numbers (contract §3) |
| Lane A — P19 frozen legs | done, merged b7fb17d5 | lane/v7.4-a-p19 | migration 0029 = d9b3f1a7c2e5; only matched-deposit EUR in Transactions moved; check cache-tier Alembic on server boot; diagnostics _check_frozen_legs still reads legs (drop at release) |
| Lane B1 — cash pool domain | done, merged 1f40e143 | lane/v7.4-b1-cash-pool | fees reduce received; ecb_rate(ccy,date); see contract §6 |
| Lane E — recap + real return | done, merged 95c66c1b | lane/v7.4-e-recap | ECB licence: free with citation "Source: ECB, Eurostat" + say real return is our calculation; checks backup_age + eod_steps registered by C; shots in agent-a13dde251d4c6378a/.claude/ui-shots/v7.4-recap |
| Journey UI mockups | approved 2026-11-25 (v2) | — | aligned trail rows, cash-out EUR vs USD, 4 stats full width; see plan "Approved mockup decisions" |
| Owner golden check (B1) | G1 OK by owner 2026-11-25 | — | B2 may start once lane A is merged |
| Lane B2 — wiring | merged; follow-up: direction filters in fx_cost, recurring, currency_deposits, conversions API | lane/v7.4-b2-wiring | P18 totals deferred to a later release (owner 2026-11-26); rule + check stay dormant; patch = commit 09d26368 |
| Lane C — journey read models | done, merged d6203dee | lane/v7.4-c-journey | decisions 1–8 accepted; hooks: B2 tranches, E periods, C the rest; JOURNEY_CHECKS registered by C |
| Lane D — journey UI | started (impeccable) | lane/v7.4-d-journey-ui | fixtures + temp journey-types.ts |
| Shots → owner review | to do | | |
| Full tests, CI, release 7.4.0 | to do | | ask about DEPLOY_MODE first |

## Log

- 2026-11-25: plan and contract written; lanes A, B1 and E started.
- 2026-11-25: owner approved mockups v2 and G1. UI lanes use impeccable (design, audit, critique); the orchestrator runs impeccable-finish-reviewer.
- 2026-11-25: lane E told to hand over; it restarts as a skills-capable agent (impeccable). Owner rule: align text and keep empty lines to a minimum, never pad the other boxes.
- 2026-11-25: B1 merged. Contract part 2 (docs/v7_4_contract_api.md) written; lanes B2, C, D started.
- 2026-11-25: usage limit stopped B2, C, D and E mid-work. Lane A merged. All four resumed with SendMessage (same agents, same context). E re-points 0030 to d9b3f1a7c2e5.
- 2026-11-25: PR #434 (overflow at 768-1440 px, fixtures deploy gate) merged into 7.4 and closed. Fixed the date-dependent openClose.moments test; main keeps failing that test until 7.4 merges. Lane C merged.
- 2026-11-26: B2 and E merged (95c66c1b). Open: owner decision on P18 totals; B2 direction filters; C hooks; D UI. Flaky hypothesis test_tiingo_fallback_backoff seen by B2 (pre-existing).
- 2026-11-26 (late, token-limited session): antigravity's uncommitted work committed as 39d29c9c
  (conversion plan "USD arriving" mode + migration 0031 e3c7a1f5b9d4, fee-mode toggle in Add conversion,
  market chip lost the word "Closed"). Its shots: `.claude/ui-shots/v7.4-review/` (no overflow in dom-audit).
  Four owner issues sent to Sonnet lanes from 39d29c9c, each in its own agent worktree:
  F `lane/v7.4-f-chip-months` ("Closed until Fri 3:30 PM" → "Closed until Fri"; Transactions pages keep whole months),
  G `lane/v7.4-g-periods` (compact Periods, indent back), H `lane/v7.4-h-plan-flex` (independent cadences and
  amounts per step, buys > deposits allowed, neutral note). Scratch/shots: session scratchpad `lane-f|g|h`.
  Resume: `git log --format='%h %s%n%b' <lane>`; merge F, G, H into the integration branch, shots to owner, PR.
  Known open issues list: bottom of this file.
- 2026-11-26: owner: P18 (broker cash in the Overview total) is not core; it moves to a later release. Focus stays on the currency journey.

## Known open issues (not fixed in 7.4.0)

Still open:
- Date inputs show the browser locale (dd.mm.yyyy), not en-US.
- Holding page Value chart with the realistic (`--nice`) fixtures: ~€313K invested vs a €26.5K
  header value, "This range -112.88%". Probably the chart series comes from the stress set
  (fixture bug, not app); not confirmed.
- Conversions shows "In the pool $0" next to 11 conversions; check it is intended.
- Phone layouts for Conversions, Activity and Transactions apply below 640 px only;
  640-767 px keeps the old layouts.
- Phone conversion detail: kept-in-USD and all-in lines not seen in shots (no fixture row has them).
- Recurring setup step 3 note ("buys exceed deposits") has no test.
- B2 follow-up: direction filters in fx_cost, recurring, currency_deposits, conversions API.
- Diagnostics `_check_frozen_legs` still reads the frozen legs (drop with the legs).
- Flaky hypothesis test `test_tiingo_fallback_backoff` (pre-existing).
- Periods column sorting was removed with the redesign.

Moved to later releases (see docs/v7_plan.md push 10, 7.6):
- Cash-out journey end to end, Cash out page refinement, linking withdrawals to conversions.
- Fees in either currency for either direction; incl./excl. fees for both directions.
- Activity links to each conversion that paid for a deposit.
- P18 broker cash in the Overview total.

Done in 7.4.0 (were open earlier today): manual USD→EUR entry, USD fees on USD→EUR,
owner shot review of all changed pages.

## Session log 2026-11-26
- 2026-11-26: owner REJECTED Periods pass 1 (b99b8a38 merged; whitespace on phone and desktop untouched). Lane G redoing it to a concrete spec: one dense table for all years on desktop (year = header row, months indented 36-40 px rows), 2-3 line text rows on phone. Lane I (`lane/v7.4-i-back-to-eur`): manual USD→EUR entry in Add conversion (owner: important).
- Shot review scope (owner 2026-11-26): ONLY pages changed in 7.4 — Overview (recap, journey card, market chip), Holdings tile, Holding page journey + peek, Periods, Currency, Conversions (+ add dialog both directions), Cash out, Activity, Transactions, Recurring setup. EUR+USD, 390 and 1440.
- 2026-11-26: merged F (5a851e00), I USD→EUR entry (6e50a7d3), H plan flex (2d049493; backend needed no change, step-3 note untested). Waiting: G Periods redo. Then: CHANGELOG 7.4.0 (no 7.4 feature entries yet!), version bump, openapi, shots of changed pages, PR.
- 2026-11-26: lane J `lane/v7.4-j-usd-fees`: native USD fees on USD→EUR conversions (owner: his provider charges USD). Cash-out journey + withdrawal linking moved to 7.6 (v7_plan.md push 10).
- 2026-11-26: Periods redo merged (d9393e83): one table desktop, text rows phone; column sorting removed. Shot set of changed pages running → scratchpad shots-7.4/index.md. Waiting: lane J USD fees. Then CHANGELOG 7.4.0 + bump + PR.
- 2026-11-26: owner APPROVED desktop Periods table; REJECTED phone text rows ("busy"). Lane G redoing PhoneYears as native list: year card (value right, TWR/XIRR pair, 4-col mini grid when expanded), months 2-line aligned rows with growth pill, tap to expand In/Net/Out/Div.
- 2026-11-26: J merged (a4f7e8c4): fees_usd column, migration 0032 f4d8b2a6c0e1; golden USD1100/fee5/EUR945/1.16 checked by orchestrator. Phone Periods approved in approach, one polish round running (lane G after4). Shot set still running. Next: CHANGELOG 7.4.0, bump, openapi, PR.
- 2026-11-26: release 7.4.0 committed (0edae320), draft PR #435 open, CI running. Shot set sent to owner (scratchpad shots-7.4; Periods there is pre-polish). Known: Holding Value chart in --nice fixtures shows ~€313K vs €26.5K header and "This range -112.88%" (likely chart series from the stress set; check before merge); Add-conversion date input dd.mm.yyyy; "In the pool $0" on Conversions (check intended). Next: owner verdict on shots, CI green, un-draft, ask DEPLOY_MODE, merge.
- 2026-11-26: owner shot review round 1: lanes K (lane/v7.4-k-desktop-polish: lifetime currency effect one column on desktop, rename "Your dollars", Recurring buttons in header line), L conversions phone, M activity phone, N transactions phone — all to the approved Periods phone pattern (scratchpad brief-common.md). Cash out page: no change now, refine in 7.6 (plan updated). PR #435 stays draft.
- 2026-11-26: merged K (ad45f373), Recurring status align (d2f608e7), M Activity phone (421f748b + 322c6b5e), L Conversions phone (93f149a5). N Transactions phone: fixing truncated line 2, then merge. Back-to-euros row symbols checked OK (€ received from $ sent). Phone pattern only below 640 px; 640–767 keeps old layouts.
- 2026-11-26: all round-1 lanes merged (N 371f0fcb). CI fix aeee2b34: SetupFlow lint (refs in render) + regenerated fixtures (drift guard). Local frontend 1245/1245. Waiting: CI on aeee2b34, owner verdict on phone shots, DEPLOY_MODE question, then un-draft + merge #435.
- 2026-11-26: owner APPROVED round-1 phone layouts except the opened Conversions row (too vertical) — lane L flattening it (3-col grid, ≤150 px). 7.6 plan: Activity links per paying conversion.
- 2026-11-26: opened Conversions row flattened (e9b0fcda), owner approvals complete. PR #435 marked ready. Waiting: CI on e9b0fcda + DEPLOY_MODE answer, then merge.
- 2026-11-26: opened Conversions row regrouped (b5e044e2; owner agreed the plan). CI on earlier commit: 9 pass, 0 fail. Waiting: CI on b5e044e2, DEPLOY_MODE answer, merge #435.
- 2026-11-26: owner approved all 7.4 shots (final: conversions detail centered, 17ad3518). DEPLOY_MODE=scheduled (unchanged). Auto-merge (merge commit) enabled on #435 per owner "deploy scheduled": merges when CI is green, deploys at the next scheduled window. After merge: tag check, update v7_plan status (release tool did), and the 7.6 list in v7_plan.md push 10 holds the follow-ups.
- 2026-11-26 (later): owner: CI failed → fixed 998b057f (schema hicp_index, overflow); tab title always "Investment Overview" 5f3a10bc; lane O `lane/v7.4-o-impact-1w` (Currency Impact 1W like Overview). Auto-merge OFF until lane O is merged; then merge on green (scheduled deploy).
