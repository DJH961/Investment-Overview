# v7 — implementation notes

> Technical companion to [`v7_plan.md`](v7_plan.md), written 2026-11-10.
> The plan says *what* and *why*; this file says *how*, push by push: files,
> formulas, API shapes, tests and traps. It is for the Claude session that
> builds a push. Findings are referenced by id (B-… in
> [`v7_audit_backend.md`](v7_audit_backend.md), F-… in
> [`v7_audit_frontend.md`](v7_audit_frontend.md)).
>
> Status of these notes: ideas and starting points, not decisions. Anything
> marked **verify** was not checked in the code or against a provider. Where
> a note and the code disagree, read the code, then fix the note. `AGENTS.md`
> wins over everything here.

---

## 0. Rules for every push

**Session shape.**

1. Read the push's row in plan §8, the sections it names, and this file's
   section. Then read the code you are about to change. Several notes below
   were written from the audits, not from a full read.
2. Write the **contract first**: endpoint paths, response fields, units,
   null rules. Put it in the PR description. Lanes start only after that.
3. Split into lanes with disjoint file ownership (typically `backend/` and
   `frontend/`). Opus for money maths and design; cheaper models for
   deletions, renames, fixtures, boilerplate.
4. The orchestrator alone touches the shared files, once, at the end:
   `CHANGELOG.md`, `backend/pyproject.toml`, `web/package.json`,
   `frontend/package.json`, the lockfiles, `backend/openapi.json`,
   `frontend/src/lib/api-types.ts`, `frontend/src/styles/tokens.scss`,
   activity labels (`api/activity.py`, `activity_log.py`).
5. One Alembic migration chain. If two lanes need a migration, they are
   written one after the other. Every migration has a working downgrade.
6. Money maths: one change per PR, golden values worked by hand in the test
   file's docstring, property tests with `hypothesis`, and a note of which
   displayed figures move and why. The owner checks the golden values
   before the next money change starts.
7. End of push: targeted `pytest`, `ruff`, `mypy` on `domain`,
   `lint-imports`, `npm run typecheck`, `npm run test`, the screenshot run,
   CI green, and a short "check by hand" list for the owner.

**Sprint settings.** Ask the owner whether to set `DEPLOY_MODE=scheduled`
for the push. Critical fixes still go `Deploy: now`.

**No heredocs** in any command; write a script to the scratchpad and run it
by path. Owner-facing commands are PowerShell.

**Keep in step** (AGENTS.md): activity log line for every new server
action, `.env.example` and RUNBOOK for every setting, Settings window for
every tunable knob (visible, grouped), CVD pair list for every new colour
pair, the `image` CI job for anything touching boot, scheduler or backups.

---

## Push 1 — "Trust" (backend fixes)

Order matters: B-018 first (dated), then the money fixes one PR each, then
the request-pipeline fixes.

**B-018 half-days.** `domain/market_hours.py` models one `_CLOSE`. Add
`session_close(day) -> time` and route `is_us_market_open`,
`latest_settled_session_date` and `regular_session_close` through it.
Early close is 13:00 ET on the day after Thanksgiving and on 24 Dec when it
is a weekday. The 3 July rule depends on where 4 July falls, so do not
derive it: use a small explicit table per year, checked against the NYSE
calendar (**verify** the next three years). Tests: 27 Nov 2026 at 13:01 ET
is closed and settled; the feed-stall detector stays quiet after 13:00.
The Brief's trigger (push 4) uses the same function.

**B-006 period start.** One helper, used by portfolio MTD, YTD growth, YTD
XIRR and the holding-level versions: opening value = value at the close of
`period_start - 1 day`; flows are those dated `>= period_start`. Check
`_best_effort_ytd_start_value` (first-year case) against the same rule.
`readmodels/queries/period_query.py` already does this; make both call one
function so they cannot drift. Golden: €50k book, €1k deposit on the 1st,
flat market, MTD = 0.00 %.

**B-007 day move.** Today: `value(last) - value(prev)`. Wanted: subtract the
session's net external flows, taken from the same `cashflows` legs XIRR
uses (own-date rate, conversion overrides included). Growth denominator:
`prev + flows`, the same shape as `_growth` in the MTD code. The
price/currency split keeps its convention (below, push 6) and the flow is
removed from the *price* part. Check the holding rows too: a buy must not
show as that holding's day gain. Golden: flat market, €1k deposit today,
day move = 0.

