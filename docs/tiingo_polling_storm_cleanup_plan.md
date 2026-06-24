# Action Plan — Tiingo polling-storm cleanup (web companion)

**Context:** Root-causing the Tiingo credit storm seen in the ~11:09 AM window on
2026-06-24 (app v4.0.x, `copilot/tiingo-unreachable-signal`). The acute bug — a
dead `fxHistory` Worker route causing infinite FX re-attempts — is already fixed
(user redeployed the Cloudflare Worker; both `fxHistory` cadences now return 200
with real EUR/USD OHLC). This plan addresses the **structural shortcomings** that
let that storm bleed credits invisibly, plus two earlier-noted items.

**Working directory:** `C:\Users\t-dhenke\OneDrive - Microsoft\Documents\VS Code\Investment-Overview`
**Tests:** existing vitest suite under `web/test/*.test.ts` (live-graph, tiingo,
worker, week, etc.). No new test frameworks. Verify baseline green before & after.

---

## Diagnosis recap (what we proved)

- **The storm = the FX leg, not bars.** One legitimate 12-bar batch (log 342),
  surrounded by **21 single FX re-attempts**. Bars are retry-gated by
  `coversThrough` (week.ts:79–84) and stop after the first batch; FX has **no
  equivalent guard** and re-fires on every rebuild.
- **The FX ratchet:** a 400/empty FX result returns `[]`, is **not merged**
  (week.ts:198 guard), so `loaded.fx.length === 0` stays true and the refill gate
  (week.ts:189) re-arms on every chart re-render / burst refresh.
- **Every "fetched 1 series" line is FX** — bars always log their batch count
  (`recordingBarFetcher` books once for the whole symbol set), so they can never
  appear as N×"1 series". This is *only* invisible because the log omits the
  symbol and the leg tag.
- **Budget booked on request, not result:** a swallowed empty FX pull still books
  a full Tiingo credit (`recordingFxFetcher` → `record(1)` unconditionally).
- **Fallback↔graph double-spend:** the quote pass falls back to Tiingo for market
  symbols *and* the graph re-pulls the same symbols as Tiingo bars ~2s later. The
  dedup that prevents this (`primeStaleGraphPackages`) only runs on
  `viaTiingo`/`primeGraphs` rounds, so plain force/auto refreshes double-buy.

---

## Workstreams (priority order)

### 1. Budget accounting — mirror the provider's meter, not "did we get data"  `[budget-on-empty]`
**Why first:** it is the only item still actively mis-charging credits (always
*pessimistically* — phantom-charging calls the provider never billed).

**Empirically verified 2026-06-24 (probed live through the Worker):**
- **Tiingo bogus quote** `/iex/?tickers=ZZZZNOTREAL` → **`200` + `[]`** (empty array,
  not an error). **Reached Tiingo → counts** against the hourly/daily request cap.
- **Tiingo bogus daily** `/tiingo/daily/.../prices` → **`404`** with Tiingo's own
  `{"detail":"…not found"}`. **Reached Tiingo → counts.**
- Tiingo returns **no** ratelimit/credit headers. The Worker reserves a slot
  **before** forwarding (`reserveTiingoSlot`, worker.js:223), so it meters exactly
  when it forwards — our client ledger must match that.
- **Twelve Data** errors are `{"code":…,"status":"error"}` (parsed at prices.ts:254/
  355/476). Documented billing: `status:"error"` and `429` **not** charged;
  `status:"ok"` (incl. empty `values`) **charged**. It returns
  `api-credits-used`/`api-credits-left` headers we do **not** currently read.

**Consequence:** "book on bars returned" would **under-count** a Tiingo `404`/empty-
`[]` that Tiingo really billed → optimistic drift → real-cap blowout. The correct
predicate is **"did the call reach the provider's meter," per provider:**

- **Tiingo** (`recordingBarFetcher`/`recordingFxFetcher`, live-graph.ts:86–108):
  book when the Worker **forwarded to Tiingo** — i.e. **any** response *except* the
  Worker-side rejects `400` (bad params), `429` (reserve spent, never forwarded),
  `502` (upstream fetch failed), `503` (no token). A `200+[]` and a `404` **both
  count**. (This is the opposite of today's "record on request" for FX, which over-
  books, *and* the opposite of naive "record on non-empty", which under-books.)
