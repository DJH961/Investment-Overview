# Action Plan — Market-open token-burn fix (web companion)

**Context:** Root-causing the catastrophic provider-credit burn at the US market
open on **2026-06-24 ~15:30 CET** (app **v4.1.0**, observed on two devices). At the
open the app demanded a full intraday **and** full-week history for the entire
market sleeve in the first minute, blew both providers' rate limits, drained the
hourly Tiingo cap on **empty** calls, and rendered **nothing**. This plan fixes the
structural causes so a cold start (at the open or mid-session) degrades into a slow
**trickle** instead of a total burn.

**Working directory:** `C:\Users\t-dhenke\OneDrive - Microsoft\Documents\VS Code\Investment-Overview`
**Tests:** existing vitest suite under `web/test/*.test.ts` (live-graph, week,
intraday, tiingo, quotes, app). No new test frameworks. Verify baseline green
before & after.

---

## Diagnosis recap (what we proved this session)

A **five-link fault chain**, each link verified against the v4.1.0 source and the
two polling logs:

1. **Pulls bars at the open it cannot possibly need.** `prefetchGraphStaleness`
   (app.ts:745) treats *absence* of today's intraday bars as *stale*:
   `session = marketSymbols.filter((s) => !(today?.bars[s]?.length))`. At the open
   the session store is empty **by definition**, so all 12 symbols read "stale" and
   a full intraday backfill is queued for a window that has not elapsed. (Log 2,
   line 361: *"market open … Graph backfill via Tiingo: 1D bars ×12"*.)

2. **Demands three series per symbol instead of one.** 1D intraday + 1W daily +
   a live `/quote` are pulled as **independent** passes (~37 credits for 12 symbols
   at the open). The newest **daily** bar already *is* today's mark, and
   `primeQuotesFromBars` (cache.ts:163) exists precisely to fold it into the quote —
   but it **no-ops on empty bars** (cache.ts:169,174), so when the bar pull returns
   nothing the quote pass cannot be skipped.

3. **Routes bar pulls Tiingo-first.** `prefetchGraphBars` (app.ts:808) builds
   `makePriceBarFetcher` with **no `budget`** (app.ts:845), so it silently uses the
   **legacy** `makeDualPipeBarFetcher(pipeB=Tiingo, pipeA=TwelveData)` (live-graph.ts:289)
   — Tiingo leads, Twelve Data is only a failover. The scarce 40/hr resource is spent
   first; the plentiful 8/min one is demoted to backup.

4. **Sends Twelve Data oversized, all-or-nothing batches.** `fetchTimeSeries`
   (prices.ts:444) joins **all** symbols into one request and **throws on any
   non-200** (prices.ts:470) — no partial result. A 12-symbol batch costs 12 credits;
   12 > 8/min, so Twelve Data rejects the whole thing every time. **Probed live
   2026-06-24:** 1-symbol → `200`+bars; 7-symbol → `200`+bars (all 7); 12-symbol on a
   *fresh* minute → `429` *"12 API credits were used, with the current limit being 8."*

5. **No backoff on the bar path.** The price-bar fetcher in `prefetchGraphBars` is
   wired **without** the 3-strike `cacheSeriesBackoff` (only the FX leg gets one,
   app.ts:876). `primeStaleGraphPackages` runs this un-braked pull on **every**
   refresh round (app.ts:2973 — auto ~60s + every manual + every unlock), and since
   the pulls keep returning empty, the staleness check stays "all stale" forever — a
   self-perpetuating storm.

**Why the second provider could not save us:** once link 4 + the quote pass eat the
8/min, the capacity split that the *on-demand* build does use computes
`capacity = min(12, 0, day) = 0` (live-graph.ts:351–354) → Twelve Data is handed
**nothing**, and 100% of the book rolls onto Tiingo as "overflow", draining its
40/hr on empty calls.

**The control proof (Log 2, second device, Tiingo fully exhausted):** the **quote**
pass — which *is* sliced — fetched **7** symbols live and **deferred 10**
(*"7 live, 5 cached"*, line 380), so the app finally showed prices; while every
**bar** batch (12-wide) `429`'d wholesale (lines 363/364/371/376). Same key, same
minute, opposite outcome — decided entirely by **batch size**.

---

## The five pillars