**F-081 server half.** The tick (`services/scheduler.py`, the SSE payload)
carries, per priced symbol, the server's day % and day move for both
reporting currencies, computed with the tick's own rate. The browser then
copies them (push 2 removes its own calculation in `lib/tickPatch.ts`).
Same for the treemap's category day % (F-029): send it, do not derive it.

**B-001 commit order.** FastAPI runs a `yield` dependency's teardown after
the response is sent. Options: `Depends(get_session, scope="function")`
(**verify** the installed FastAPI supports it), or commit explicitly at the
end of write routes. Then move the side effects behind the commit: collect
live events and cache-generation bumps on the session
(`session.info["after_commit"]`) and fire them from a SQLAlchemy
`after_commit` listener. Test: a write whose commit raises returns 5xx,
logs "failed", bumps nothing, publishes nothing.

**B-002 ETags.** Add a coarse time component to the digest in
`services/read_cache.py`: exchange date, market state, and the TTL bucket.
A 304 must never outlive the server-side TTL.

**B-012 tab catch-up.** `GET /api/live` returns a boot id and the read-cache
generations. Client: new boot id resets `lastSeq`; changed generations
trigger a refetch. Push 2 does the client half; agree the fields here.

**B-003 read-only POSTs.** One set of "POSTs that change nothing", shared by
the cache middleware and the activity middleware.

**B-017 cash check.** Do not change the valuation yet. Add a Data Health
check: any brokerage account whose ledger cash balance (excluding
money-market-routed amounts) is not zero. Report to the owner; the
valuation change is decided from the result, and must be settled before
push 8.

Also here: B-010, B-015, B-016, and repository-layer tests for whatever
these fixes touch.

---

## Push 2 — "Fit" (frontend fixes and the test harness)

**Fixture mode, the piece everything else needs.** Goal: run the real
frontend with no backend, no login and no real data.

- Generate fixtures from the real read models: a backend tool
  (`tools/make_fixtures.py`) builds a seeded synthetic ledger in a temp
  database, calls every `/both` read model and writes JSON keyed by
  endpoint. Fixtures then cannot drift from the API: CI regenerates and
  fails on a diff, like `api-types.ts`.
- The synthetic ledger is deliberately nasty: seven-figure totals, a
  holding with a very long name, negative and tiny values, a NAV fund with
  a pending twin, every status pill, a EUR-native instrument, an empty
  account. No real tickers or amounts (public repo); use obviously fake
  symbols.
- Serve them with a mock layer behind a build flag (`VITE_FIXTURES=1`),
  excluded from the production bundle. No inline scripts (CSP). A second
  fixture set "empty ledger" covers the empty states.

**Overflow detector, better than pixel baselines.** A Playwright test walks
every route at 360, 390, 768, 1024, 1280 and 1440 px in both themes and
asserts in the page: no element has `scrollWidth > clientWidth` unless it
is marked as a scroll container; no text node's box leaves its card; the
document does not scroll sideways. This fails on clipping without storing
screenshots in the repo. Screenshots are uploaded as CI artifacts for the
owner to look through. Run it once *before* fixing anything: it should find
F-001, F-002, F-027, F-028, F-019, F-038, F-051, and probably more.

**The clipping fixes share one cause.** Add two mixins in
`styles/mixins.scss`: `truncate` (block-level, `min-width: 0`, `overflow:
hidden`, `text-overflow: ellipsis`, `white-space: nowrap`) and
`shrinkable` (`min-width: 0; flex-shrink: 1`). Replace the hand-written
variants. `text-overflow` on a flex container does nothing; it has to sit
on the text element. Numbers use tabular figures so live ticks do not make
columns jitter.

**Other items.**

- F-081 client half: `patchRow` in `lib/tickPatch.ts` stops computing
  `today_pct` / `today_move`; it copies the tick's server values.
- Decimal comma (F-043, F-053): one `lib/parseDecimal.ts` that follows the
  display preference, used by every numeric input. Invalid input shows an
  error; it never becomes 0.
- Lost work (F-003, F-071, F-063): the hide-numbers toggle becomes context,
  not a remount; a navigation guard for dirty Settings and a pending import
  preview; leaving an import cancels it on the server.
