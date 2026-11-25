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
| Lane A — P19 frozen legs | started | see lane report | |
| Lane B1 — cash pool domain | done, merged 1f40e143 | lane/v7.4-b1-cash-pool | fees reduce received; ecb_rate(ccy,date); see contract §6 |
| Lane E — recap + real return | restarted with impeccable agent | lane/v7.4-e-recap (worktree agent-a13dde251d4c6378a) | handover at 311f23fe: HICP adapter, cache tier, service, real-return maths done; next: eod step, Periods real return, recap API, health checks, RecapCard |
| Journey UI mockups | approved 2026-11-25 (v2) | — | aligned trail rows, cash-out EUR vs USD, 4 stats full width; see plan "Approved mockup decisions" |
| Owner golden check (B1) | G1 OK by owner 2026-11-25 | — | B2 may start once lane A is merged |
| Lane B2 — wiring | started (ledger_query hook after A merges) | lane/v7.4-b2-wiring | |
| Lane C — journey read models | started | lane/v7.4-c-journey | codes against contract_api §7 seam |
| Lane D — journey UI | started (impeccable) | lane/v7.4-d-journey-ui | fixtures + temp journey-types.ts |
| Shots → owner review | to do | | |
| Full tests, CI, release 7.4.0 | to do | | ask about DEPLOY_MODE first |

## Log

- 2026-11-25: plan and contract written; lanes A, B1 and E started.
- 2026-11-25: owner approved mockups v2 and G1. UI lanes use impeccable (design, audit, critique); the orchestrator runs impeccable-finish-reviewer.
- 2026-11-25: lane E told to hand over; it restarts as a skills-capable agent (impeccable). Owner rule: align text and keep empty lines to a minimum, never pad the other boxes.
- 2026-11-25: B1 merged. Contract part 2 (docs/v7_4_contract_api.md) written; lanes B2, C, D started.
