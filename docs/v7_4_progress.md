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
| Lane B1 — cash pool domain | started | see lane report | |
| Lane E — recap + real return | started | see lane report | |
| Journey UI mockups | to do | — | the owner approves them before lane D |
| Owner golden check (B1) | to do | — | gate for B2 |
| Lane B2 — wiring | waiting on A + owner gate | | |
| Lane C — journey read models | waiting on B1 | | |
| Lane D — journey UI | waiting on mockups | | |
| Shots → owner review | to do | | |
| Full tests, CI, release 7.4.0 | to do | | ask about DEPLOY_MODE first |

## Log

- 2026-11-25: plan and contract written; lanes A, B1 and E started.