- F-082 invalidation kinds, F-004 stream reopen after login, F-070 advanced
  settings visible, F-087 contrast, F-055 undefined token, and the five
  plan §7 patches.
- Smoke tests for the untested UI primitives and the transaction form.

---

## Push 3 — "Ready"

- **B-013:** build the currency-independent part of the overview once and
  project both currencies from it. Measure before and after with the
  existing `Server-Timing` header.
- **F-083:** persist the query cache on `visibilitychange` and idle, not on
  every tick; leave graph series out of the persisted set.
- **Scheduler:** `last_eod_session` and the backup "dirty since" marker move
  into `app_config` (B-004, B-020); EOD steps return ok/failed (B-005);
  `due()` runs through `asyncio.to_thread` (B-019).
- **B-021:** `activity("changes")` lines for transaction and conversion
  create/update/delete: id, date, kind, account. No amounts.
- **B-008, the cutover's prerequisite:** `income_dual`,
  `build_instrument_cashflows` and `compute_instrument_metrics._legs` go
  through `cashflows.txn_eur_amount` / `txn_usd_amount`; drop the
  today's-spot fallback. Holding-level EUR figures will move slightly; say
  so in the changelog.
- **Second audit pass:** importers and staging, `intraday_snapshots_service`,
  auth and passkeys, migrations and downgrades, the unread read models, the
  Diagnostics sub-tabs. Same format as the first audit, appended to the
  audit files; fix highs and mediums in this push.
- **P7 ledger completeness.** New check in the diagnostics service. For each
  instrument, take the provider's dividend and split history (**verify**
  what the yfinance adapter already exposes). For each ex-date on which the
  ledger held shares, expect a dividend or reinvestment transaction within
  a window after it (pay dates trail ex-dates by days to weeks; start with
  60 days and tune). Money-market funds pay monthly and need their own
  rule. Output: "possible missing dividend: <symbol>, ex-date, shares
  held". Also: days since the last import per account; an optional
  share-count comparison against numbers the owner types in. Findings are
  hints, never auto-fixes.
- Coverage tools: `pytest-cov` and vitest coverage, reported, not gated.

---

## Push 4 — 7.0: cutover and Daily Brief

Two lanes that do not touch each other.

**Lane A, cutover** (plan §8 lists what goes). Order: tag `v5-archive` on
the last commit that has v5; delete; then AGENTS.md, CI and docs. Stop
writing the frozen legs and the old EUR snapshot columns; drop the columns
in a later migration. Remove B-014's unused routes and B-022's settings.
`api/legacy_v5.py` goes too (**verify** nothing in v6 calls it). Prepare
the owner's click list for Cloudflare and the `live-data` release.

**Lane B, Daily Brief.**

- `domain/brief.py`, pure: `brief_window(last_ack, now) -> Window | None`.
  It lists the NYSE session boundaries (opens and closes, half-day aware)
  in `(last_ack, now]`; none means no Brief, except the weekend FX-reopen
  case. A table-driven test covers: two visits in one evening, Friday to
  Monday, a holiday, a half-day, first login (`last_ack is None`: no Brief,
  set the marker).
- Marker `brief.last_ack_at` in app config, advanced only by
  `POST /api/brief/ack`. The ack is logged and bumps only the Brief's own
  cache key.
- `GET /api/brief` is its own endpoint. Do not put the card into the
  overview payload: a 304 would bring a dismissed card back.
- Figures: single-session windows reuse the day move (flow-free after push
  1) and its price/currency split. Movers use the shares held at the start
  of the window. Ledger events since the ack need a creation time on
  transactions (**verify** the column exists; the transaction date is not
  enough).
- Longer windows: the "N sessions passed" strip, no numbers, until push 6's
  attribution exists; then the Brief can show any window.

---

## Push 5 — 7.1: holding deep-dive

- **Route:** `/holdings/:id/:tab?`, tabs via the shared segmented control:
  performance, transactions, dividends, tranches, and for NAV funds the
  twin panel. Reuse the existing page chunk. One `HoldingRow` component
  replaces the three implementations.