1. **Demand minimisation** — pull only what is genuinely needed; derive the rest.
2. **Demand shaping** — slice every pull to the per-minute budget and defer the
   overflow across minutes; never fire a batch larger than a minute can serve.
3. **Correct routing** — one path: Twelve Data leads up to its live budget, Tiingo
   takes only genuine overflow.
4. **Two-tier braking** — per-symbol series backoff **and** a per-provider 429
   circuit breaker.
5. **Budget integrity** — reserve-on-request, settle-on-result; a 429 is
   authoritative; enforce at the fetch chokepoint so no path can bypass it.

Pillar 1 removes ~80% of the load; Pillars 2–5 ensure that any load which *does*
spike degrades into a trickle rather than a burn.

---

## Workstreams (priority order)

### 1. Expected-empty ≠ stale; derive quotes from daily bars  `[pillar-1]`
**Why first:** it deletes most of the demand, so the rest of the system never has
to absorb it.

**Changes:**
- **Intraday staleness gates on elapsed trading time, not presence.**
  `prefetchGraphStaleness` (app.ts:735) must treat a *fresh, post-open* session
  with little/no elapsed trading time as **expected-empty**, not stale. No 1D
  backfill is queued for an intraday window that has not happened yet; the 1D curve
  starts empty and accrues tick-by-tick.
- **At the open, pull only daily (1W) bars; derive the headline quotes from them.**
  The newest daily bar primes each symbol's quote (`primeQuotesFromBars`), so the
  separate market-quote pull is skipped for any symbol a bar covered.
- **Stop running the bar prime on every round when it cannot help.**
  `primeStaleGraphPackages` (app.ts:779, called app.ts:2973) must early-out when
  staleness is "expected-empty", so it does not re-queue the same doomed pull each
  ~60s tick.

**Acceptance:** at the open, a cold start issues **0** intraday-bar requests and at
most **12** daily-bar credits (sliced — see WS2), with quotes filled from those
bars. No "1D warm-up graph" lines appear before any trading time has elapsed.

### 2. Slice to the minute budget and defer the overflow  `[pillar-2]`
**Why:** a 12-credit all-or-nothing batch can never fit an 8-credit minute. Make the
bar path behave like the quote path (which already slices + defers, proven by Log 2
line 380).

**Changes:**
- **Chunk Twelve Data time-series requests to ≤ live per-minute capacity.** Either
  slice inside `fetchTimeSeries` (prices.ts:444) or upstream in the bar fetcher, so
  no single request exceeds `twelveDataBudgetRemaining().minute`. Remaining symbols
  are **deferred** to the next minute's round, not dropped and not Tiingo-dumped.
