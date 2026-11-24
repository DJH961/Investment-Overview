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

## Lanes stopped before round 2 code

Both round-2 agents stopped before writing code. Everything round 1 did is merged
here, so nothing lives only on their (local) worktree branches. Their findings are the
next steps:

### Lane A: open and close, end to end (nothing coded yet)

1. **1D chart empty at the open (cause found).** `readmodels/live_graphs.py`
   `_graph_points(range_key="1d")` → `build_intraday_value_series`
   (`readmodels/queries/overview_query.py`). Before the day's first sample the series
   holds at most the live tip, so `ValueChartCard`/`Chart` shows its empty state.
   Fix: in the 1d branch, while `market_hours.is_us_market_open(now)` and fewer than 2
   points, prepend a point at the regular session open (UTC) holding the previous
   session's close value; with no points at all, also add one at `now`. Compute
   `reference` even when `points` is empty. First check that `build_window_value_series`
   (session_dates / last_session_date, ~lines 395–415) does not hand back yesterday's
   samples at 09:30. Tests: `tests/readmodels/test_live_graphs.py` or
   `tests/api/test_graph_consistency.py`.
2. **One source of truth for the top bar.** Move `components/MarketClock/marketPhase.ts`
   to `lib/marketPhase.ts` (re-export at the old path). `describeFreshness`
   (`components/Freshness/describeFreshness.ts`) takes `phase?: MarketPhase | null`:
   closing → "Closing · settling the closing prices" (short "Closing…"); opening →
   "Market open · first prices in a moment" (short "Opening"); "open" only when the phase
   is live/open. Compute it with `useMarketPhase(data.freshness, data.daily_caption?.live)`
   in `components/AppShell/useGlobalFreshness.ts` and `pages/Overview/Overview.tsx` (~121).
3. **FX weekend on the home screen.** Move `components/RateChart/fxWeekend.ts` to
   `lib/fxWeekend.ts` (re-export kept). Subtle moon "FX closed for the weekend" (rate reads
   as Friday's close) and a brief sunrise "FX is back" (new rate eases in) on `CurrencyBox`,
   `CurrencyLifetime` and the Overview currency card (`CurrencyBox` already reads
   `regime.forex_open` / `forex_frozen`).
4. **Holdings and Holding page:** "Today" vs "Last session" wording and live/est. markers
   per phase: `pages/Holdings/HoldingMobileRow.tsx`, `Holdings.tsx`,
   `pages/Holding/HoldingHeader.tsx`.
5. **Phone chip after the close** says "Closed for 17h 24m", never the "See you…" text:
   make it as informative as desktop.
6. **Restrained flair** (~1–2 s, once, off under reduced motion): a sweep along the
   session bar as it completes at the close, the live dot lighting up and figures easing in
   at the first tick.
7. **Tests:** fake timers per moment (10 min before the open, 09:30, first tick, 2 min
   before the close, closing, closed, FX Fri close / Sun reopen) for the top-bar chip,
   hero, chart state and a holdings row.
8. **Shots:** full-page Overview, Holdings, one Holding at every moment, 390 + 1280 (360
   for phone copy), light + dark, plus a Playwright `recordVideo` WebM of the close and the
   open. Round-1 script (element shots only, needs `fullPage` and the extra routes):
   `node shots.mjs <outDir> [close|open|fx]` against `npm run serve:fixtures` (port 4173),
   fake browser clock, injected SSE events; Chromium at
   `/opt/pw-browsers/chromium-1243/chrome-linux64/chrome`; fixture bells fall at
   21:00Z / 14:30Z on 24–25 Nov 2026. (The script lived in the old session's scratchpad;
   rewrite it if it is gone.)

### Lane B: Currency comparisons and the regular amount (nothing coded yet)

1. **Regular amount instead of 1000** (`investing_power_service.get_amount_eur(session)`;
   a settings change already clears the read cache):
   - `readmodels/currency_deposits.py` `AMOUNT_EUR` (`rate_only` in `build_investing`,
     called from `currency_effect.py` ~1128);
   - `readmodels/currency_dollar.py` `NEXT_EURO_AMOUNT` (`_next_euro`, spark line,
     "a year ago");
   - `readmodels/currency_effect.py` `BUYS_AMOUNT_EUR` (`_buys` ~905);
   - `readmodels/currency_scenarios.py` `INVEST_UNIT_EUR` → `Invest(monthly, monthly)`
     (~380);
   - `readmodels/currency.py` ~278: the USD "effect today" strip tile;
   - frontend copy: `PositionCard.tsx` ("for the same €1,000", aria label, `?? 1000`),
     the `effect_today` tip in `Currency.tsx`, `WhatIf.tsx` (merge the unit and regular
     columns when equal); small amounts need cents. Check whether Overview's `CurrencyBox`
     shows a fixed €1,000.
   - Fallback when unset: the service defaults to €100 (what Overview shows). Use that
     rather than 1000.
2. **EUR | USD side by side** on 2–4 panels (candidates: Impact returns/effect per range,
   strip tiles, Exposure position, Scenarios stress); two columns, same rows, each in its
   own currency, two-lens rule (USD = deposit lens, EUR = book lens).
3. **Rate chart** (`components/RateChart`, leave fxWeekend alone): print
   `windowText(window)` (`pages/Currency/numbers.ts`); on Max draw t ≤ `context_until`
   muted and dashed ("before you started"); All shows nothing before the first transaction.
4. **Max fixtures:** record `/api/currency/effect/both?range=max` in
   `backend/.../tools/make_fixtures.py` and regenerate. The sandbox cannot fetch ^IRX:
   keep alpha, risk_free_rate, sharpe and sortino from the old fixture file (or regenerate
   where the network works; CI's fixture drift guard may differ otherwise).
5. **Tests:** extend `pages/Currency/rangeMatrix.test.tsx` to every range (1D … Max) ×
   EUR/USD, plus the comparison panels and the amount.
6. **Shots** of every changed panel at 1D, 1M, All, Max × EUR/USD × 390/1280 × light/dark.

### Test status at the stop

- Frontend full vitest last passed after merging both round-1 lanes (115 files / 1124
  tests); the later commits (Chart phone labels, Exposure/Scenarios/Impact polish, six KPI
  strip) ran their targeted suites only.
- Backend targeted suites passed for every commit; the full backend suite has not run
  locally since round 1 (CI will).

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