- **Per-holding intraday:** migration renames `intraday_twin_prices` to
  `intraday_symbol_prices` and adds `kind`. The reconstruction, week
  backfill and live capture write each symbol's price beside the portfolio
  sample. Read: `GET /api/holdings/{id}/intraday?range=1D|1W` returns
  native price points; value in the reporting currency uses the
  per-instant rate on `intraday_value`. Test: the sum over holdings equals
  the portfolio line at every instant.
- **Tranches:** `domain/tranches.py`, a pure FIFO replay per account and
  instrument. Splits: apply the same cumulative split factor the positions
  service uses, to shares and to historical price. Reinvested dividends are
  their own tranches. Property tests: tranche shares sum to the position;
  replay is order-independent for same-day rows given a stable tie-break.
  Each tranche carries `long_term_on` (acquisition date + 1 year + 1 day;
  **verify** the exact day rule) for the countdown (P3).
- USD only in this push. The EUR column arrives with the pool (push 8).

---

## Push 6 — 7.2: Currency tab

**The daily split, written down.** With `N_t` the book in native dollars at
the close of day `t`, `r_t` the EUR/USD rate (dollars per euro), and
`E_t = N_t / r_t`:

- currency part: `C_t = N_t / r_t − N_t / r_{t−1}` — today's book valued at
  today's rate minus the same book at yesterday's rate. This is what
  `metrics_service.day_move_split` does today (`value_at_rate(book, fx_now)`
  minus `value_at_rate(book, fx_prev)`), so the tab matches the Overview.
- flow part: `F_t` in euros, from the cashflow legs (own-date rate,
  conversion overrides).
- market part: the remainder, `E_t − E_{t−1} − C_t − F_t`.

The three always sum to the day's change, so any period is the sum of its
days. `value_at_rate` already returns both currencies, so the USD view (the
effect on EUR-native holdings) falls out of the same code.

Things to settle while building:

- **Which daily rate.** The split needs one rate per day and it must be the
  same series the daily snapshots are valued at. If snapshots use the ECB
  fixing (about 14:15 CET) while the session legs use the 16:00 ET close,
  inside-plus-outside will not equal the daily part. Pick the session-close
  rate for attribution, and **verify** what `PositionSnapshot` stores.
- **Conversion overrides.** A matched deposit's euro cost is not
  `dollars / r_t`. The difference is conversion cost, not market. Until
  push 7 shows it separately, keep it inside the flow part and say so.
- **Session legs.** `outside_t = N / r_open_t − N / r_close_{t−1}` and
  `inside_t = N / r_close_t − N / r_open_t`, same book as the daily part.
  New table `fx_session_rates(session_date, open_rate, close_rate, source)`.
  It must survive a cache reset (it cannot be refetched far back), so it
  does not belong in a tier that a reset wipes. Backfill from hourly
  provider data (**verify** the reach with a real call).

**Module:** `domain/fx_attribution.py`, pure, `mypy --strict`. Inputs are
plain daily rows `(date, native_value_by_currency, rate, flow_eur)`.
Outputs: daily parts, cumulative series, period totals, session legs.
Property tests: parts sum to the change; zero currency part when the rate
is flat; additive over adjacent periods; inside + outside = currency part.
Golden: a ten-day hand-worked ledger with one deposit and one rate jump.

**Constant-currency line:** `E_t − Σ C_s` over the range. Not `N_t / r_0`.

**Read model and API** (`readmodels/currency.py`, `api/currency.py`):

