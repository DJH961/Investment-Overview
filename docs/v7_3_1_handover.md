# 7.3.1 handover (2026-11-24)

Read this first, then [`v7_3_1_plan.md`](v7_3_1_plan.md) (plan, owner decisions, status
table, "Round 2") and `git log --oneline origin/main..origin/claude/pensive-ptolemy-2mrwcx`
(the commits are the detailed progress log).

## Where things are

- **Branch:** `claude/pensive-ptolemy-2mrwcx`, built on `main` after 7.3.0 merged. Not yet
  a PR. Version is already bumped to **7.3.1** (backend, frontend, web, lockfiles,
  `openapi.json`), and `CHANGELOG.md` has a draft `[7.3.1] — 2026-11-24` entry that still
  needs the UI items (see "Changelog" below).
- **Owner rule for UI:** shoot, reject bad shots yourself, then **send the owner the
  screenshots and wait for approval** before full checks and the PR. Only show work you
  fully stand behind. Review shots live in `.claude/ui-shots/` (git-ignored).

## Done (on the branch, tested)

| Area | What |
| --- | --- |
| Impact maths (§1 of `v7_3_1_money_math_issues.md`) | Deposits' rate move + spread are currency (`carry`): lines revaluation / "While your dollars waited" / conversion cost. Golden + property tests (`tests/readmodels/test_deposit_carry.py`). |
| One range meaning | `readmodels/currency_range.py`; All = investing window only, Max = history with `context_until`; every Currency payload carries `window`; 1D = today live; strip = Impact figures; one "effect today". Guard: `tests/api/test_currency_page_consistency.py`. |
| Two lenses (USD view) | `other_lens` "Seen from euros", `lens_note`, `holdings_note`. |
| EUR Now dot | Twin-ETF estimate ("≈ Now"), moves on ticks after the close. |
| Refresh | Tick ~5.7 s → ~0.5 s (benchmark); quiet auto indicator (pulse, one turn on landing); no duplicate FX fetch. |
| Bells backend | 60 s close grace, 409 `settling_close`, `market_session` SSE events, quiet re-pull after 5 min, cache dropped at each bell. |
| Bells UI (round 1) | Phase state machine (`MarketClock/marketPhase.ts`), bell wiggle + ripple, phone copy, "See you…", hero corner label, FX weekend moon/sunrise on the rate chart. |
| Currency page UI (round 1) | One sign/digit rule (`pages/Currency/numbers.ts`), window meta per panel, costs negative, short-range states, Max context drawing, bridge parts, lens line. |
| Conversions page | Import statement button (→ Wise card on Import), costs negative, StatStrip never leaves an empty cell, label (i) glued via CSS word joiner. |
| Tests | Parallel by default, schema template, fsync off except durability tests, Hypothesis dev/ci profiles, vmThreads; "Testing for agents" in AGENTS.md. |

## Round 2 (owner review 2026-11-24): status

1. **Conversions: six KPI figures.** Done in code (commit `663a800`: "Your average rate"
   added; StatStrip `six` = 6 in a row desktop, 3×2 tablet, 2×3 phone). **Screenshots not
   taken yet** and not shown to the owner. Next: shoot 360/390/800/1280 light+dark
   (script `/tmp/.../scratchpad/six.js` may be gone; any Playwright clip of `.stat-strip`
   on `/conversions` with `npm run dev:fixtures` works), review, send.
2. **Open/close end to end (lane A)** and 3. **Currency EUR|USD comparison + regular
   amount instead of €1,000 + rate chart window/Max + Max fixture (lane B):** started by
   the two agents that did round 1, stopped on the owner's request. Their state is in
   the section below.

## Lanes stopped mid-flight

See "Lane A" and "Lane B" below (filled from each agent's handover). Their work is on
local worktree branches; what is not merged here is described there with the next step.

## Owner's open asks (verbatim intent)

- Open/close: think about the **entire screen** at each moment (shortly before the open,
  the open with no data yet, the first tick, shortly before the close, closing, closed):
  update markers, graphs, each holding's report, all consistent. FX close/open also
  subtle on the home-screen currency cards. A bit more animation flair, not too much.
- Currency: clean one-by-one EUR vs USD comparisons on some panels; use the **regular
  conversion amount from Settings** everywhere instead of €1,000; all ranges must make
  sense.
- Earlier "still open" items, approved: rate chart window + Max context, Max Impact
  fixture, 1D chart not empty at the open, top-bar chip says "Closing…" during closing,
  phone chip after close as informative as desktop.

## Release steps left

1. Finish round 2, send screenshots, get approval.
2. Full checks once: backend `uv run pytest` (parallel), frontend + web `npm run test`,
   `npm run test:overflow`, typecheck, ruff/mypy/lint-imports; `npm run gen:fixtures`
   where the network works (CI's fixture drift guard).
3. CHANGELOG: add the UI items (Currency page sign/digit rule, window meta, short-range
   states, Max context, two-lens line; bells UI; Conversions six figures + Import button;
   round 2 items).
4. `docs/v7_plan.md` status line; plan status table; open the PR into `main`; check
   conflicts with `main`.
