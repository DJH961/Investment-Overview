# Provider rate-limit audit — web companion

**Date:** 2026-06-24
**Scope:** `web/` live companion only.
**Mission:** Verify that **every** request — auto, rapid-fire, prefetch, manual,
post-reset, from Settings, no matter where it originates — both (a) **respects**
the provider's hard limits *before it fires* and (b) gets **counted** against
them. The hard limits are:

- **Twelve Data** — 8 credits per rolling 60 s, **and** 800/day. The minutely
  rule means once the per-minute budget is spent, nobody may request Twelve Data
  again until the rolling-60 s window frees up.
- **Tiingo** — 40/hour **and** 800/day.

This document is **findings only** — no code was changed. It records the audit
exactly as run, plus original observations and recommendations.

---

## How the audit was run

Every low-level provider function was located and **all** of its callers traced,
to check each one for two things: a **gate** (the call is skipped/deferred when
the budget is exhausted) and a **count** (the spend is booked against the right
ledger, ideally *before* dispatch so concurrent calls pace themselves).

Provider entry points audited:

| Function | Provider | File |
|---|---|---|
| `fetchQuotes` | Twelve Data (market quote) | `web/src/prices.ts:226` |
| `fetchNavQuotes` | Twelve Data (NAV daily) | `web/src/prices.ts:324` |
| `fetchEurUsd` | Twelve Data (EUR/USD quote) | `web/src/prices.ts:298` |
| `fetchTimeSeries` | Twelve Data (bars / FX series) | `web/src/prices.ts:444` |
| `fetchFxRates` | Frankfurter (free, non-metered) | `web/src/prices.ts:496` |
| `fetchTiingoQuotes` | Tiingo (quote fallback) | `web/src/tiingo.ts:96` |
| `fetchTiingoEurUsd` | Tiingo (FX spot fallback) | `web/src/tiingo.ts:189` |
| `fetchTiingoFxBars` | Tiingo (FX history) | `web/src/tiingo.ts:298` |
| `fetchTiingoIntradayBars` | Tiingo (bar history) | `web/src/intraday-tiingo.ts:137` |

Budget primitives: `web/src/cache.ts` (`readCreditLog`/`recordCredits`/
`creditsSpentWithin`/`creditsSpentToday`; `readTiingoCreditLog`/
`recordTiingoCredits`/`tiingoCreditsSpentToday`), `web/src/tiingo-gate.ts`
(`Budget`, `selectWithinBudget`, `WEB_HOURLY_CAP=40`, `WEB_DAILY_CAP=800`),
`web/src/quotes.ts` (`twelveDataBudgetRemaining`, `FREE_TIER`).

---

## ✅ Paths that correctly gate AND count

These reserve credits **up-front** (so the rolling-60 s / hourly window genuinely
blocks the next request) and skip/defer when exhausted. They satisfy the mission.