| Endpoint | Returns |
|---|---|
| `GET /api/currency/both` | Today block (moved from the overview's `currency`), lifetime block, headline per standard period |
| `GET /api/currency/effect/both?range=…` | daily series (value, constant-currency value), bridge (start, flows, market, currency, end), session legs, month and year bars, per-holding three-way split, records |
| `GET /api/currency/rate-history?range=…` | rate series, the owner's average and break-even lines, conversion markers, percentiles |
| `GET /api/currency/scenarios/both` | rows for rates 0.90…1.60 step 0.01: value, gain, distance to break-even; plus sensitivity per cent |

Percentiles, scenario rows and the volatility figures are computed on the
server. The slider only selects a row. The per-holding split needs daily
per-holding native values; if the snapshots hold only portfolio totals,
compute per-holding parts from positions × closes for the range
(**verify**, and watch the cost: cache per range).

**Stats (plan §5 "The stats").** Each endpoint returns a `stats` block
beside its panel data, one entry per tile: value, unit, an optional
secondary value and a `kind` for the tailwind/headwind word. The top strip
comes from `/api/currency/both` and is patched on FX ticks only for the
linear tiles (rate now, today's effect, one cent). Streaks, medians,
shares and percentiles are computed in `domain/fx_attribution.py` or a
small `domain/fx_stats.py` from the same daily parts, so a tile can never
disagree with its panel. A stat without enough history (for example fewer
than three months for "share of months with a tailwind") is omitted by the
server, and the tile is not rendered.

**Risk block ("cushion or amplify"):** run the existing risk functions on
the EUR and the USD daily return series; add the correlation between the
USD-terms daily return and the daily change of `1 / r`, and the share of
down days on which the dollar rose.

**Frontend:** `pages/Currency/` with five sub-tabs; the constant-currency
chart is the shared `Chart` with a dashed second series and a hatched band
(add the colour pair to `tokens.cvd.test.ts`). The Overview's `CurrencyBox`
shrinks to a summary that links here. Periods gains a currency column from
the same endpoint.

**Long ECB history:** one-time backfill of `fx_history` back to 1999
through the existing Frankfurter adapter, via `fx_service` only.

---

## Push 7 — 7.3: conversions

- **Schema:** `fx_conversions` gains `from_ccy`, `to_ccy` (C1; existing
  rows are EUR→USD) and an optional `provider`. New
  `fx_conversion_pins(deposit_txn_id, conversion_id, amount)`. Both go into
  the export-v5 "dropped" note only if the cutover has not shipped yet.
- **Matching:** `domain/fx_pool.py` applies pins first, then FIFO over the
  unpinned remainder. A pin may reach a conversion up to 7 days after the
  deposit; FIFO never does. Property tests: dollars conserved; result
  independent of input order; removing all pins reproduces today's result.
- **Costs:** `domain/fx_spread.py` per plan §5.1. The reference must be the
  settled fixing (`fx_service.get_settled_rate`), never today's live
  overlay (B-011). A conversion dated today shows "reference not published
  yet".
- **Timing comparisons:** "all on day one" and "equal monthly amounts" are
  sums of euro amounts at each date's rate. Label them as comparisons, not
  advice.
- **"Invest this month" (P6):** a client-side wizard over existing
  endpoints: calculator → conversion form (prefilled) → deposit → planned
  buys. The plan is saved as a small server-side draft so the "check
  against the import" step can compare planned buys with imported ones
  later. Nothing is written to the ledger until the owner confirms each
  step.
- **Statement import:** a parser that emits conversions, through the
  existing flexible importer.

---

## Push 8 — 7.4: one rate everywhere

Strictly after pushes 4 and 7, and after B-017 and B-009 are settled.

- `domain/cash_pool.py` (generic name, C1): per account and currency, a
  FIFO queue of lots `(amount, cost_in_reporting_ccy)`, driven by
  `ledger_walk`, following the rules in plan §5.1 (deposits add at matched
  cost; buys consume; sells, dividends and interest add at their own
  date's rate; money-market moves are neutral; uncovered buys fall back to
  the day's rate and are flagged).
- Setting `fx.holding_cost_basis = pool | buy_date` in a new "Currency"
  settings group.
- Invariants as tests, and run on a copy of the real ledger before
  release: dollars conserved per account; holdings' EUR cost + pool EUR =
  EUR invested − realised EUR cost; Overview, Deposits and Transactions
  agree on EUR invested.
- **Dollars back to euros:** a `to_ccy = EUR` conversion consumes pool lots;
  euros received minus their cost is realised currency gain. Realised +
  unrealised must equal the lifetime effect shown since push 6; make that
  a test.
- Expect per-holding EUR figures to move. Ship with a before/after table
  for the owner.

---

## Push 9 — 7.5: tax information

Everything here is calculated in USD, labelled as information from the
ledger, not tax advice.

- **C3, euro worth beside each figure.** The tax read models return, per
  figure, the USD amount and `eur_worth` with the rate date used. Realised
  items convert at their own date's settled rate and totals are sums of
  those; unrealised and planned items convert at the rate sent in the same
  payload (`fx_now`), so the browser may also patch them on a tick (linear,
  single instant). Never derive a EUR gain from `eur_worth`: "Your gain in
  euros" comes from the EUR cost basis (pool rate after push 8) and is a
  separate field. The toggle changes display only, never the calculation:
  USD view renders the USD fields alone; EUR view renders `eur_worth` as
  the main figure with the USD amount beside it, plus the separate euro
  gain. Each field carries `eur_meaningful: bool`, set by the server, so
  form-mirroring lines (the 1099 check) stay in USD in both views. The
  tranche tab from push 5 follows the same layout from the start.

- **Cost-basis method is per account and instrument, and it matters.** US
  brokers commonly default mutual funds to average cost and ETFs or stocks
  to FIFO (**verify** for the owner's accounts; the 1099 shows the method).
  The tax pages need a method setting per account (FIFO or average), or
  the realised gains will not match the 1099. Tranches stay a FIFO view;
  the tax year page uses the account's method.
- **Realised gains:** per sale, proceeds, basis, gain, short or long term,
  from `domain/tranches.py` (FIFO) or the average-cost walk.
- **Wash sales:** a loss sale with a purchase of the same instrument within
  30 days before or after, including `dividend_reinvest`. The app cannot
  judge "substantially identical" across different funds; it can *mention*
  purchases of an instrument's index twin in the window, as a hint only.
  The sell planner runs the same check forward: "selling today at a loss
  would collide with the reinvestment expected around <date>".
- **Dividends:** ordinary total per year; a "holding period met" marker per
  payment (more than 60 days held within the 121-day window around the
  ex-date; **verify** the rule and that ex-dates are available). Whether a
  dividend is qualified also depends on the payer, so the page says
  "holding period met", not "qualified".
- **Tax year page:** one read model per calendar year built from the above,
  plus money-market income, capital-gain distributions (**verify** the
  ledger has a kind for them), fees, and withholding (new nullable column
  on transactions, with a migration).
- **1099 check:** the owner types the form's totals per account (ordinary
  dividends, capital-gain distributions, short- and long-term proceeds and
  basis, interest). Stored as plain config rows. The page shows the
  difference per line and links to the transactions behind it.
- Golden ledger: a partial sale across a split, a loss sale with a
  reinvested dividend eight days later, a tranche crossing one year.

---

## Push 10 — 7.6: the finish

- **Recaps (P8):** the attribution from push 6 over a month or a year, plus
  dividends and conversion cost. `GET /api/recap?period=2026-10`. Shown as a
  card on the first visit of a new month or year (same ack mechanism as the
  Brief) and always on Periods.
- **Real euro return (P10):** euro-area HICP, monthly, from the ECB or
  Eurostat public API (**verify** the series key and licence); a new small
  adapter, cache tier, read through its own service. Real return is
  computed on the server from the nominal EUR return and the index change
  over the same months. The latest month is published late: show "to
  <month>" honestly.
- **One channel for facts (P9):** email is the simplest thing that works
  everywhere; web push is nicer on the phone but needs the PWA installed
  and VAPID keys. Start with one, behind a setting that is off by default.
  Events come from a single `notify(kind, text)` service called by the
  scheduler: backup failed, feed stalled, ledger gap (P7), tranche turned
  long-term. Never amounts in the message. Secrets are the owner's to
  enter on the server.
- **Instrument metadata:** more fields on the enrichment dataclass (sector,
  industry, country, market cap, ISIN), columns plus migration, shown and
  editable in Instruments; allocation by sector and country. The model-
  assisted fill waits for the push after the cut.
- **Risk explanations:** hand-written text in the glossary and tooltips.
- **C3** is built in pushes 5 and 9, not here (see push 9).

---

## After the cut

Planned in detail only when 7.6 has shipped. The settled parts are in plan
§3.2 and §4: no currency amount leaves the server, the payload is built
field by field, a sentinel test guards it, the kill switch defaults to
off. News gets its own page. The assistant is undecided.

---

## Kick-off prompt for a push

> Build push N of `docs/v7_plan.md`. Read plan §8 and the sections it
> names, `docs/v7_implementation_notes.md` for this push, and the audit
> findings it lists. Write the API contract and the lane split first and
> show them to me. Then build it with subagents, keep the task list
> current, and finish with the gate, one release, and a list of what I
> should check by hand.
