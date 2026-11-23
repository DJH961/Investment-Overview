# 7.3.1: one honest Currency page, faster quiet refresh, nicer bells, faster tests

## Context

7.3.0 (PR DJH961/Investment-Overview#431, branch `feat/v7.3.0`) is about to merge. The owner says
the Currency page is full of money-maths inconsistencies. The briefing is
`docs/v7_3_1_money_math_issues.md` §1 on that branch: Impact's € total and pp gap can point
opposite ways because matched deposits enter the attribution at their conversion cost. The
explorers found the wider pattern:

- The backend has five range-to-dates implementations that disagree on 1D, 1W, All and Max:
  `currency_effect.range_window`, `currency_rate.range_start`, `currency_scenarios.range_start`,
  `fx_costs.build_costs_both` and `currency_dollar._range_change`/`_rolling`. There are also three
  copies of `_minus_months`.
- Impact on 1D mixes today live (headline, returns, chart) with yesterday (bridge, months,
  dates). It skips holdings. 1W has a 5-session chart over calendar-day figures.
- "Effect today" is computed three ways (`fx_effect`, `DayMoveSplit`, the intraday line).
- The USD view's Impact/strip headline is the deposit effect (`usd − eur·r0`), shown next to
  the EUR-lens pp gap, which has the opposite sign. The mismatch note is forced off.
- Signs and digits drift: Conversions uses + = cost, pp is shown with 1 or 2 digits, and
  `ppSize` drops the sign. Short ranges break charts: rolling silently becomes 1M, Scenarios
  marks collapse on 1D, Conversions axis ticks repeat, `long` misses 5Y/10Y.

Side quests: slow minute refresh and a constantly spinning icon, the EUR "Now" dot ignoring
twin estimates, awkward market close/open (stale "Live", errors when refreshing at the bell,
and a cut-off "The closing bell has ru…" on phones), and slow tests.

Owner decisions (2026-11-23):
1. **1D = today, live, on every panel.** A panel with no intraday data says so instead of
   drawing nothing.
2. **One effect, two lenses, honestly.** The owner holds only USD assets and is paid in EUR.
   - **EUR view:** the currency effect on the book (revaluation + waiting + conversion cost).
   - **USD view:** the deposit lens, meaning how many dollars the euros bought against the
     start rate. The holdings effect in USD is zero by nature, and the page says so in one
     line. It never shows "your EUR holdings fell in USD".
   - Each headline's tag comes from its own sign. The other lens appears only as a labelled
     secondary line ("Seen from euros: −9 pp"), never as a contradiction.
   - One sentence ties the two lenses together: a stronger euro shrinks the book in € and
     makes each deposit buy more dollars.
3. **Costs are negative everywhere** (−€12, orange `--color-neg`): minus always means it cost you.
4. **Auto refresh:** the icon stays still. A subtle pulse marks a tick start. A short, distinct
   "landed" cue (one quick rotation, and the "Updated hh:mm" stamp flips) marks the end. Only
   a manual refresh spins the whole time.
5. Add a little fun to the four daily or weekly moments: the US open and close bells, and the
   FX weekend close (Fri) and reopen (Sun).

## Working rules

- Branch `claude/pensive-ptolemy-2mrwcx`, recreated from `origin/feat/v7.3.0`. Merge `main` in
  once 7.3.0 lands. One PR into `main`, release **7.3.1**: version lockstep in three files,
  lockfiles, `openapi.json`, `api-types.ts`, CHANGELOG, and the `docs/v7_plan.md` status line.
- **Investigate before fixing.** Each phase starts with a failing test on a synthetic ledger
  that reproduces the inconsistency, then the fix. Never use real data, never touch the server.
  Screenshots come from the synthetic demo or fixture app.
- Every new co-displayed colour pair goes into `tokens.cvd.test.ts`. Animations respect
  `prefers-reduced-motion`. BEM and tokens only, no inline scripts.
- Subagents (one layer, own worktrees, disjoint files) are used only where noted. Every brief
  repeats the real-data and server rules.

## Restartable progress (this will take several rounds)

- **One big plan doc:** `docs/v7_3_1_plan.md` is this plan (context, owner decisions, phases,
  verification), committed once at the start. A phase's status changes there only when the
  phase finishes or its direction changes. It is not refilled at every substep.
- **Commits are the progress log.** Commit and push often: every finished piece of work, and
  always before a round may run out, even mid-flight (a WIP commit is fine).
  - The message names the phase and says what is done.
  - When work is unfinished, the body says what is left or the next step, e.g.
    `fix(currency): phase 1.1 range module; scenarios + fx_costs still on old helper`.
  - Restart: read `docs/v7_3_1_plan.md`, then `git log --oneline origin/main..HEAD`.
- Every subagent brief says the same: commit often with descriptive messages, and no separate
  progress documents.

## Phase 0: Evidence first (the consistency harness)

- `backend/tests/fixtures/currency_ledger.py`, a synthetic ledger:
  - EUR paid in, converted, then deposited later;
  - a weekend conversion, plus `kept_usd`;
  - an ECB-only deposit and a twin-estimated fund;
  - a falling dollar year, as in 2025.
- `backend/tests/readmodels/test_currency_consistency.py`: a matrix over range ∈ {1D, 1W, 1M,
  YTD, 1Y, All, Max} × view ∈ {EUR, USD} that calls every Currency endpoint's builder and
  asserts the invariants. They start as xfail and turn green as phases land.
  - Every panel reports the same `(start, end)` window for a range.
  - The € lines sum to the headline. Headline sign = tag = gap direction within a lens.
  - "Effect today" is identical across strip, Impact 1D and intraday end.
  - EUR↔USD switching changes only lens and unit, never the window.
  - On **All**, nothing in any payload is dated before the first transaction. On **Max**, the
    window starts at history start, and any pre-investing part is flagged `context_only`.
- Append the confirmed findings to `docs/v7_3_1_money_math_issues.md` §3, using the table from
  the audit.

## Phase 1: Backend money maths (main session, no subagent: it is the core)

1. **One range module:** a new `readmodels/currency_range.py` gives `resolve(range_key, today,
   first_txn, now)` → `Window(after, through, live: bool, granularity: intraday|daily)`.
   - It is built from `currency_effect.range_window` (`(after, through]`), which chains exactly.
   - 1D and 1W are `live=True` and end now. Their granularity is intraday (the 1/5 forex
     sessions already used by `currency_rate`).
   - **All and Max are always different** (owner, 2026-11-23):
     - **All** is strictly the investing window, from the first transaction to now. No panel
       may quote a number, point, record, rolling value or rate change dated before the first
       transaction. This fixes Exposure rolling (`currency_dollar._rolling` starting in 1999)
       and checks the rate chart, Scenarios and Conversions.
     - **Max** goes back to history start on every panel. Where your own money did not exist
       yet (Impact, Exposure book figures), the pre-investing part is shown as rate-only
       context ("what the dollar did before you started"), clearly marked and never added
       into your totals.
     - Remove the silent `effectRangeFor` Max→All swap.
   - Replace the five implementations and the three `_minus_months` copies.
2. **Attribution fix (§1 of the briefing)** in `readmodels/fx_attribution_rows.py`:
   - Value deposit flows at the day's rate. Add two labelled lines: "While your dollars
     waited" (`usd/r_deposit − usd/r_conv_ecb`) and "Conversion cost" (`domain/fx_spread.py`).
   - Pure maths goes in `domain/`, with hypothesis property tests (the € lines sum to the total
     for every range and split) and the four golden cases from the briefing: 1.03 → 1.17,
     weekend, `kept_usd`, ECB-only.
   - Re-add the reverted `headline_kind` from `fix/v7.3-impact-sign` (sha 6714abfe) for genuine
     timing cases only.
3. **1D = today live:**
   - The bridge, months, records and holdings in `currency_effect.py` take the live window.
     The holdings row is computed from today's live split instead of being skipped.
   - One "effect today" source: `metrics_service.DayMoveSplit`, which the strip
     (`currency.py:156`) and Impact use. The intraday line's last point is pinned to it, so the
     "uncovered" remainder goes away.
4. **Two lenses** in `currency_effect.py:1047` and `currency.py:238-282`:
   - Each view returns `headline` (its own lens), `lens_note` and `other_lens` (value + unit +
     label).
   - USD holdings effect = 0 with an explanation string. No EUR-holdings-in-USD figure.
   - Deposit € cost uses the same split as the EUR lens (waiting + cost), so the two lenses
     reconcile. A property test checks this: EUR lens total ↔ USD deposit lens through the rates.
5. **Short-window robustness:**
   - Scenarios on 1D/1W uses intraday rates for low and high, or returns
     `too_short: true` with a reason.
   - Dollar rolling honours the window, with the first transaction for All, and returns
     `too_short` instead of silently using 1M.
   - Conversions windows come from `currency_range`.
6. Regenerate `openapi.json` and `api-types.ts`. Check activity logs (no new routes expected).

## Phase 2: Frontend consistency (one subagent, after Phase 1's API types are fixed)

Files are under `frontend/src/pages/Currency/**`, `components/CurrencySection`, `CurrencyBox`
and `CurrencyLifetime`, plus `lib/format.ts`.

- **One sign and digit rule:**
  - money uses `Money signed`;
  - percent uses `formatPercent(signed, 1)`;
  - pp uses `formatPp(…, 1)`, always signed.
  - `ppSize` and `gapWords` keep the sign or say "lower/higher" consistently. `signOf` with the
    same digits so rounding never flips the colour.
  - Conversions shows cost as negative, plus `offText` replaced by `formatPercent`.
- Panel headers show the window from the server (`Window`), so every panel prints the same
  dates for a range. On Max, the pre-investing context is drawn muted or dashed, with a "before
  you started" label.
- Short ranges: charts get a real time axis (`formatAxisDate` with the actual span; intraday
  ticks as hh:mm). `long` and `RollingCard` cover 5Y and 10Y. `too_short` renders a calm one-line
  empty state, not a broken chart.
- USD view: the headline from its own lens, `other_lens` as a muted secondary line, and the
  one-sentence lens note. Holdings in USD show "0, your holdings are dollars" once.
- Tests: vitest snapshots per range × view on fixture payloads, plus the screenshot round at
  360 px and desktop in both themes (Playwright, synthetic data).

## Phase 3: The EUR "Now" dot includes twin ETFs

- `readmodels/live_graphs.py` `_now_values` (851-898) and `scheduler._tick_now_point`
  (556-588) call `metrics_service.last_session_split` once and use `value_now_est_*` /
  `overnight_est_*` when `estimated_funds` is set.
- Add `overnight_pct_est_*` (base = `value_now_est − move_est − overnight_est`). Use the matching
  pair in the graph-growth `now_value()` (1005-1018).
- `GraphNowPoint.funds_estimated` → the label reads "≈ Now".
- Fix: after the close, ticks also patch the dot (`scheduler.py:134` sends the now point;
  `tickPatch.ts:198,358`).
- Golden test: with a twin-estimated fund, the dot equals the hero's estimated total and the
  line's end.

## Phase 4: Refresh speed and a quiet indicator (one subagent, backend refresh files only)

- **Measure first:** add `perf_counter` step timings inside `auto_refresh.tick_refresh`, written
  to the existing pull_log/activity line (no secrets). A synthetic benchmark test runs with
  mocked yfinance latency.
- **Speed-ups,** in order of expected gain:
  - Drop the per-symbol `yf.Ticker(sym).info` in `fetch_market_times`
    (`yfinance_client.py:624`). Take the market time from the downloaded bar's last timestamp,
    and fall back to `.info` in a thread pool only for symbols with no bar.
  - `threads=True` in `_download_window` (`:242`).
  - Skip the 10-day fallback download for symbols in `expected_gaps` (NAV funds during the day).
  - Fetch the twin ETFs in the primary batch, or at the same time as it, and run the FX spot
    concurrently. Drop the duplicate per-minute FX fetch when the tick already did it.
  - Compute positions once per tick and pass them to `record_if_market_open`, `_tick_*` and the
    twin capture (today there are about 10 `compute_positions` calls).
  - `backfill_graphs()` only when a gap is detected, not every tick.
  - Warm the read cache only for reads that the tick's invalidation actually cleared.
- **Indicator** (`lib/refresh.ts` `deriveUpdateMode`, `TopBar.tsx:220`, `AppShell.tsx:173`):
  - Background refetches (`useIsFetching`) no longer count as an update.
  - Auto `refresh_started` gives a soft pulse ring on the icon (token colour).
    `refresh_finished`/`tick` gives one 360° turn (~500 ms) plus a flip of the "Updated hh:mm"
    stamp.
  - Manual stays "loud". A stall still shows its warning.
  - Merge the two refetch waves per minute into one (refetch on `tick`, not also on
    `refresh_finished` for auto runs).
- Target: a minute tick under ~3 s on the fixture benchmark. Report the before and after
  numbers in the PR.

## Phase 5: Market open and close transitions, with a bit of fun

**Correctness**

Files: `scheduler.py`, `read_cache.py`, `live_bus.py`, `ops.py`, `refresh.ts`, `MarketClock`,
`OverviewHero`.

- EOD runs inside `refresh_status.begin/finish`, so a manual refresh during EOD gets 409. The
  button then shows "Closing prices are being settled…" instead of an error. Tests cover the race.
- **A short close grace, not a long wait.**
  - The NYSE/Nasdaq closing auctions print at 16:00:00, and the official closes are usually out
    within seconds to about a minute.
  - So EOD waits a short grace (setting, default **60 s**, documented in `.env.example`).
  - EOD then does one silent re-pull at about +5 min if any close still looks like a pre-auction
    bar (bar time before 16:00 or volume not final). This re-pull is background-only and never
    blocks the UI.
  - Before coding, confirm against yfinance's behaviour with a mocked-bar test plus a quick
    look at its docs and issue tracker. Never use a live call against the owner's tickers.
  - The client's "Closing…" state covers the grace, so the screen never looks stuck.
- `market_state` goes into the read-cache key, and the cache is cleared at each bell.
- The scheduler publishes `session_closed` / `session_opened` SSE events carrying
  `prices_live: false/true`. The client clears `refresh.pricesLive` on them.
- A client "closing…" state holds from the bell until the closed payload arrives. The hero
  switches from "Live" to "Closing" to "Closed" with no flash of errors.
- At open, "Opening" holds until the first tick lands, then turns "Live" (no empty 1D chart:
  the first point is yesterday's close).

**Fun and polish** (minor, all of it with `prefers-reduced-motion` off-switches)

- **Bell moments** (US open and close): the clock's bell icon swings in a short three-beat
  wiggle with a soft ripple ring.
  - The phone copy is short and fits 360 px: "Bell! Market's open" / "Bell! That's the close".
    Fix the truncation of "The closing bell has rung" by giving it a short variant under the
    narrow breakpoint.
  - On close, the countdown reads "See you Mon 15:30"; overnight it reads "Opens in 17 h".
  - On open, the chip fades from a muted "Opening" to the live dot with one pulse.
- **FX weekend** (the rate chip and chart on the Currency page), using the forex session
  helpers in `domain/market_hours.py`:
  - **Fri ~23:00 CET close:** the rate chip settles into a small moon glyph with
    "FX market's off for the weekend", and the rate line ends with a calm end cap.
  - **Sun ~23:00 CET reopen:** a sunrise glyph and "FX is back". The first new tick draws in
    with a short line-grow.
- New glyph colours are tokens, and their pairs are added to `tokens.cvd.test.ts`. Every icon
  has a label, so no state relies on colour or motion alone.
- Tests use fake timers around each boundary (15:59:50 → 16:05, 09:29:50 → 09:31, Fri and Sun
  FX), asserting the copy, no error toasts, and the state sequence.

## Phase 6: Faster tests and a guideline (one subagent, tests/config/docs only)

1. Docs and `addopts`: run locally with `-n auto --dist loadfile` (xdist is already a dev
   dependency). This is the biggest win.
2. `backend/tests/api/conftest.py:46-64`: build the schema once per session into a template file
   and copy it per test. Test-only fast pragmas (`synchronous=OFF`, `journal_mode=MEMORY`),
   except in durability, backup and WAL tests, which opt out with a marker.
3. Hypothesis profiles in `tests/conftest.py`: `dev` caps examples (e.g. 30), and CI keeps the
   full counts via `HYPOTHESIS_PROFILE=ci` in `ci.yml`.
4. Add `--durations=25` to the CI pytest call so slow tests stay visible.
5. Fix the laptop-only failures: `tests/storage/test_cloud_and_paths.py` also clears `APPDATA`
   and `LOCALAPPDATA`. Remove that caveat from AGENTS.md once it is green.
6. Frontend: try `pool: 'threads'` and keep it if it is faster. Measure in the sandbox and report.
7. **Guideline:** a short "Testing for agents" section in AGENTS.md:
   - a change-type → command table (domain, readmodels/services, API, migrations, storage,
     adapters, frontend, web);
   - `-x --lf` while iterating, never the full suite serially, `--durations` when slow;
   - limits on `max_examples` and on sleeps or network in tests.
   - CONTRIBUTING.md points to it.
8. Owner action (explained step by step in the PR, not done by an agent): add a Defender
   exclusion for `%TEMP%\pytest-of-*` and `backend\.venv`, then run
   `uv run pytest -n auto --durations=40` once and paste the summary.

## Order and parallelism

- Phase 0 → Phase 1 run in the main session first.
- Phases 4 and 6 have disjoint files and run as parallel subagents from the start, in their own
  worktrees.
- Phase 2 runs after Phase 1's API types settle.
- Phases 3 and 5 run in the main session after Phase 1. They touch `scheduler.py` (refresh
  steps in Phase 4 versus `_tick_now_point`/EOD here), so the hunks stay coordinated: Phase 4
  owns `auto_refresh.py`, `yfinance_client.py` and `prices_service.py`, and the main session
  owns `scheduler.py`.

## Verification

- Backend, from `backend/`:
  - `uv run ruff format . && uv run ruff check . --fix && uv run mypy
    src/investment_dashboard/domain && uv run lint-imports`;
  - targeted runs: `uv run pytest -n auto tests/readmodels/test_currency_consistency.py
    tests/readmodels tests/domain tests/api -k "currency or fx or graph or scheduler or refresh"`;
  - `tests/test_migration_roundtrip.py` only if a model changes (none planned).
- The consistency matrix is fully green: same window per range, € lines sum, the sign, tag and
  gap agree per lens, and "today" is identical across panels.
- Frontend and web: `npm run typecheck && npm run test`, including the CVD test and fake-timer
  bell tests.
- Screenshots on synthetic data, 360 px and desktop, light and dark:
  - Currency page at 1D, 1W, 1M, All, in EUR and USD;
  - the clock at the closing and opening bells and at the FX weekend close and reopen, on a
    phone width.
- Refresh benchmark before and after in the PR. CI runs the full suite. Check for conflicts
  with `main` at the end.