- **Carry the deferral through the scheduler** so successive bursts drain the
  backlog (mirror the quote pass's "deferred N / next auto-refresh in ~60s").

**Acceptance:** a 12-symbol daily demand on a fresh minute returns **8 then 4**
across two minutes (real bars both times), never a wholesale `429`.

### 3. One routing path — Twelve Data leads, Tiingo overflows  `[pillar-3]`
**Why:** the warm-up/prime path bypasses the capacity split entirely.

**Changes:**
- **Pass `budget` into every `makePriceBarFetcher`** used by `prefetchGraphBars`
  (app.ts:845) so it uses `makeCapacitySplitBarFetcher` (live-graph.ts:343), not the
  legacy `makeDualPipeBarFetcher`. Retire the Tiingo-first dual pipe from the
  prime/warm-up path.
- Tiingo is requested **only** for the symbols Twelve Data's live budget cannot
  cover this minute (true overflow), never as the lead.

**Acceptance:** with budget available, bar pulls log **Twelve Data (Pipe A)** first;
Tiingo (Pipe B) appears only for the overflow remainder.

### 4. Two-tier braking  `[pillar-4]`
**Tier 1 — per-symbol series backoff (extend existing).** Wire the persisted
3-strike `cacheSeriesBackoff` (live-graph.ts:452; store cache.ts:547) into the
**bar** fetcher in `prefetchGraphBars`, exactly as the FX leg already has it
(app.ts:876). A dead/empty series parks itself instead of being re-pulled every
round.

**Tier 2 — per-provider 429 circuit breaker (new).** A small shared module,
consulted at the fetch chokepoint (WS5):
- **Twelve Data 429 → freeze all Twelve Data for the rolling ~60s.** A **second
  consecutive** TD 429 (no successful TD call between) → escalate to a **2-minute**
  freeze, then **reset to normal** (next 429 starts the cycle fresh at 60s). The
  2-min cushion absorbs clock-skew / cross-device timing that lands just inside
  TD's minute. A success resets the streak.
- **Tiingo 429 → mark the hour's used credits to the cap (max).** Reuses the
  existing no-capacity guard (`selectWithinBudget`, tiingo-gate.ts:75) as the
  enforcement, and **auto-clears at the clock hour (:00)** like the normal counter —
  no separate timer. Rationale: Tiingo is the last line; once it says no, every
  further attempt is pure waste until the hourly reset.

**Acceptance:** after a TD 429 no TD request is issued for ≥60s; after two in a row,
≥2 min. After a Tiingo 429 the hourly bucket reads full and no Tiingo request fires
until the next `:00`.

### 5. Budget integrity — 429 is authoritative; enforce at the chokepoint  `[pillar-5]`
**Why:** our internal ledger is an optimistic *local* estimate, blind to the other
device's spend on the **shared API key**. The 429 is the only cross-device truth
signal.

**Changes:**
- **A 429 reconciles the local ledger *down*.** On a Twelve Data 429, treat the
  rolling minute as fully spent (0 left) regardless of internal count; prefer
  reading TD's `api-credits-left`/`api-credits-used` headers when present and trust
  them over our model. On a Tiingo 429, set the hour to max-used (WS4). The
  provider's hard "no" always overrides our soft estimate.
- **Reserve-on-request, settle-on-result** for the bar/FX path (bring it in line
  with the quote layer's two-phase model, quotes.ts) so a concurrent burst cannot
  overcommit on a stale pre-spend reading, and an un-billed result (429 / transport
  throw / Worker reject) is refunded.
- **Enforce the budget + breaker at the single network chokepoint**, not per-caller,
  so **every** entry path passes the same gate.

**The invariant (load-bearing):**
> Every request — **auto, prefetch, rapid-fire, manual, or after-reset** — always
> respects the hard provider limits. No path is ever exempt.

Concrete consequence: the hard-refresh / from-scratch paths today *clear* the
backoff (app.ts:2623, 2685, 2710 — *"a deliberate hard refresh overrides any armed
backoff"*). Those overrides must be **scoped to the soft Tier-1 series backoff and
freshness TTLs only** — they must **not** touch the budget or the Tier-2 429 breaker.
A manual reset may re-attempt a *parked symbol*; it may **not** punch through a
provider cap.

**Acceptance:** a manual hard reset issued while Twelve Data is in a 429 freeze (or
Tiingo's hour is exhausted) issues **no** request to that provider; it paints cache
and resumes only when the freeze/hour lifts.

---

## Provider facts (verified)

- **Twelve Data free tier:** 8 credits/minute, 800/day (quotes.ts:54). `time_series`
  is **all-or-nothing** per request, **1 credit/symbol**; a batch over the minute cap
  `429`s wholesale (probed live). `status:"error"`/`429` are **not** billed;
  `status:"ok"` (incl. empty `values`) **is** billed. Exposes
  `api-credits-used`/`api-credits-left` headers.
- **Tiingo (web):** hourly cap **40**, daily **800** (`WEB_HOURLY_CAP`/`WEB_DAILY_CAP`,
  tiingo-gate.ts), **resets on the clock hour (:00)**. Any forwarded response —
  including `200+[]` and `404` — **counts**; returns no credit headers (the Worker
  meters on forward).

## Non-goals / out of scope

- The Python desktop app (covered by `python_desktop_parity_plan.md`; yfinance has
  no rate limit so it pulls more aggressively, but the demand-minimisation and
  derive-quotes-from-bars principles still apply and will be mirrored separately).
- Changing provider *plans* or adding a third provider.
- The FX-history Worker route (already fixed; see `tiingo_polling_storm_cleanup_plan.md`).

## Verification

- Unit: extend `web/test/live-graph.test.ts` (slicing, capacity split with 0 budget,
  bar backoff), add breaker tests (TD 60s → 2-min escalation; Tiingo set-to-max +
  `:00` reset; 429 reconciles ledger down). `web/test/app.test.ts` for the
  expected-empty staleness gate and "no 1D at open".
- Manual: cold start at the next market open on a single device, then a second
  device against the same key, confirming a sliced trickle (8→4), zero empty-Tiingo
  burn, and graceful "showing cache" while frozen.
