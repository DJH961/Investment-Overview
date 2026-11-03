# v6 speed plan: "compute once, push small"

> Status: **Phase 1 built (6.2.1, PR open)**, Phases 2–3 to follow (approved 2026-11-03). Written because the live v6 app
> feels slow and the live connection often drops. The question asked was: should
> the clients do the maths instead of the server? Short answer: **mostly no, but the
> instinct behind it is right.** The server isn't too weak. It does the same work
> many times over, all at the same moment. Fix that first, and let the client do
> only the cheap, safe "last mile" sums.

## 1. Verdict

| Idea | Verdict |
|---|---|
| Server is the only place that polls prices | **Keep.** This is what killed the v5 credit rationing, and it still holds. |
| "The server is too weak for the maths" | **Probably the wrong diagnosis.** One owner's ledger is a few hundred cashflows; XIRR over that takes milliseconds. The slowness comes from *how often* and *how many times at once* we compute (§2), plus a probably too-small memory limit. |
| Move all calculations to the client | **Don't.** It brings back v5's worst problem: two implementations of the money maths (Python + TypeScript) that drift apart. v6 was built to remove exactly that (see the plan's Context: "web⇄desktop curve reconciliation"). It is also the most expensive option by far (§5). |
| Small packets for live updates instead of reloading everything | **Yes, this is the real win.** Most of it is already half-built: the `tick` SSE event already carries totals, and TanStack Query already persists its cache. |
| Client does *some* maths | **Yes, but only linear presentation maths** on numbers the server sent: `qty × price × fx`, sums, a share of a total. No XIRR, TWR or FX-aware returns on the client. |

## 1a. What it must feel like (owner requirements, 2026-11-03)

The client may stay "weak" as long as the owner never feels it. These are the
acceptance tests for every phase:

| # | Requirement | Pass when |
|---|---|---|
| R1 | **Live graph moves by itself** while the market is open | a new point appears every tick (60 s, max 2 min) with **no** spinner, flicker or refetch |
| R2 | **Prices and FX update quickly** | a tick's prices **and** EUR/USD rate show on screen within ~1 s of the server's pull finishing; rows, totals and the currency box all move together |
| R3 | **EUR ⇄ USD switch is instant** | toggling makes **zero** network requests and repaints in one frame, on every page |
| R4 | **Projection never blanks** | switching currency (or editing a field) keeps the old graph on screen until the new one is ready; it never disappears and reloads |
| R5 | **Coming back is instant** | reopening the tab/app after minutes shows the last numbers at once, then catches up (missed graph points included) from one small packet |

### The general rules (apply to every page, not just these five)

R1–R5 were the ones the owner noticed. A full page-by-page audit (§1b) found the
same pattern almost everywhere, so the acceptance tests are these general rules,
checked on **every** page and **every** control:

| # | Rule | Concretely |
|---|---|---|
| G1 | **No blanking after the first paint.** | Once a page has shown data, no interaction (currency, range, group-by, lookback, filter, tab) replaces it with a skeleton or an empty chart. Old data stays visible, dimmed if needed, until new data lands. Skeletons appear only on a page's very first visit with an empty cache. |
| G2 | **View changes cost no request.** | Currency, sort, search, group-by, show/hide and the other filters over data already loaded are pure client operations. |
| G3 | **Writes feel instant.** | A save, edit, delete or toggle updates the screen at once (optimistic), then confirms; on failure it rolls back with a message. The settings pattern for currency and theme (`lib/prefs.tsx`) is the model to copy. |
| G4 | **Writes refresh only what they touched.** | No full-app `invalidateQueries()`. Each write names the keys it changes. |
| G5 | **Typing never spams the server.** | Text filters are debounced (~250 ms) or done client-side. In-flight requests are cancelled when superseded, so answers can't arrive out of order. |
| G6 | **Every page is warm before you tap it.** | Everything reachable from the nav is prefetched in idle time after start-up, for both currencies. That includes analytics, calculator inputs, instruments, deposits and settings, not just the overview set. |
| G7 | **Live stays live.** | R1, R2 and R5 hold on every page that shows a price-dependent number, not only Overview. |
| G8 | **Budgets.** | Any interaction repaints within 100 ms (from cache or optimistically). A server answer, when one is needed, takes under 300 ms at p95. A tick takes under 5 KB with zero follow-up requests. Cold start paints from the persisted cache within 1 s. |

### Why R3 and R4 fail today (found in the code)

- **Every payload is for one currency.** Query keys include `ccy`
  (`frontend/src/lib/queries.ts`), and `prefetchPlan(ccy)` only warms the current
  currency (`frontend/src/lib/prefetch.ts`). A switch has to fetch everything
  again, and because ticks keep marking queries stale, the other currency's copy is
  usually stale even if it was loaded once.
- **The server already computes both currencies and throws one away.** The overview
  and holdings read models choose with `pick(eur, usd, ccy)` (17 and 22 call sites in
  `readmodels/overview.py` and `readmodels/holdings.py`). The projection builds
  both currency legs too (`readmodels/projection.py`). So sending both costs the
  server **nothing extra**, and the payload grows by maybe 30–60 %.
- **The projection is a per-currency mutation.** `useProjectionMutation(ccy)` has
  `mutationKey: [..., ccy]` (`frontend/src/lib/queries/reports.ts`), so a switch
  makes a fresh mutation with no data. The chart's series becomes `[]` and the graph
  disappears until the POST returns. Mutations also aren't cached, so going back to
  the previous currency recomputes too.
- The projection form also clears `contribution` and `target` on a switch
  (`pages/Projection/Projection.tsx`, on purpose: money typed in one currency would
  be misread). Better: convert them at today's spot rate, which is allowed by the
  currency rule because it's a single instant.

### The fix for R3/R4: dual-currency payloads, the client only picks

Every read endpoint (and the snapshot, ticks and projection) returns **both**
EUR and USD numbers, each computed properly by the server (FX-aware returns stay
server-side). The `ccy` query parameter goes away, and the currency becomes a
**client-side view choice**: `value[currency]`. This is still a weak client: it
picks a field, it does no conversion and no return maths. It is the cleanest way to
make R3 true without breaking the currency rule.

## 1b. Page-by-page audit (static code read, 2026-11-03)

Every row is a test. "Fix" names the rule from §1a it falls under. Paths are under
`frontend/src`.

| Page | Weak-feel issue | Where | Rule | Fix |
|---|---|---|---|---|
| **All** | Every ledger write, instrument edit, import, undo and SSE `refresh` invalidates the whole cache. FX save/delete invalidate with no filter at all (even auth). | `lib/queries/ledger.ts:39-42`, `instruments.ts:25`, `imports.ts:36`, `manage.ts:46-57`, `lib/live.ts:61`, `lib/refresh.ts:73` | G4 | per-write key lists |
| **All** | No optimistic updates anywhere (no `onMutate`). | `lib/queries/*` | G3 | add for transactions, instruments, accounts, allocation targets, settings, FX conversions |
| **All** | Prefetch covers one currency and only the overview set. Never risk, calculator inputs, instruments, transactions, deposits, dividends, settings. | `lib/prefetch.ts:36-45` | G6 | prefetch everything in idle time, both currencies |
| **All** | Duplicate query keys with different fetchers or `staleTime`: `["instruments"]` ×2, `useAllocations` ×2, `useDeposits` ×2. Which one wins depends on mount order. | `queries/maintenance.ts:162`, `instruments.ts:14`, `portfolio.ts:57`, `allocations.ts:16` | G1 | one hook per key |
| **All** | No route code-splitting: one heavy first bundle. | `App.tsx:9-27` | G8 | `lazy()` routes + idle preload of every chunk (no blank on first tap) |
| Overview | Currency switch skeletons the hero, KPIs, movers, holdings and allocation cards. | `pages/Overview/Overview.tsx:33,68` | G1, G2 | dual-currency payloads |
| Overview | Chart drops to loading on a currency switch, although the graph payload already carries the other currency (`secondary`). | `lib/queries/portfolio.ts:51` | G2 | pick `secondary` locally |
| Overview | Every range click also fires a `PUT` to remember the range. | `components/ValueChartCard/ValueChartCard.tsx:114` | G2 | debounce, or fire and forget (it already doesn't block) |
| Overview | `position_count === 0` swaps the page to the empty state, which can flash on a partial payload. | `Overview.tsx:57` | G1 | only on a confirmed-empty ledger |
| Holdings | **Group-by toggle skeletons the whole page**: `groupBy` is in the query key, with no `placeholderData`, just to get subtotals. | `pages/Holdings/Holdings.tsx:186,474`, `lib/queries/holdings.ts:16-24` | G1, G2 | subtotals client-side (sums), or server sends all groupings |
| Holdings | The history range in the drawer blanks the chart; there is no prefetch on open. | `Holdings.tsx:123-134`, `queries/holdings.ts:27-31` | G1, G6 | `keepPreviousData`; prefetch on hover/open |
| Holdings | Currency switch skeleton. | | G2 | dual currency |
| Allocations | **Page-level gate** on allocations + calculator inputs; inputs never prefetched. | `pages/Allocations/Allocations.tsx:63,77` | G1, G6 | per-section loading; prefetch |
| Allocations | Saving a target waits for the server, then refetches. | `SaveTargetDialog.tsx:50,79` | G3 | optimistic |
| Allocations | Rebalance/builder plan is a server round trip per click. | `Builder.tsx:306` | G1 | keep the result visible, debounce. It is linear arithmetic, so it's a candidate for the client (§4.5 rule) |
| Periods | Currency switch skeletons, though the page already fetches both currencies (4 hooks). | `pages/Periods/Periods.tsx:161-164,209` | G2 | swap to the cached one; later dual currency |
| Projection | Currency switch blanks the graph (mutation keyed on ccy). | `Projection.tsx:134,297` | G1, R4 | §4.5 |
| Projection | Each form change POSTs after 300 ms without cancelling the previous one, so answers can land out of order. | `Projection.tsx:140-143` | G5 | `useQuery` + abort signal |
| Risk | Lookback control skeletons the page; analytics never prefetched. | `pages/Risk/Risk.tsx:97,206` | G1, G6 | `keepPreviousData`; prefetch the default lookback |
| Activity | Account/kind/year filters are server round trips over data already loaded. | `lib/queries/activity.ts:28` | G2 | filter client-side |
| Activity | Dividends tab: a skeleton on first open. Currency switch: skeleton. | `pages/Activity/Activity.tsx:71,354` | G1, G6 | prefetch; dual currency |
| Transactions | **The search box hits the server on every keystroke** (same for symbol, kind, account, date). The shell chip flips to "Loading" each time. | `pages/Transactions/Transactions.tsx:151-168,183-186,297-304` | G5 | debounce; or load the whole ledger once (it's small) and filter, sort and page client-side |
| Transactions | Sort and page clicks are server round trips. | `Transactions.tsx:167-168` | G2 | client-side (same) |
| Transactions | Create/edit/delete wait, then refetch the whole app. Opening an edit fetches the row again although it's in the list. | `Transactions.tsx:176-209`, `queries/ledger.ts:40-100` | G3, G4 | optimistic; seed the edit from the list row |
| Instruments | An edit waits, then refetches the whole app. Not prefetched. | `pages/Instruments/Instruments.tsx:143,373` | G3, G4, G6 | optimistic; narrow invalidation |
| Currency conversions | Save/delete refetch everything. Not prefetched. | `queries/manage.ts:48,56` | G3, G4, G6 | same |
| Import | Confirm shows a spinner only, with no progress, then a full-app refetch. Each reparse/mapping answer is a round trip with a spinner. | `pages/Import/Import.tsx:141,276`, `UnknownActions.tsx:33`, `ColumnMapping.tsx:73` | G4, G8 | progress events over SSE; narrow invalidation. Round trips are fine here (rare, server-side parsing), but keep the previous preview visible |
| Settings | Page-level gate on schema + values. Saves aren't optimistic and refetch every settings key. | `pages/Settings/Settings.tsx:182,275`, `queries/settings.ts:55-61` | G1, G3 | per-section render; optimistic |
| Diagnostics | Log `contains` filter queries on every keystroke, and the list skeletons on each filter change. | `pages/Diagnostics/LogsTab.tsx:23,69`, `queries/maintenance.ts:135` | G5, G1 | debounce + `keepPreviousData`. Low priority (admin page) |
| Login / auth | Fine: renders from the signed-in hint. | `RequireAuth.tsx:20` | | |
| Help, NotFound, Onboarding | Fine (static / one fetch). | | | |

Things the audit confirmed are already good: no refetch on window focus, a cache
persisted for 24 h (instant cold paint), client-side sort and search on Holdings and
Instruments, range switching on the Overview chart (`keepPreviousData`), the XHR upload
progress on Import, and currency/theme preferences applied optimistically.

### 1c. Automated "feel" tests (so a regression can't sneak back)

The rules above become tests in `frontend/` (Vitest + Testing Library + the
existing fetch mock), one file per page, run in CI:

- **No-request tests (G2):** render the page with a warm cache. Toggle currency,
  group-by, sort, search and each filter, and assert **zero** fetch calls.
- **No-blank tests (G1):** with a slow mocked server, change range, lookback,
  currency or a projection input, and assert the chart/table stays mounted with the old
  data (no skeleton test-id) until the new answer lands.
- **Optimistic tests (G3):** for each write, assert the UI shows the new value
  before the mocked server answers, and rolls back on a 500.
- **Invalidation tests (G4):** for each mutation, assert the exact set of
  invalidated keys (snapshot of the key list).
- **Debounce/cancel tests (G5):** type 10 characters and assert at most 1–2 requests.
  Fire two projection inputs and assert the first is aborted.
- **Tick tests (R1, R2, G7):** feed a recorded tick into `handleLiveEvent` and assert
  the rows, totals, FX box and the last graph point all changed, with zero fetches.
- **Prefetch test (G6):** after the idle prefetch, every nav page renders without a
  skeleton.
- **Server budget (G8):** a backend pytest that builds overview, holdings, graphs,
  analytics and the projection on the demo ledger and fails above a time budget (generous on
  CI, e.g. 500 ms each). This is a tripwire for "someone made a read model 10× slower",
  not a benchmark.
- **Real-device check** before each phase's release: R1–R5 and G1–G8 by hand on the
  phone over mobile data during market hours.

## 2. What is actually slow (evidence from the code)

These are read from the code, not measured on the server yet. §3 says how to confirm them.

1. **Every price tick throws away the whole server cache.** During market hours the
   scheduler ticks every 60 s (`services/scheduler.py`), and outside market hours FX ticks every
   2 min. Each event goes through `LiveBus.publish`, which calls
   `read_cache.invalidate()` first (`services/live_bus.py:98`). The read cache has
   a 60 s TTL (`services/read_cache.py`), so it almost never gets a hit: it is
   wiped about as often as it would expire anyway.
2. **Every tick makes every open device refetch everything at the same second.**
   `frontend/src/lib/live.ts` invalidates `overview`, `holdings` and `graphs` on
   each `tick`/`fx` event. With a phone, a laptop tab and maybe a tablet open,
   that is several full recomputes, all started together. **This is a self-made
   thundering herd**, timed to the moment the server is also running the yfinance pull.
3. **Each request recomputes from the database, even when only prices changed.**
   `build_overview`, `build_graph` and holdings walk the ledger, rebuild
   cashflow streams and re-solve XIRRs. But between two ticks the ledger did not
   change. Only ~N prices and one FX rate did.
4. ~~**512 MB memory limit** → OOM kills → dropouts.~~ **Measured: no OOM kills.**
   The dropouts are deploy restarts (fast 502s) plus the client's 20 s timeout on
   slow reads (499s). The box does swap heavily, though (§3 results).
5. **Everything shares one CPU and one GIL.** The sync endpoints run in the
   threadpool, next to the scheduler's yfinance pulls. One slow compute delays
   everything else, including the health check (4 s timeout).
6. **Burst connections pay for the SQLCipher key derivation.** The pool is 5 + 10
   overflow (`db.py:108`). A burst like #2 opens overflow connections, and each new
   connection runs the PBKDF2 key setup. On one shared vCPU that can cost
   hundreds of ms each. Not confirmed yet.

None of these get better by moving maths to a phone. They get better by computing
**once per change** instead of **once per request per device**.

## 3. Step 0: measure (1 hour, the owner runs these)

Before building anything, confirm which of §2 is real. All commands are read-only,
over Tailscale (`/c/Windows/System32/OpenSSH/ssh.exe daniel@hetzner-djh-v1`, then:)

```bash
cd /opt/investments
```

Has the app been restarted or OOM-killed? (`RestartCount` above 0 or `OOMKilled: true` is the smoking gun for the dropouts.)

```bash
docker inspect $(docker compose ps -q app) --format 'restarts={{.RestartCount}} oom={{.State.OOMKilled}} started={{.State.StartedAt}}'
```

```bash
sudo dmesg -T | grep -i -E 'oom|killed process' | tail -20
```

Memory and CPU right now, ideally during market hours with the app open on two devices:

```bash
docker stats --no-stream
```

How long the main reads take (Caddy logs a `duration` in seconds for every request):

```bash
docker compose logs caddy --since 2h | grep -E '"uri":"/api/(overview|holdings|graphs)' | grep -o '"uri":"[^"]*"\|"duration":[0-9.]*' | paste - - | sort -t: -k3 -n | tail -20
```

Targets for after the fix: Overview p95 **under 300 ms** server time. A tick update
is **under 5 KB** and needs **no** follow-up request. **Zero** container restarts in a
trading week.

**Cheap experiment, same day:** raise `mem_limit` to 900m, or rescale the VPS one
size up (the plan already allows this; a few euros a month, ~5 minutes downtime).
If the dropouts stop, #4 was the main cause. This is a stopgap that confirms the
diagnosis, not the fix.

### Results of the quick measurement (2026-11-03, ~19:40 UTC, market open)

Read-only: Caddy access log for the last ~20 h (since 11-02 23:37 UTC), `docker
stats`, `free`, `vmstat`, `/proc/pressure`, `docker events`, plus 10 timed requests from
the laptop.

**Network is not the problem.** From the laptop, `/api/health` takes about 65 ms in
total, and the server's own share of that is about 18 ms. The index page is 594 bytes.

**The reads are slow, and they are tiny.** Every payload is 1–3 KB, so all the time
is compute:

| Endpoint | n | p50 | p90 | max | 5xx |
|---|---|---|---|---|---|
| `GET /api/overview` | 183 | **1.89 s** | **5.28 s** | 20 s | 42 |
| `GET /api/holdings` | 181 | 1.74 s | 5.22 s | 20 s | 43 |
| `GET /api/graphs/1d` | 155 | 1.82 s | 4.89 s | 20 s | 30 |
| `GET /api/graphs/1w` | 26 | 1.72 s | 3.16 s | 3.8 s | 0 |
| `GET /api/calculator` (inputs) | 8 | 2.34 s | 3.01 s | 3.0 s | 0 |
| `GET /api/instruments` | 12 | 0.53 s | **10.7 s** | 20 s | 0 |
| `GET /api/allocations` | 131 | 0.60 s | 2.28 s | 20 s | 37 |
| `GET /api/analytics` | 2 | 1.15 s | | | 0 |
| `GET /api/periods/monthly` | 43 | 0.50 s | 1.56 s | 2.5 s | 5 |
| `POST /api/graphs/1d/reload` | 1 | 9.7 s | | | 0 |
| `GET /api/settings/values` | 91 | 0.04 s | 0.93 s | 20 s | 0 |

For comparison, a simple read like `settings/values` has a median of 40 ms. So the
framework, database and network are fast, and the portfolio read models are 40–50× slower.
The 300 ms target is about 6× below today's median for Overview.

**What the errors are:**
- **~300 fast `502`s (0–1 s)** are clustered in three hours (11-02 23:00, 11-03 00:00 and 07:00 UTC).
  The 07:00 cluster matches **four deploys in 18 minutes** (07:31, 07:39, 07:43, 07:49).
  Each deploy restarts the app, so Caddy has nothing to talk to, the SSE stream drops,
  and every query fails until it's back. **This is a big part of "breaks off".**
  There were 8 production deploys today, because every green `main` commit deploys.
- **~30 `499`s at 18–20 s** are the browser giving up: `DEFAULT_GET_TIMEOUT_MS =
  20_000` in `frontend/src/lib/api.ts`. These are requests so slow the client
  aborted them. That's overload, and it's the other part of "breaks off".
- A few `500`s (about 25), some taking 32–88 s. Worth a look in the app log (§7).

**Out-of-memory kills: not happening.** `OOMKilled=false`, no OOM lines in the
kernel log, and the only container stop in the event log was a clean exit (code 0) at the
19:34 deploy. Hypothesis #4 (§2) is **wrong**.

**But the box is short on memory, and swaps during compute.** RAM is 927 MB total
and ~30 MB free, with **~700 MB in swap**. The two big processes are the app
(~210 MB RSS) and **Claude Code running as `dev` (~225 MB RSS)**. The second is documented
in the RUNBOOK, but it's the same size as the app. During a compute burst, `vmstat` showed
**96 % CPU and ~1.8 MB/s swap-in**: the app was paging its own memory back in while it
calculated. Pressure stall info: CPU `some` 36 % (avg10), memory `full` 4.6 %. The
load average is ~0.9–1.0 on 1 vCPU, so the single core is close to saturated all the time.

**What this changes in the plan:**
1. The design in §4 is confirmed: compute is the bottleneck, not bytes.
2. **New: deploys must not feel like outages.**
   - Batch releases on market days instead of 4 in 18 minutes. Agents push to a
     release branch, and the owner merges a few times a day.
   - Make a restart invisible on the client: keep showing cached data (G1), reconnect
     SSE quietly, and don't surface the 502 as an error while `/api/health` says a
     deploy is in progress.
   - Later, a blue/green swap behind Caddy (start the new container, wait for health,
     switch, stop the old one), so a deploy has zero downtime. About a day of work in
     `deploy/deploy.sh` + Caddyfile.
3. **Memory:** rescale one size up (2 vCPU / 4 GB). This removes the swapping and
   gives the scheduler's pulls their own core. It is cheap and quick, and it's now
   backed by numbers, not a guess. It's still a stopgap: Overview at ~1.9 s on a free
   core would still be about 6× over budget. Alternatively, don't run Claude Code on the
   server during market hours.
4. **New tripwire:** `GET /api/instruments` p90 10.7 s is far too slow for a list
   of instruments. Profile it with Phase 1.

### Rerun after stopping Claude Code on the server (2026-11-03, ~19:55 UTC)

The owner stopped the `dev` Claude Code session and will keep the server free of
dev work while performance is an issue.

- **Memory recovered:** about 200 MB free (was ~30), 514 MB available, and swap down
  from ~700 to ~440 MB. The app itself now has almost nothing in swap (`VmSwap` 248 kB,
  RSS ~190 MB). Memory pressure went from `full` 4.6 % to 0, and CPU pressure from 36 %
  to ~1 %. **This removes the tail spikes caused by swapping.**
- **But the calculations are slow on their own.** Each builder was timed directly in
  the app container on the quiet box (no HTTP, no other load, 3 runs each):

  | Builder | first | repeat |
  |---|---|---|
  | overview EUR | 1.44 s | 1.12 s |
  | overview USD | 1.78 s | 2.58 s |
  | holdings EUR | 1.61 s | 1.61 s |
  | graph 1d EUR | 1.18 s | 1.24 s |
  | graph 1m EUR | 0.45 s | 0.60 s |
  | periods monthly | 0.53 s | 0.45 s |
  | allocations EUR | 0.17 s | 0.16 s |

- **Why: the same data is read over and over.** In a profile of one Overview build,
  `list_transactions` runs **14 times**, `compute_positions` **7 times** and
  `latest_closes` 7 times. That's 107 SQL queries creating **~17,000 ORM objects**. About
  60 % of the time is spent fetching and building ORM rows (`fetchall` + SQLAlchemy
  loading). The money maths itself (ledger walk, XIRR, benchmark) is under 0.2 s.
- **So the biggest single fix is in Python, and it's cheap:** load the ledger
  (transactions, positions, latest closes, FX) **once per request**, or better, once per
  `ledger_rev`, kept in memory, and pass it to every builder. That alone should take
  Overview from ~1.1 s to roughly 0.2–0.3 s, and it's the foundation of Tier A in §4.
  This is now **step 1 of Phase 1**.

## 3a. Deploys without the "it broke" feeling

Both owner asks were checked against the code and are possible.

**Today:** `.github/workflows/deploy.yml` runs on `workflow_run` (every green `main`
push) and on `workflow_dispatch`. `deploy/deploy.sh` pulls the new image, then runs
`docker compose up -d`, which stops the old container and starts the new one. The
restart measured at 19:55 took **~5.6 s from container start to "ready"**, plus the old
container's stop. Open SSE streams keep it waiting up to Docker's default 10 s before
it's killed. So the gap is **about 10–20 s**, and the first requests after it are cold.

### a) Optional scheduled deploys (possible: GitHub Actions only, no server change)

- Add a repo variable `DEPLOY_MODE` with values `immediate` (default, today's
  behaviour, good for the development push) or `scheduled`.
- In `scheduled` mode the `workflow_run` deploy job is skipped, and a new `schedule:`
  trigger deploys the latest green `main` commit at a fixed time. Suggestion: weekdays
  21:30 UTC (after the US close in winter; GitHub cron is UTC and doesn't follow
  DST, so pick a time safe in both), plus every 4 h at weekends. It skips if that sha is
  already deployed. The last successful deploy's sha comes from the Actions API, so
  there is no new server command.
- `workflow_dispatch` stays as "deploy now". A commit trailer `Deploy: now` makes one
  push deploy immediately even in `scheduled` mode (urgent fixes).
- Switching modes is one click: Settings → Secrets and variables → Actions →
  Variables. The owner does this; agents don't.
- AGENTS.md "every green `main` commit deploys" gets a line about the mode.

### b) Announce the restart + ride it out on cached data (possible: small app + script change)

1. **Warning before the restart.** `deploy.sh` already runs commands inside the
   container (its `healthy()` check). After `docker compose pull app` and **before**
   `up -d`, it calls a new internal endpoint inside the old container,
   `POST http://127.0.0.1:8000/api/ops/announce-restart`, with the new version and
   an estimated downtime.
   - **Security:** the endpoint only answers requests from loopback that carry a
     per-boot random token. The app writes the token to `/tmp` (container-private tmpfs)
     at start, and `deploy.sh` reads it inside the same `exec`. Nothing from outside
     can trigger it. Caddy's requests never come from 127.0.0.1, and it
     logs via `activity("ops")`.
   - The app publishes an SSE event to every open device:
     `{"type":"server","state":"restarting","reason":"deploy","version":"6.0.2","eta_s":20}`.
   - `deploy.sh` then waits ~2 s so the event reaches the clients, and starts the
     swap.
2. **Shorter gap.** Set uvicorn `timeout_graceful_shutdown` to ~3 s and the
   compose `stop_grace_period` to ~5 s, so open SSE streams don't hold the old
   container for 10 s.
3. **The client stays useful during the gap.**
   - On the `restarting` event, or on a 502/503 or a dropped stream right after one, the
     shell shows a banner: *"Updating to 6.0.2 – back in about 20 s. Showing
     numbers from 19:54."*
   - All pages keep showing the persisted cache (G1). Failed queries during the gap
     are retried quietly and never shown as errors.
   - The client polls `/api/health` every 2 s. When the version changes it reconnects
     SSE, refetches once (staggered), and shows *"Updated to 6.0.2"* for a few seconds.
   - If the new version ships new frontend files, the PWA takes the new service worker
     on that reconnect, so you don't have to reload by hand.
4. **Unplanned restarts** (crash, server reboot) get the same banner with "Connection
   to the server lost, retrying" instead of the deploy wording, triggered by the
   dropped stream with no `restarting` event before it.
5. **With scheduled mode:** the scheduled run can also send
   `{"state":"restart_planned","at":"21:30"}` ~10 min ahead, so the banner can say "Update
   at 21:30".
6. **Later (optional):** zero downtime with a blue/green swap behind Caddy (start new,
   wait for health, switch the upstream, stop old). But two app processes would be
   open on the one SQLCipher file during the switch, and both run the scheduler, so it
   needs a "standby" mode. That's more than a day of careful work; not now.

Also: schema changes, the API contract (`openapi.json` / `api-types.ts`), the RUNBOOK
deploy section and the CI `image` job get covered; `deploy.sh` is installed by hand
(see its header), so the owner reinstalls it once.

## 3b. Memory on the 1 GB box (recommendations while we're stuck with it)

Measured: the app process is ~190 MB RSS. Importing the app alone peaks at 214 MB,
because pandas, numpy, yfinance, lxml, bs4 and curl_cffi load at startup (NiceGUI does
not). Docker logs are already capped (10 MB × 3) and `vm.swappiness` is already 10.

In order of value:

1. **Keep dev work (Claude Code) off the server** while performance matters. Done by
   the owner. It was ~225 MB, the same size as the app.
2. **Fix the repeated ledger loads** (§3 rerun). Fewer ORM objects means less memory
   churn per request, and steadier RSS.
3. **`MALLOC_ARENA_MAX=2`** in the Dockerfile `ENV` block. glibc gives each thread
   its own memory arena, and with the API threadpool plus the scheduler threads that
   fragments memory in long-running Python servers. This usually saves tens of MB at no
   cost. Measure RSS before and after.
4. **zram instead of (or in front of) the disk swapfile.** Compressed swap in RAM is far
   faster than paging to the cloud disk, and it suits a box that swaps a little now and
   then. Keep the 2 GB swapfile as a lower-priority safety net. This goes in
   `deploy/bootstrap.sh` + RUNBOOK (the server is configured only through the script),
   via the `systemd-zram-generator` package, ~25 % of RAM, higher priority than the file.
5. **Bounded in-memory caches.** The Phase 2 ledger snapshot / `live_state` costs a few
   MB, which is fine, but give each a hard size cap like `read_cache` has.
6. **Watch it.** Add RSS + swap of the app to Diagnostics and a warning line in the
   `system` activity log above ~400 MB, so creeping growth is caught early.
7. Don't lower `mem_limit` (512 MB is comfortable headroom for ~190 MB RSS). Don't
   lazy-import pandas/yfinance either: the scheduler needs them within a minute
   anyway, so it saves nothing in steady state.

**When you can upgrade:** the next size up (2 vCPU / 4 GB) gives the scheduler's pulls
their own core and ends swapping entirely. Use Hetzner's rescale with "CPU and RAM
only" (keep the disk size), so you can go back down later.

## 4. Recommended design: compute once, push small

Split every number by **what it depends on**:

| Tier | Depends on | Changes when | Who computes | How it reaches the client |
|---|---|---|---|---|
| **A. Ledger base** | transactions, instruments, settings | import, edit, end-of-day close | server, in the background, once per change | `GET /api/snapshot`, with ETag; persisted on the device |
| **B. Live market** | latest prices (native ccy), FX spot | every tick (60 s) | server polls (unchanged) | inside the SSE `tick` event, ~1–3 KB |
| **C. Live derived (non-linear)** | A + B: XIRR, TWR, FX-aware EUR returns, day-change % of the portfolio | every tick | **server, once per tick, in the scheduler, after the pull** | inside the same `tick` event |
| **D. Presentation (linear)** | A + B | every tick | **client** | not sent; derived on the device |

Tier D covers row values `qty × price`, the EUR value at this instant
`native × fx_now` (allowed by the currency rule: a value at a single instant), row
sums, weights and allocation shares. Everything non-linear stays in Python
(C), so there is still only one implementation of the money maths.

### 4.1 How a load works

1. **Cold open / reload.** The app paints instantly from the persisted TanStack
   cache (already in `frontend/src/lib/queries.ts`), then sends **one** request:
   `GET /api/snapshot` with `If-None-Match: <ledger_rev>`. Unchanged ledger →
   `304`, a few hundred bytes. This replaces the separate overview + holdings + graph
   calls on first paint.
2. **Then** `GET /api/live?since=<seq>` (or just the SSE `hello`, which can carry
   the latest tick). It returns the last tick: prices + Tier C numbers. This is the
   "live price 2 min later" packet: tiny, and computed already, so answering
   costs the server nothing.
3. **While open:** each SSE `tick` is applied with `queryClient.setQueryData`
   (patch in place). **No refetch.** A refetch happens only when `ledger_rev`
   changes (an import, an edit, the EOD close).

### 4.2 What the server does per tick

```text
scheduler tick
  → pull prices + FX                    (as today)
  → live_state = compute_tier_c(base, prices, fx)   # ONE compute, ms on a small ledger
  → store live_state in memory (seq += 1)
  → publish {type:"tick", seq, ledger_rev, prices{id: native}, fx, tier_c{...}}
```

`read_cache.invalidate()` on every event goes away. Cache keys get the
revisions instead (`ledger_rev`, `price_seq`), so a tick only drops entries that
depend on prices, and Tier A entries live until the ledger changes.

### 4.3 Graphs (R1)

History before today never changes during the day. Send it once (part of the
snapshot, or `GET /api/graphs/{range}` with a long ETag on `ledger_rev` + the
last close). On each tick the client **appends or replaces only today's point**
(the tick carries it). The 1D/1W intraday series gets one new sample per tick
instead of being rebuilt.

The tick's graph point is the same intraday sample the server already stores
(`IntradayValue`: native USD + the per-instant FX). So the EUR line point is
`usd / fx_at_that_instant`, a single-instant conversion, which the rule allows.
The server sends both values anyway (dual currency), so the client doesn't divide either.

### 4.4 What one tick packet contains (R1, R2, R5)

```jsonc
{
  "type": "tick", "seq": 1842, "ledger_rev": 37, "ts": "…", "market_state": "open",
  "fx": { "EURUSD": "1.0842" },
  "prices": { "12": { "px": "187.31", "ccy": "USD", "prev_close": "185.90" }, … },
  "totals":  { "EUR": { "value": "…", "day": "…", "xirr": "…" }, "USD": { … } },
  "point":   { "t": "…", "EUR": "…", "USD": "…" }   // the new graph sample
}
```

About 1–3 KB for a typical portfolio. After it lands, the client changes these
with `setQueryData`, in one render: holdings rows (`qty × px`, day change vs
`prev_close`), totals, the currency box, the overview KPIs, and today's point on
every cached graph range. R2's "within ~1 s" then depends only on the server pull,
because there is **no follow-up request** after the tick.

**R5 catch-up:** when a tab comes back (SSE was closed while hidden),
`GET /api/live?since=<last seq>` returns the latest tick **plus the graph points
missed since that seq** (the server keeps today's samples anyway). One small
request, nothing recomputed.

### 4.5 Projection (R4)

- Turn `useProjectionMutation` into a `useQuery` keyed on the request body only (not
  the currency), with `placeholderData: keepPreviousData`. The old graph stays up
  while a new one computes, and going back to an earlier input is a cache hit.
- The response carries both currencies (the server already builds both legs), so
  a currency switch is a pure re-pick and makes no request.
- Contribution/target typed in one currency are converted at the spot rate on a
  switch, not cleared.
- Optional later: the projection is pure, deterministic compounding with no ledger
  access, so it *could* run in the browser for keystroke-speed feedback. Not needed
  if the above lands. It would be the one exception to "no money maths on the
  client", so only do it if R4 still feels slow.

### 4.6 Rule change in AGENTS.md (once approved)

Replace "**Strong server, weak client**" with:

> **Server computes, client patches.** The server owns data, every provider call,
> secrets and **every non-linear money calculation** (XIRR, TWR, FX-aware returns,
> period growth). It computes once per change and pushes results. The client may
> do **linear presentation maths** on server-supplied values (sums,
> `qty × price × fx_now`, shares of a total) and must never compute a return.

The currency rule is unchanged: the client converts only at a single instant, with the
rate sent in the same tick.

## 5. Options compared (honest sizing)

| Option | What | Effort | Fixes slowness? | Fixes dropouts? | Long-term cost |
|---|---|---|---|---|---|
| **0. Measure + bigger box** | §3 (measured: no OOM; dropouts are deploys + slow reads) | done / a few €/month later | partly (swap tails) | no | none |
| **1. Quick fixes** | stop the cache nuke on tick; client patches the tick totals it already gets instead of refetching; drop the `compare` second line where it isn't shown; raise the pool size so bursts don't re-key | **1–3 days** | **a lot** | some | none |
| **2. Compute once, push small** (recommended) | §4: tier split, `/api/snapshot` + ETag, tick carries prices + Tier C, client patches, append-only graphs | **1.5–2.5 weeks** of agent work, done as 3 PRs | yes | yes (fewer, smaller requests; reconnect is cheap) | low: one maths implementation |
| **3. All maths on the client** (the original idea) | server ships raw ledger + prices; TS reimplements metrics, XIRR, TWR, FX-aware returns, periods, projection, rebalance (~8.6k lines of `readmodels/` + `services/` maths) | **5–8 weeks**, plus parity tooling | yes, after a heavy first load | yes | **high, forever:** two implementations, `Decimal` in JS, parity tests on every money change. This is v5's `compute.ts` / `returns.ts` again |

Why 3 also isn't faster in practice: a mid-range phone's single core is not faster
than a server vCPU. The phone would also have to download the whole ledger and price
history first, and on a weak mobile connection **bytes and round trips** are the
bottleneck, not CPU. Option 2 cuts both.

## 6. Phased plan (if option 2 is approved)

Each phase is its own PR and its own release (patch for 1, minor for 2 and 3).

**Phase 1: stop the herd (patch release, 1–3 days)**
- **Step 1, load once (§3 rerun):** a per-request `LedgerSnapshot` (transactions,
  positions, latest closes, FX), built once and passed to every builder, so
  `list_transactions` runs 1× instead of 14× and `compute_positions` 1× instead of 7×.
  Golden test: every read model's output is byte-identical before and after on the demo
  ledger and on a copy of the real one (`tools/parity_check.py`).
- **Deploy banner (§3a b)** ships with Phase 1. Scheduled mode (§3a a) is a separate
  small CI-only PR, any time.
- `services/live_bus.py`: stop calling `read_cache.invalidate()` on every
  event. Give `read_cache` per-dependency generations (`ledger`, `prices`, `fx`) and
  bump only the one that changed. Writes still bump `ledger`.
- `frontend/src/lib/live.ts`: on `tick`, patch overview totals from the event
  (`total_value_eur/usd`, `fx_eur_usd`, already sent) with `setQueryData`. Refetch
  holdings/graphs at most once per tick per device, **debounced and staggered**
  (random 0–5 s), and only for queries that are on screen (`refetchType: "active"`).
- `db.py`: pool size so a burst never opens overflow connections (each overflow
  connection re-runs the key setup).
- Add a `Server-Timing` header on the read endpoints so the browser's network tab shows
  server compute time. Note: this logs nothing sensitive.
- **R4 now:** projection becomes a `useQuery` with `keepPreviousData` (§4.5), so
  the graph never blanks, even before the dual-currency work lands.
- **R3 stopgap:** `prefetchPlan` warms both currencies (current one first), and
  currency-keyed queries use `keepPreviousData`, so a switch shows the old numbers
  instead of a spinner. Phase 2 replaces this with real dual-currency payloads.
- **Cheap G-rule fixes from §1b:** `keepPreviousData` on holdings (group-by),
  analytics (lookback), holding history, logs and dividends; debounce the text filters
  on Transactions and Diagnostics; narrow every full-app `invalidateQueries()` to the
  keys the write touched; drop the page gates on Allocations and Settings; remove the
  duplicate query keys; prefetch every nav page.
- Phase 2 adds dual currency. Phase 3 adds optimistic writes (G3), client-side
  filter/sort/page on Transactions and Activity, and lazy routes with idle preload.
- Tests: the §1c feel tests for each page touched; tick doesn't clear ledger-tier cache entries; client patch test in
  `live.test.ts`; Projection test that the chart stays mounted across a currency
  switch.

**Phase 2: snapshot + rich tick (minor release, ~1 week)**
- New `readmodels/snapshot.py` builder (one exists for the export, reuse its shape
  where it fits) + `api/snapshot.py` router with ETag = `ledger_rev`.
  `ledger_rev` is a counter bumped by every ledger write and the EOD close.
- Scheduler computes Tier C once per tick and stores `live_state` (seq, prices,
  fx, Tier C numbers). `tick` schema in `api/schemas/stream.py` gains `seq`,
  `ledger_rev`, `prices` (per instrument, native ccy + currency code) and the Tier C
  fields. `GET /api/live` returns the latest `live_state`.
- **Dual currency (R3):** overview, holdings, graphs, periods, allocations and
  projection responses carry `{EUR: …, USD: …}` for every money field. Replace the
  `pick(…, ccy)` calls with building both; drop `ccy` from the query keys. Size
  check: Overview + holdings + 1 graph range together stay under ~100 KB gzipped.
- Regenerate `backend/openapi.json` + `frontend/src/lib/api-types.ts`.
- Activity log: `/api/snapshot` and `/api/live` are reads, so there is no new subject. Check
  `subject_for` treats them like the other reads.

**Phase 3: client patches, graphs append (minor release, ~1 week)**
- `frontend/src/lib/`: a small `livePatch.ts` (pure functions, unit-tested) that
  applies a tick to the snapshot: row value, row day change, sums, weights.
  **Golden test:** for a recorded snapshot + tick, the client's sums must equal the
  server's Tier C totals to the cent.
- Graphs: history is fetched with ETag; ticks replace today's point. 1D/1W intraday
  append one sample.
- `/api/live?since=` catch-up on tab return (R5).
- Remove the now-unused per-tick refetch paths.
- **Acceptance:** run R1–R5 (§1a) on the phone over mobile data during market
  hours, with the laptop tab open at the same time.

**Not in scope:** moving XIRR/TWR/periods to the client (projection: see the §4.5 option); changing the
price-polling cadence; WebSockets (SSE is fine for one-way pushes and already works
through Caddy with `flush_interval -1`).

## 7. Risks and open questions

- **Dropouts (answered 2026-11-03):** not OOM. They are deploy restarts plus the
  client's 20 s timeout on slow reads. Open: the ~25 `500`s, some taking 32–88 s,
  and the `PATCH /api/settings/values` that took 88 s. Read the app log around those
  times before Phase 1.
- **Tier C per tick has to stay fast.** If one tick's compute takes more than a few
  seconds on the server, it's an algorithm problem (e.g. re-walking the full history
  per position) and should be fixed in Python. Profile it with `py-spy` on a ledger
  copy before Phase 2.
- **Client-side sums vs server totals** can differ by rounding. Rule: the client
  shows the server's total for headline KPIs, and uses its own sums only for rows and
  shares. The golden test in Phase 3 guards this.
- **Multiple devices** stay consistent for free: they all receive the same `seq`
  and nobody computes anything the others don't.
- Parallel work: `feat/resilient-importer` touches the importer only, so there's no overlap with
  Phases 1–3. An import must bump `ledger_rev` once Phase 2 lands.

## 8. Implementation plan (orchestrated)

This is the execution plan for §6. Each phase is **one PR = one release**, in small
steps. Other work keeps landing on `main`, so the exact number is taken from `main`
at release time, never fixed in advance:

| Phase | Bump | Why |
|---|---|---|
| Phase 1 | **patch** | speed fixes; the restart banner counts as a small UI update (under **Fixed**) |
| Phase 2 | **minor** | the one real feature: dual currency, the snapshot and live endpoints |
| Phase 3 | **patch** | client-side polish on top of Phase 2 |

The owner approved starting on 2026-11-03.

### 8.1 How the work is split (token-cost rules)

The orchestrator (Opus) is the expensive model. It writes **contracts, briefs,
release bookkeeping and the wave checks**, and nothing else. Workers read and write the
code.

| Rule | Why |
|---|---|
| **Few, large, area-shaped tasks** (2–4 per wave), each owning whole files | Every new worker pays a cold start: system prompt, tools, then re-reading files. Small tasks pay that many times over. |
| **One worker per area, reused across phases** via `SendMessage`: *backend-read*, *backend-live/ops*, *frontend-data*, *frontend-pages* | A worker's context (files it already read) stays in the prompt cache. Reusing it costs cached-input price instead of re-reading at full price. |
| **Reuse only while warm.** Reuse if the last turn was < ~50 min ago (this session's cache TTL is 1 h) **and** the worker's context is < ~120k tokens. Otherwise start a fresh worker with a pointer brief. | After the TTL, a resumed worker re-sends its whole history uncached, which can cost more than a fresh agent re-reading 10 files. A bloated context makes every later turn expensive. |
| **Briefs are pointers, never pasted code.** They point at this doc's sections (§1b rows, §3a, §4.4…) and `file:line`. | Workers read at Sonnet/Haiku prices; text pasted by Opus is paid at Opus output prices. |
| **Identical brief preamble** (rules pointer, verify commands, "don't touch CHANGELOG/versions", **"never use heredocs: use Write/Edit, scratchpad files, `git commit -F`"**), task-specific part last | Parallel workers of the same type share the cached prefix. |
| **No `fork` agents** | A fork runs on Opus with this whole (long) conversation. This doc holds everything a worker needs, so a fresh Sonnet worker is cheaper. |
| **Contracts as real code before a parallel wave** (schemas, signatures, stub routes; `api-types.ts` regenerated) | Workers build against files on disk, with no back-and-forth through the orchestrator. |
| **Haiku (`implementer-light`)** only for exact-pattern sweeps listed row by row in §1b, and for docs | Cheapest per token, but it retries on judgment calls, and a retry costs more than Sonnet once. |
| **Wave check is cheap:** `git diff --stat` (ownership), targeted tests with `tail -40`, then read hunks only for failing files. A failure goes back to the **same** worker (one retry). | Avoids Opus reading full diffs. |
| **Full test suite runs in CI on the PR** (2 min there, ~2 h on the laptop). Locally only the targeted tests per worker. | Zero tokens for the long run. |
| **No reviewer by default**, except Phase 1 B (loopback token endpoint = security-relevant): one `reviewer` over just those paths at the end | Review only where the risk is. |

**Where the work happens:** the main checkout has another agent's uncommitted importer
work (`feat/resilient-importer`). So each phase runs in **one dedicated worktree**
(`feat/speed-phase-N`, from `origin/main`). All of that phase's workers share it, with
disjoint files. That's not one worktree per agent, which would add merges. This doc is
committed there first.

**Single owners kept by the orchestrator:** `CHANGELOG.md`, versions in
`backend/pyproject.toml`, `web/package.json` and `frontend/package.json`, lockfiles,
`backend/openapi.json` and `frontend/src/lib/api-types.ts` (regenerated by command,
never hand-edited), and `AGENTS.md`.

### 8.2 Phase 1: stop the herd, deploy banner, memory (patch)

**Wave 0, orchestrator contracts (small, real code):**
- `backend/src/investment_dashboard/services/session_memo.py`: `memo(session, key,
  fn)`. It stores results in `session.info`, is cleared on `after_flush`,
  `after_commit` and `after_rollback`, and is used for read paths only. This is how
  "load the ledger once" works **without changing the signatures of the 24 callers**.
- `api/schemas/stream.py`: `ServerEvent` (`type:"server"`, `state:
  restarting|restart_planned`, `version`, `eta_s`, `at`). Then regenerate
  `openapi.json` + `api-types.ts`.
- `frontend/src/lib/useDebouncedValue.ts` and a typed `useProjection` stub in
  `lib/queries/reports.ts`: signatures only, so D can build against them.

**Wave 1, four parallel workers:**

| Task | Worker | Owns | Covers |
|---|---|---|---|
| **A. backend-read** | `implementer` (Sonnet) | `services/session_memo.py` (implementation), `repositories/transactions_repo.py`, `repositories/prices_repo.py`, `repositories/fx_repo.py`, `services/positions_service.py`, `services/read_cache.py`, `services/live_bus.py`, `db.py`, `api/app.py`, `api/instruments.py` + their tests, a new `tests/readmodels/test_read_budget.py` | memo wired into `list_transactions`, `compute_positions`, `latest_closes`, `get_rates`; per-dependency cache generations (no nuke on tick); pool size; `Server-Timing`; uvicorn `timeout_graceful_shutdown=3` (`api/app.py:run`); find the `/api/instruments` 10.7 s; **golden test: read-model output identical before/after**; time-budget tripwire |
| **B. backend-live/ops** | `implementer` (Sonnet) | `api/ops.py`, new `services/restart_notice.py`, `deploy/deploy.sh`, `deploy/docker-compose.yml`, `deploy/bootstrap.sh`, `deploy/RUNBOOK.md`, `Dockerfile`, `.github/workflows/deploy.yml`, `services/diagnostics_service.py`, `api/activity.py` + tests | §3a b) announce endpoint (loopback + per-boot token in `/tmp`, `activity("ops")`); `deploy.sh` calls it before `up -d`; `stop_grace_period: 5s`; §3a a) `DEPLOY_MODE` + `schedule:` + `Deploy: now` trailer; §3b `MALLOC_ARENA_MAX=2`, zram in `bootstrap.sh`, RSS/swap in Diagnostics + a warning line; RUNBOOK sections |
| **C. frontend-data** | `implementer` (Sonnet) | `frontend/src/lib/live.ts`, `lib/api.ts`, `lib/prefetch.ts`, `lib/refresh.ts`, `lib/queries/*.ts`, `lib/useDebouncedValue.ts`, `components/OfflineBanner/`, `components/AppShell/` + tests | tick patches totals with `setQueryData`; staggered, active-only refetch; prefetch every nav page in both currencies; `keepPreviousData` on holdings, analytics, holding history, logs, dividends; fill in `useProjection` (§4.5); narrowed invalidations + duplicate keys removed (§1b "All" rows); restart banner + quiet retries + version-change reconnect |
| **D. frontend-pages** | `implementer-light` (Haiku) | `pages/Allocations/`, `pages/Settings/`, `pages/Transactions/`, `pages/Diagnostics/LogsTab.tsx`, `pages/Projection/`, `pages/Holdings/`, `pages/Risk/` + their tests | exactly the §1b rows: drop the page gates, debounce text filters, Projection uses `useProjection` and keeps the chart mounted; G1/G2 feel tests per page |

*D depends on C only through the Wave 0 stubs.* If D hits a judgment call, it hands
it back; the orchestrator passes it to C rather than retrying on Haiku.

**Wave 2, orchestrator:** stat + targeted tests (`uv run pytest tests/services
tests/readmodels tests/api -q 2>&1 | tail -40`, `npm run typecheck && npm test`
in `frontend/`), regenerate the API contract, CHANGELOG + patch bump, PR → CI.
One `reviewer` over B's endpoint and `deploy.sh`.

**Owner steps after merge:**
- `tson`, then reinstall `deploy.sh` by hand, since it's root-owned (RUNBOOK gives the exact command).
- Rerun `bootstrap.sh` for zram.
- Optionally set `DEPLOY_MODE`.

Then the orchestrator reruns the §3 measurement (read-only). **Exit criteria:** Overview
build < 300 ms in-container, no 499s in a trading day, banner seen on one deploy.

### 8.3 Phase 2: snapshot, rich tick, dual currency (minor)

> **Changed when building (2026-11-03): cheaper design.** Turning every money field
> into a `Dual {EUR, USD}` pair would touch ~2,300 lines of response schemas and every
> component that reads them. Instead:
> - Each read gets a sibling `GET …/both` route that returns
>   `ByCurrency[<existing response>]`: two complete responses, built in one session.
>   The ledger memo makes the second cheap, and existing shapes stay unchanged.
> - The frontend fetches `/both` once with a currency-free key and picks a side with
>   TanStack `select`, so a currency switch makes zero requests (R3).
> - `/api/snapshot` is dropped. Instead, the `/both` routes answer `If-None-Match` with
>   `304` from the read-cache generations (a reload re-validates without recomputing).
> - The projection POST stays per currency (its typed inputs are in one currency);
>   `keepPreviousData` keeps its chart up.
> - Workers: A (backend `/both` + ETag) and B (rich tick + `/api/live`) run in parallel.
>   C (frontend) follows once the contract is regenerated.
>
> The original plan text below is kept for the record.

**Wave 0, orchestrator contracts:**
- pydantic `Dual` money type (`{EUR, USD}`, `DecStr | None`) in `api/schemas/common.py`.
- Final shapes of the Overview/Holdings/Graph/Periods/Allocations/Projection responses with
  `Dual` fields.
- `SnapshotResponse` and `LiveState` schemas; the §4.4 tick schema.
- **Stub routes** `GET /api/snapshot` and `GET /api/live` returning 501.
- Regenerate `api-types.ts`, so the frontend worker can start at the same time.

**Wave 1, three parallel workers (reuse the Phase 1 workers if warm, §8.1):**

| Task | Worker | Owns | Covers |
|---|---|---|---|
| **A. backend-read** | `implementer` | `readmodels/*` (overview, holdings, live_graphs, periods, allocations, projection, snapshot), `api/{overview,holdings,graphs,periods,allocations,calculator,snapshot}.py`, `services/read_cache.py`, `api/app.py` | `pick(…, ccy)` → build both; drop `ccy`; ledger snapshot cached per `ledger_rev` across requests; `ledger_rev` bumped by the write middleware + EOD + import; `/api/snapshot` with ETag/304; registers B's `/api/live` router |
| **B. backend-live/ops** | `implementer` | `services/scheduler.py`, new `services/live_state.py`, `api/stream.py`, new `api/live.py`, `services/live_bus.py` | Tier C computed once per tick after the pull; `live_state` with `seq`; tick carries prices/fx/totals/point (§4.4); `/api/live?since=` with missed points |
| **C. frontend-data** | `implementer` | `lib/queries/*`, `lib/live.ts`, `lib/prefetch.ts`, `lib/prefs.tsx`, `components/Money/`, `components/CurrencyBox/` | currency becomes a client-side pick (R3); `ccy` dropped from keys; snapshot load path; tick → `setQueryData` for rows/totals/FX box |

*Ownership note:* `live_bus.py` moves from A (Phase 1) to B here; there's no overlap
within the wave. **Golden test:** the dual payload's EUR half equals today's `?ccy=EUR`
output. **Parity run** with `tools/parity_check.py` on a ledger copy (money maths rule).

**Wave 2:** orchestrator checks, contract regen, minor bump, PR. **Exit:** R3 (zero
requests on a currency switch), a tick < 5 KB with zero follow-up requests.

### 8.4 Phase 3: client patches, append graphs, optimistic writes (patch)

| Task | Worker | Owns | Covers |
|---|---|---|---|
| **C. frontend-data** | `implementer` | new `lib/livePatch.ts` (+ golden test against a recorded snapshot + tick), `lib/queries/*`, `lib/live.ts`, `App.tsx` | linear patching (G7); today's point appended on every cached range (R1); `/api/live` catch-up on tab return (R5); optimistic `onMutate`/rollback for every write (G3); `lazy()` routes + idle preload |
| **D. frontend-pages** | `implementer` (Sonnet this time: judgment) | `pages/Transactions/`, `pages/Activity/`, `pages/Allocations/Builder*` | client-side filter/sort/page over the full ledger (G2); seed edit from the list row; builder result kept visible |
| **A. backend-read** | `implementer-light` (or the warm Phase 2 A) | `api/transactions.py`, `api/deposits.py` | an "all rows" mode for the client-side lists (small) |

**Wave 2:** checks, patch bump, PR. **Exit:** the §1c real-device check of R1–R5 + G1–G8
on the phone over mobile data during market hours, plus the AGENTS.md rule change (§4.6),
done by the orchestrator.

### 8.5 Rough cost shape

Per phase: 1 short Opus contract wave, 3–4 Sonnet/Haiku workers each reading roughly
10–25 files once, 1 Opus check wave. The biggest saving is that Phase 2/3 workers reuse
the warm Phase 1 workers' file knowledge, **but only if the phases run back to back**
(within the cache TTL). If days pass in between, start fresh workers with pointer
briefs: that's cheaper than reviving cold, large contexts.
