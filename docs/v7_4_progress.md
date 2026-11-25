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
| Lane C — journey read models | merged 8239d132; adding the unowned payload hooks | lane/v7.4-c-journey | decisions 1–8 accepted; hooks: B2 tranches, E periods, C the rest; JOURNEY_CHECKS registered by C |
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
- 2026-11-26: owner: P18 (broker cash in the Overview total) is not core; it moves to a later release. Focus stays on the currency journey.