- **Twelve Data:** book on `status:"ok"` (incl. empty `values`); skip on
  `status:"error"` and `429`. **Prefer reading `api-credits-left`/`api-credits-used`**
  from the response and trusting the provider's own counter over our model.
- Thrown failures / transport aborts book nothing (already correct).

**Two-phase accounting — RESERVE on request, SETTLE on result.** Booking purely
on result has a concurrency hole: if 15 symbols fire together, each reads the *same*
pre-spend budget (question 1 hasn't returned yet) and they collectively overcommit
past the cap. So accounting is two-phase:
1. **Reserve up-front.** On dispatch, immediately debit the ledger by the
   worst-case cost (1 credit/symbol for Tiingo, the Twelve-Data per-call cost),
   so concurrent and subsequent calls see the budget *already committed* and pace
   themselves. (The quote layer already does this — quotes.ts:516–530 spends
   up-front "so whichever load reserves first wins the minute"; bring the graph/FX
   fetchers in line.)
2. **Settle on result.** When the call returns, reconcile the reservation against
   what the provider actually metered:
   - **Billed** (Tiingo any forwarded response incl. `200+[]`/`404`; Twelve Data
     `status:"ok"`) → **keep** the reservation (or true it up to the provider's
     `api-credits-used` header if present).
   - **Not billed** (Worker reject `400`/`429`/`502`/`503`; Twelve Data
     `status:"error"`/`429`; transport throw) → **refund** the reservation.
   Net effect: never over-fire a batch on a stale pre-spend reading, and never
   leave a phantom charge (the FX-storm failure mode) on the books.
- Implementation note: this needs an explicit `reserve()`/`settle(actual)` (or
  `release()`) pair on the credit ledger, and the fetchers must surface the HTTP
  status / `status` field / credit header — not just the parsed bars — so `settle`
  can decide billed-vs-refund. (Item 2's logging touches the same boundary.)

**Storm post-mortem (settles the original question):** the dead `fxHistory` route
threw in `buildTiingoUrl` → Worker `400` **before** forwarding → the 21 FX
re-attempts cost **zero real Tiingo budget**; they only phantom-charged the local
ledger. The storm was a self-throttling bug, not a real-spend bug — precisely why
the ledger must mirror the provider meter.

- Tests (`live-graph.test.ts`): Tiingo `200+[]` ⇒ **books** the credit; Tiingo
  `404` ⇒ **books**; Worker `400`/`429`/`502`/`503` ⇒ **books 0**; Twelve Data
  `status:"error"` ⇒ 0; `status:"ok"` empty ⇒ books; where a credit header is
  present, the booked count equals the header delta. **Two-phase:** N concurrent
  dispatches reserve N up-front (a later call in the same tick sees the budget
  committed and defers); a not-billed result **refunds** so the net settled equals
  only the billed calls.

### 2. Logging — what we pulled  `[log-what]`
- Graph poll line (`instrumentedGraphRecorders`, live-graph.ts:248–265): include
  the **symbol list** (or `FX eurusd`) and a **leg tag** `bars` / `fx` / `quote`,
  plus the provider already present.
- Make FX pulls log a distinct line from 1-symbol bar pulls (today identical).
- Tests: assert the new log shape in the recorder unit tests.

### 3. Logging — failures & empties  `[log-failures]`
- Stop swallowing FX failures silently (week.ts:171–177 and 196–203 empty
  catches): log every **non-2xx** and every **empty result** with status,
  provider, symbol(s), and whether a credit was booked.
- Generalise: **catch and log ANY graph/FX pull error** (per user request — not
  just the FX path) at the recorder/fetcher boundary, with enough detail to tell
  endpoint vs plan vs network apart.
- Tests: a 400 and a network throw each emit a labelled failure line.

### 4. FX fallback — Twelve Data forex  `[fx-fallback]`
- FX track is Tiingo-only (`makeWindowFxFetcher`, live-graph.ts:177–192). Add a
  **Twelve Data forex `time_series` fallback** mirroring the price dual-pipe
  (`makeDualPipeBarFetcher`). Twelve Data already quotes `EUR/USD`
  (`EUR_USD_SYMBOL`, prices.ts:278) via the same `fetchTimeSeries` Pipe A uses.
- Add a **negative-result memo / backoff** so a persistently failing FX endpoint
  does not re-arm the refill gate forever (defence-in-depth even with the Worker
  fixed): once an attempt returns empty, suppress re-attempts for the window/
  cooldown rather than retrying on every rebuild.
- Tests: Tiingo FX empty ⇒ Twelve Data consulted; both empty ⇒ flat `baseFx`,
  no re-charge, gate not re-armed.

### 5. Fallback↔graph dedup — ungate it AND fix its freshness test  `[refresh-dedup-gap]` `[staleness-mismatch]`
This is **two coupled bugs**. Fixing only the first leaves the dedup misfiring on
stale-but-present stores, so both are required.

**Audit result (what's actually true):**
- The graph sleeve is **market-only** — `buildIntradayAnchor` (intraday.ts:119–137)
  folds NAV funds into the flat `baseEur/baseUsd` base; `intradaySymbols`
  (intraday.ts:143) returns market symbols only. So the graph **never** pulls
  funds, and `primeStaleGraphPackages` priming market-only (app.ts:766–768)
  **fully covers** the graph's symbol set. No fund gap on the graph side.
- The duplication overlap is therefore the **market** symbols Twelve Data defers
  to the Tiingo quote fallback (SCHK, MSFT, IAUM, DAX, VOO, VWO in the 11:09
  window) — bought once as Tiingo quotes, once as Tiingo daily bars.

**5a — Ungate the dedup.** `primeStaleGraphPackages` (app.ts:763) runs only when
`opts.viaTiingo || opts.primeGraphs` (app.ts:2922). Run it on **any Tiingo-leaning
round** (any force/auto refresh that may fall back to Tiingo). It self-gates on
staleness, so a fully-loaded book still fetches nothing.

**5b — Align its freshness test with the build (the real "falsely believed 1W was
set").** `prefetchGraphStaleness` (app.ts:723–737) marks a symbol stale only when
**zero** bars are present (`!(weekStored?.bars[s]?.length)`). The build uses the
stricter `coversThrough(bars, symbols, settledEnd)` (week.ts:158, 79–84) — fresh
only if a bar **at/after the latest settled close** exists for every symbol.
**Presence ≠ coverage:** a stale-but-present store reads "fresh" to the dedup →
priming is skipped → the dashboard build then finds it stale and re-pulls, while
the quote pass already fell back to Tiingo. Make `prefetchGraphStaleness` use the
same `coversThrough(settledEnd)` coverage test. This checker is **shared by the
login warm-up** (app.ts:532), so the fix tightens both paths.

- Tests: (5a) a plain `force` round that needs Tiingo primes graph bars first;
  the subsequent quote pass + dashboard build spend **zero** extra Tiingo for the
  shared market symbols. (5b) a store holding only pre-settlement bars is reported
  **stale** by `prefetchGraphStaleness`, matching `coversThrough`.

### 6. Logging — resets, refreshes & version updates  `[log-coverage]`
- Log Settings-triggered **hard resets / hard refreshes** and **app
  version-update** events to the polling log, so a reader can see what version
  produced a window and when a reset wiped the store.

### 7. NAVs in the 1W curve  `[tiingo-funds]`
**Status quo:** both 1D and 1W fold NAV funds into a flat base (`buildIntradayAnchor`
intraday.ts:119–137); funds contribute a constant floor at their latest NAV and
the graph spends **zero** credits on them. For 1D that's correct (NAV strikes once
a day). For **1W it's wrong for this book** — ~half the portfolio is NAV, so the
week's NAV drift moves the total materially, yet the curve pins funds flat at
today's NAV. The week reconstruction's ratio maths (`valueᵢ·closeᵢ(day)/closeᵢ`,
week.ts:10) works identically for a fund if `closeᵢ(day)` = that day's NAV, so
adding funds to the **week** sleeve is mechanically clean.

**7a — Add NAVs to the 1W curve (PRIMARY).**
1. **Remember NAVs for free.** The quote layer already settles each fund's NAV
   *with its authentic date* (`fetchFundNav` daily `time_series`, prices.ts:311–320).
   On every refresh, write that dated NAV as a daily bar into the **week store**
   under the fund's symbol. Regular logins then accumulate one NAV/fund/day at
   **zero graph cost** — the NAV was already pulled for the headline total.
2. **Range-aware split.** Include `nav` holdings in the **week** sleeve (per-day
   NAV track) while keeping them in the flat base for **1D** (no intraday NAV).
   Today `intradaySymbols` is market-only (intraday.ts:120, 143); make the week
   path also surface fund symbols.
3. **Reuse, don't refetch.** The existing 1D→1W splice (week.ts:230–250) and the
   `coversThrough` incremental refill mean the steady state needs no dedicated NAV
   history pull. (Note: the splice loop is market-only today — extend it to fund
   symbols so they ride along for free too.)

**7b — Gap-fill backfill, only where it matters (SECONDARY).**
4. When the week store is **missing NAV days** (irregular logins), backfill a
   fund's daily-NAV history — but **only for funds that actually move**.
   Money-market / stable-value funds (VMFXX, SWVXX — ~$1.00 NAV) stay **flat and
   are never fetched** (the "special case" to get right). This is "only pull if it
   changes in price."
5. Route any such NAV backfill through the capacity split in **item 8** (Twelve
   Data daily NAV first, Tiingo for overflow) — the original off-Tiingo cost
   concern, now the rare path rather than the default.

### 8. Flexible provider split for graph time-series — Twelve Data first, Tiingo overflow  `[provider-split]`
**Decision (reverses the original Tiingo-primary graph design).** Today the graph
prefers **Tiingo** (`makeDualPipeBarFetcher(pipeB=Tiingo, pipeA=TwelveData)`,
live-graph.ts:159–167) — chosen so bulk history never competes with live quotes on
Twelve Data's 8-credit/min cap (intraday-tiingo.ts:127). That protection is no
longer needed because (a) **prefetch loads quotes before any graph renders**, (b)
the **unconditional dedup** (item 5) means graph bars often *are* the quotes, so
they don't double-draw, and (c) the **new gates** prevent re-fetch storms.

**Change:** make the graph fetch (price bars **and** NAV daily series) a
**capacity-aware split**, mirroring what the quote layer already does
(`affordableCount = Math.min(n, minute, day)`, quotes.ts:520):
- Read the **live remaining Twelve Data per-minute + per-day budget** (reuse the
  quote layer's `budget()` / `creditsSpentWithin`, quotes.ts:500–515) **after** the
  quote pass has reserved its share.
- Assign up to that many symbols to **Twelve Data (Pipe A)**; route the **overflow
  to Tiingo (Pipe B)** — concurrently, so the paint is still instant.
- Keep failover underneath the split: a symbol that *fails* on Twelve Data still
  spills to Tiingo.
- Rationale: Twelve Data's 8/min replenishes every minute (the plentiful pool);
  Tiingo's **40/hour** is the scarce one. Filling Twelve Data first and spilling
  only the overflow to Tiingo conserves the scarce budget while staying fast.

**Risks to handle:** quotes and graph now share the Twelve Data per-minute budget
directly, so the split must consult the **live shared credit log** (not a stale
snapshot) and run **quotes-first** (already true via prefetch) so the graph only
takes what quotes left. Applies to item 7's NAV series as well.
- Tests: with N symbols and M Twelve-Data credits left, exactly M go to Twelve
  Data and N−M to Tiingo; zero Twelve-Data budget ⇒ all Tiingo; a Twelve-Data
  failure on an assigned symbol re-routes it to Tiingo.

---

## Sequencing & dependencies

- **Phase A (accounting + visibility):** items **1 → 2 → 3** together — same code
  paths (`live-graph.ts` recorders + `week.ts` catches). Land first so every
  later change is measurable in the log.
- **Phase B (stop the bleeding structurally):** items **4** and **5** — the FX
  fallback/backoff and the dedup. Independent of each other.
- **Phase C (clarity & tidy-up):** items **6**, **7** and **8**. Item 8 (provider
  split) underpins item 7b's NAV backfill and shares the budget accounting from
  item 1, so land item 1 first; item 8 depends on the item-5 dedup being in place
  (so graph/quote don't double-draw the shared Twelve Data /min budget).

After each phase: run the full vitest suite, eyeball a fresh polling log to
confirm the new labels read cleanly, and compare credit counts against baseline.

## Out of scope / already done
- `week-restorm` / `why-21`: root-caused & resolved (Worker redeploy). The FX
  backoff in item 4 is the defence-in-depth follow-up.