| Path | Gate (won't fire when exhausted) | Count |
|---|---|---|
| **Quote market/NAV** — `loadQuotes` | `reservation.reserve("twelvedata", stale.length)` grants only the affordable slice | reservation authority debits the grant up-front (`reservation.ts`) |
| **Live EUR/USD (Twelve Data)** — `loadEurUsd` | `reservation.reserve("twelvedata", 1) >= 1` | reservation authority debits the grant up-front (`reservation.ts`) |
| **Tiingo EUR/USD quote fallback** — `loadEurUsd` | `reservation.reserve("tiingo", 1) > 0` (folds in the 429 freeze + hourly/daily caps) | reservation authority debits the grant up-front (`reservation.ts`) |
| **Tiingo market/NAV quote fallback** — `tiingo-fallback.ts` | `selectWithinBudget(...budgetNow())` selects the batch; `reservation.reserve("tiingo", batch.length)` debits it | reservation authority debits the grant up-front (`reservation.ts`) |
| **FX rates** — `loadFxRates` → `fetchFxRates` | n/a — Frankfurter, free, not a metered provider | n/a |

> **Recommendation 4 now covers every call site.** The quote (`loadQuotes`), live
> FX (`loadEurUsd`, both the Twelve Data and Tiingo legs) and Tiingo quote
> fallback (`tiingo-fallback.ts`) paths no longer read-then-`recordCredits`
> themselves; they book through the single {@link reservation.ts} authority, the
> same one the graph/NAV legs already use. There is no remaining client path that
> debits a provider ledger outside the authority (the only direct `recordCredits`
> calls left are the dev-only `devkit/` harness and `live-graph.ts`'s explicit
> no-reservation legacy meters, used only when a caller omits the authority).


---

## 🚩 Flags — paths that COUNT but do NOT respect the hard limit

The graph (1D/1W) layer **meters** every spend (`recordingBarFetcher` /
`recordingFxFetcher` reserve up-front via the two-phase `BackfillMeter`, so the
spend *is counted*). **But it only ever consults the Twelve Data budget, and even
that incompletely. No graph path checks the Tiingo hourly/daily budget at all.**
"Counted" is not the same as "limited": booking a credit makes the spend visible
but does not stop the call.

### FLAG 1 — Tiingo bar overflow in the capacity split is uncapped
`makeCapacitySplitBarFetcher` (`web/src/live-graph.ts:343-368`) computes
`capacity = min(uniq, minute, day)` from the **Twelve Data** budget only, then
sends `toTiingo = uniq.slice(capacity)` — *all* the overflow — to Tiingo with **no
Tiingo-budget check**. The `spill` leg (`:362-365`) re-routes Twelve Data misses
to Tiingo, also uncapped. `WEB_HOURLY_CAP`/`WEB_DAILY_CAP` and
`selectWithinBudget`/`Budget.hasRoom()` exist but are never called on this path.

### FLAG 2 — Tiingo FX-history pulls are uncapped
`makeWindowFxFetcher` (`web/src/live-graph.ts:580-620`) and its
`makeTiingoFxBarFetcher` primary receive a `tiingoMeter` (counts) but **no
budget**. Every 1D/1W rebuild that finds FX stale fires a Tiingo FX call with no
hourly/daily gate.

### FLAG 3 — Twelve Data FX fallback ignores the minute/day budget
`makeTwelveDataFxFetcher` (`web/src/live-graph.ts:394-404`) fires
`fetchTimeSeries([EUR/USD])` whenever the Tiingo FX leg returns empty. It is
metered, but there is **no `minute >= 1 && day >= 1` check** before it fires —
unlike the otherwise-identical `loadEurUsd` path. It can therefore request Twelve
Data **inside the 60-second lockout**, violating the minutely rule directly.

### FLAG 4 — Prefetch / warm-up & the dedup prime use the legacy Tiingo-first pipe with NO budget at all
`prefetchGraphBars` (`web/src/app.ts:845-854`) calls `makePriceBarFetcher`
**without `budget`**, so it falls to `makeDualPipeBarFetcher`
(`web/src/intraday-tiingo.ts:249-269`), which fires **Tiingo for the entire symbol
set** unconditionally (counts, never gates). This path runs on:

- **login warm-up** (`app.ts:590`), and
- **`primeStaleGraphPackages`**, which the polling-storm cleanup deliberately made
  run on **every** network refresh (`app.ts:2973`).

So the **most frequently hit** graph path is the **least gated**. Its FX leg
(`app.ts:873`) is likewise ungated.

### FLAG 5 — 1W NAV gap-fill inherits FLAG 1
`wrapDailyNavFetcher(fetchDailyBars)` (`web/src/live-graph.ts:855`) routes the 1W
moving-fund NAV backfill through the same capacity split → same uncapped Tiingo
overflow.

### FLAG 6 — Non-atomic budget reads → collective per-minute overshoot
Even the gated capacity split reads `twelveDataBudgetRemaining(Date.now())` and
*then* dispatches, with no lock. Within a single build the **bars leg, the FX leg,
and (1W) the NAV leg** each read the same live budget independently; and a graph
build can overlap a scheduled quote refresh. Because each leg only reserves inside
its own meter *after* the budget read, several legs can each see the full `minute`
budget and collectively exceed 8/min. The "nobody can request Twelve Data again
within 60 s" rule is only enforced *within* `loadQuotes`/`loadEurUsd`, not across
the graph legs or across overlapping builds.

---

## Server-side backstop (partial, not a substitute)

Tiingo traffic flows through the Cloudflare Worker, which enforces a **best-effort
hourly** reserve (`reserveTiingoSlot`, `web/proxy/worker.js:158-224`, answering
`429` + `Retry-After`). Limitations:

- It is **per-isolate** ("Cloudflare may run many isolates", `worker.js:104`), so
  the true ceiling can exceed 40/hr across isolates.
- It is **hourly only — there is no daily (800/day) cap** in the Worker.
- **Twelve Data is browser-direct** (no Worker in the path), so it has **no
  server-side protection whatsoever** — the client-side budget is the only guard.

So the server backstop softens Flags 1–5 for Tiingo's *hourly* limit but does not
cover Tiingo's daily limit or any Twelve Data limit.

---

## Own observations

1. **"Counted" has been conflated with "limited."** Every graph leg meters its
   spend, which makes usage *visible* and *pessimistically booked*, but a booked
   credit does not stop the call. The one budget with **zero** client-side
   enforcement on the graph path — Tiingo 40/hr · 800/day — is also the **scarce**
   one. The design protected the plentiful pool (Twelve Data 8/min replenishes
   each minute) and left the scarce pool ungated.
2. **The gating is per-call-site, not central.** Each entry point re-implements
   its own budget check (and four of them omit it). There is no single choke point
   every provider request must pass through, so any new call site silently starts
   ungated — which is exactly how Flags 1–5 arose.
3. **No global circuit breaker.** There is no "stop all calls to provider X for
   the rest of this window once over cap" gate keyed off the two credit logs. Such
   a breaker would bound worst-case spend even when an individual leg forgets to
   gate.
4. **Reserve-then-read races exist even on gated paths (Flag 6).** Up-front
   reservation fixes the *sequential* double-spend inside one function, but
   independent legs/builds that read the budget concurrently can still collectively
   overshoot, because the read and the reservation are not atomic across callers.

---

## Recommendations

Priority order; smallest blast radius first.

1. **Gate the scarce budget on the graph path (Flags 1, 2, 5).** Thread a Tiingo
   `budget()` (live `Budget` from `readTiingoCreditLog` + `WEB_HOURLY_CAP`/
   `WEB_DAILY_CAP`) into `makeCapacitySplitBarFetcher`, the FX fetchers, and the
   NAV gap-fill, and apply `selectWithinBudget` to the Tiingo overflow/spill. Over-
   budget symbols should degrade to their flat quote value (the graph already
   tolerates missing bars) rather than firing.
2. **Gate the Twelve Data FX fallback (Flag 3).** Add the same
   `minute >= 1 && day >= 1` check `loadEurUsd` uses before
   `makeTwelveDataFxFetcher` fires.
3. **Gate the legacy prefetch/prime pipe (Flag 4).** Either pass a `budget` into
   `prefetchGraphBars`' `makePriceBarFetcher` so it uses the capacity split, or
   wrap the legacy dual pipe in a Tiingo-budget gate. This is the highest-value fix
   because that path runs on every refresh.
4. **Introduce a single reservation authority (Flags 6 + observations 2–3).**
   Route **all** provider requests — quotes, FX, graph bars, NAV — through one
   `reserve(provider, n)` that atomically reads-and-debits the shared ledger and
   returns how many credits were granted. Callers fetch only the granted count.
   This makes "respect the limit" structural rather than per-call-site, and closes
   the cross-leg/cross-build race.
5. **Add a daily Tiingo cap to the Worker.** Mirror `reserveTiingoSlot` with an
   800/day reserve so the server enforces both Tiingo limits, not just the hourly
   one — defence in depth even if a client path regresses.
6. **Add a global circuit breaker.** A single guard keyed off both credit logs
   that short-circuits all calls to a provider once over cap for the current
   window, independent of the per-leg math — a backstop for any future ungated
   path.

### Suggested test coverage for the fixes
- A graph build whose symbol set exceeds the Tiingo budget fetches only up to the
  budget; the remainder stays flat (no extra Tiingo spend).
- The Twelve Data FX fallback does **not** fire when the per-minute budget is 0.
- A login warm-up + immediate scheduled refresh do not collectively exceed 8
  Twelve Data credits in the same minute, nor 40 Tiingo/hr.
