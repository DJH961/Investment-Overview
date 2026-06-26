# Robust Multi-Provider Session-Close Completeness

**Status:** plan, ready to implement.
**Anchored to:** `origin/main` at **v4.9.3** (commit `bcb856a`). All file/line anchors
below are `git show origin/main:web/src/<file>`. Symbols and line numbers drift —
**re-grep the named functions before editing**; trust the names, not the integers.
**Scope of the bug:** PRE-EXISTING and INDEPENDENT of PR163. The charting modules
named here (`intraday.ts`, `live-graph.ts`, `session-fx.ts`, `week.ts`,
`timeseries-store.ts`) were **not touched** by PR163 — verified: `git diff
origin/main origin/copilot/feature-implement-single-brain-pull-plan -- web/src/<file>`
is empty for each, and main's copies are byte-identical to the pre-PR163 build.
Do not blame or revert PR163; this is latent charting-layer behaviour that only
surfaces after a force-all reset re-primes the graphs from scratch.

---

## Abstract (plain language — read this first)

When the US market is **closed**, each holding's intraday (1D) graph wants the
symbol's **closing price**. Today the app decides it "has the close" only if the
symbol's newest stored price bar lands within **one bar-interval (one hour)** of
the 4:00 PM ET bell. That assumption holds for a busy stock that trades right into
the bell. It is **wrong for a thinly-traded symbol** (our live example: the US-listed
*Global X DAX* ETF, ticker `DAX`), whose last real trade of the day can be an hour
or more before the close. For such a symbol "the closing price" simply *is* its last
trade — there is nothing later to fetch — but the app keeps judging it "incomplete,"
re-fetches it on **every single screen redraw**, and never stops. In the log this
showed up as `DAX` plus its currency track being pulled roughly **twice a second**,
burning credits in a tight loop that the normal back-off never caught (the back-off
only trips on *empty* answers, and `DAX` always answered with a bar).

The fix changes the question from **"is the newest bar near the clock?"** to
**"have we actually got the best close anyone can give us?"** Concretely:

1. **Remember progress, per symbol, per day.** Once we've fetched a symbol after the
   close, store its newest-bar time and a "settled" flag that survives restarts.
2. **Decide by progress, not the clock.** If a re-fetch brings a *later* bar, that's
   real progress (this rescues the "I was online, then logged off right at the bell"
   case). If it brings the *same* last bar, there is nothing newer right now.
3. **Confirm "nothing newer" across providers.** You have more than one data source.
   When the primary stops advancing, ask the **second** provider **once**. If it has a
   later bar, take it. If it agrees on the same last bar, two independent sources say
   *this is the real close* — mark the symbol **settled** and never re-fetch it today.
4. **Treat a true outage as an outage.** If *both* providers come back empty/erroring,
   that's provider trouble, not an illiquid close — fall into a **bounded, spaced,
   provider-rotating** retry (a handful of attempts at growing gaps), never a
   per-redraw hammer.

The result: a busy symbol with a closing bar = **0** extra fetches; a quiet or
weak-on-primary symbol = about **two** credits once, then settled and remembered;
a provider outage = a few spaced retries then parked. The same flaw exists on the
weekly (1W) graph and is fixed by the same rule. The exact, code-level changes follow.

---

## 1. Root cause (exact, code-anchored)

### 1.1 The 1D loop (the logged DAX burn)
`loadOrBuildSessionCurve` (`intraday.ts:408`) recomputes, **every build**, which
symbols are "missing":

- `incompleteAfterClose(symbol)` (`intraday.ts:431-436`): once the market is closed,
  returns `true` whenever the symbol's newest stored bar fails
  `sessionBarsComplete(bars, closeMs, INTRADAY_BAR_INTERVAL_MS)`.
- `sessionBarsComplete` (`session-fx.ts:219-224`) → `sessionTrackReachedClose`
  (`session-fx.ts:173-178`) tests "does any bar land at/after `closeMs − toleranceMs`?"
  with `toleranceMs = INTRADAY_BAR_INTERVAL_MS`.
- `INTRADAY_BAR_INTERVAL_MS = 60 * 60 * 1000` (**1 hour**) (`market-hours.ts:501`).
  The 1D bars are **hourly**. So a symbol is "complete" only if it has a bar at/after
  **15:00 ET**. An illiquid symbol whose last hourly print is 14:00 (or whose provider
  stamps the final partial bar before 15:00) can **never** satisfy this.
- `missing = symbols.filter(s => no bars || incompleteAfterClose(s))` (`intraday.ts:437`).
- Closed-market `needFetch` is driven purely by `missing.length > 0`
  (`intraday.ts:448-451`); `fetchSymbols = missing` (`intraday.ts:457`); `fetchBars`
  fires (`intraday.ts:458`) and `mergeSession` bumps `updatedAt` (`intraday.ts:483`).

So `DAX` is re-flagged missing → re-fetched → stored → still incomplete → missing …
on **every render**. The two structures that should have stopped it do not:

- **Cross-provider spill is emptiness-only.** `makeCapacitySplitBarFetcher`
  (`live-graph.ts:360-394`) only escalates a symbol to Tiingo when Twelve Data returns
  it **empty/failed** — `a.missing = symbols.filter(s => !(bars.get(s)?.length))`
  (`fetchBarLeg`, `live-graph.ts:332`) and the spill set is `a.missing` filtered to
  still-empty (`live-graph.ts:385`). `DAX` comes back **non-empty** (a stale-but-present
  bar), so the second provider is **never consulted** about whether a later bar exists.
- **Per-symbol back-off scores emptiness, not completeness.** `withBarBackoff`
  (`live-graph.ts:553-577`) calls `backoff.succeed` on any **non-empty** result
  (`live-graph.ts:568`) and `backoff.fail` only on empty/throw (`:569,573`). `DAX`'s
  non-empty bar clears the memo every time, so `cacheSeriesBackoff` (`live-graph.ts:477`)
  never arms a cooldown. No suppression → infinite loop.

### 1.2 The FX co-loop
While `needFetch` is true the session FX track is re-pulled too (`intraday.ts:472-482`),
and FX rides the **same** back-off shape (`withFxBackoff`, `live-graph.ts:519-541`,
non-empty ⇒ `succeed`). So each looping render spends **2** credits (the symbol's 1D
bar + the EUR/USD track), matching the log's ~2/sec. Fixing the price-side loop
(below) collapses `needFetch`, which stops the FX re-pull as a side effect; no separate
FX change is required beyond the parity note in C3.

### 1.3 Why only after a force-all reset
Normal login reuses already-complete stored sessions and never enters the after-close
partial path. The manual force-all reset wipes the store and re-primes from scratch,
so every symbol transits the "non-empty but short of the close" state at once —
exposing the latent loop for any illiquid member.

### 1.4 The 1W path has the identical latent loop
`weekStaleSymbols` (`week.ts:158-166`) marks a symbol stale when **no** stored daily
bar lands at/after the coverage cutoff; `loadOrBuildWeekCurve` (`week.ts:307`) refetches
whenever `coversThrough(stored.bars, fetchSymbols, dayStartMs(settledEnd))` is false
(`week.ts:334-337`). A symbol whose latest *settled daily close* no provider has
published yet (illiquid, or just slow right after the bell) never "covers through" →
`fresh=false` → refetch **every build**, through the same capacity split and the same
emptiness-only back-off. Same disease, daily granularity.

### 1.5 Adjacent (do NOT conflate with the loop)
Log line 122 "primed 0 quote(s)" for `DAX`/`SCHK` indicates the bar tip failed to
denominate into a quote — consistent with a null/odd `nativeCurrency` (C2's collapse
when holdings on one ticker disagree). Real, but a **separate** quote-priming concern;
it is **not** the loop driver and must not be "fixed" by changing completeness logic.
Track it as its own ticket.

---

## 2. Design principles (what every change must preserve)

- **P1 — Progress, not the clock.** "Complete" means *we have the best close available*,
  proven by either (a) a bar at/after the bell, or (b) two providers agreeing no later
  bar exists. Proximity-to-4:00 is necessary only for liquid symbols and must stop being
  the sole gate.
- **P2 — Cross-provider confirmation is the tie-breaker.** "Nothing newer" is only
  trusted after the *second* provider confirms it. Exactly **one** escalation per short
  symbol per day in the steady state.
- **P3 — Settle is terminal and persisted.** A settled symbol is excluded from the
  missing set for the rest of the trading day and across app restarts. The per-day key
  (`day = lastSessionDate(now)`) naturally resets it next session.
- **P4 — Outage ≠ illiquidity.** Both-providers-empty is provider trouble → bounded,
  spaced, provider-rotating retries (reuse `SeriesBackoff`), never per-render.
- **P5 — Compare on session-relative time WITH tolerance.** Providers stamp the final
  bar differently (e.g. 14:00:00 vs 14:00:30, or a trailing partial bar). "Advance" and
  "agreement" must be judged with `tol = INTRADAY_BAR_INTERVAL_MS` (1D) / one trading
  day (1W), not raw-epoch equality, or noise reads as false progress and re-loops.
- **P6 — Stay inside the existing budget authority.** Every fetch, including the
  escalation, goes through the single `Reservation` (`makeCapacitySplitBarFetcher`,
  `live-graph.ts:360`) and its caps/429 freeze. No new uncapped network path.

---

## 3. Changes

Each item: **Goal · Anchor · Change · Failure modes · Tests.**

### C1 — Persist a per-symbol, per-day close-completeness record
**Goal:** give the decision layer a memory of progress + a terminal `settled` flag that
survives restarts (P3).
**Anchor:** `timeseries-store.ts` — `StoredSession` (`:51`), `SerializedSession` (`:75`),
serialize (`~:142`), deserialize (`~:156`), `mergeSession` (`:309-323`).
**Change:**
- Add to `StoredSession` (and `SerializedSession`, with a `StoredCloseProbe` plain shape):
  ```ts
  closeProbe?: Record<string, {
    lastBarAt: number;     // session-relative ms of the newest bar we have seen
    attempts: number;      // post-close fetch attempts this day
    sources: 0 | 1 | 2;    // distinct providers that returned this same tip
    settled: boolean;      // terminal: best-available close accepted
    lastAttemptAt: number; // wall-clock of the last probe (spacing gate, C4)
  }>
  ```
- `mergeSession` must **merge `closeProbe` per symbol** (do not drop it when a merge
  carries only `{ bars }`/`{ fx }`). New record wins field-by-field; once `settled` is
  `true` it stays `true` for the day. Preserve existing `closeProbe` on tip/FX-only
  merges exactly as `tips`/`fx` are preserved today (`:323`, `appendTip` `:364-368`).
- serialize/deserialize round-trip `closeProbe`; absent in old payloads ⇒ `undefined`
  (treated as "no probe yet"). `prune` (`:387`) unchanged (whole-day records drop together).
**Failure modes:** schema back-compat — guard `typeof`/shape on deserialize like
`updatedAt` (`:165`); never throw on a legacy session lacking the field.
**Tests:** `timeseries-store.test.ts` — round-trip a session with `closeProbe`; a
`{bars}`-only `mergeSession` preserves an existing `settled:true`; legacy payload
without the field deserializes to `closeProbe === undefined`.

### C2 — Honor `settled` in the missing-decision
**Goal:** a settled symbol leaves the missing set ⇒ zero further fetches (P3).
**Anchor:** `intraday.ts` `incompleteAfterClose` (`:431-436`) and `missing` (`:437`).
**Change:** inside `incompleteAfterClose`, after the existing `sessionBarsComplete`
check returns "not complete," consult the probe:
```ts
const probe = stored?.closeProbe?.[symbol];
if (probe?.settled) return false;   // we already have the best close for today
```
Keep the wholly-missing branch (`!bars?.length`) on the normal path — a symbol with no
bars at all is genuinely missing and must still be fetched fresh.
**Failure modes:** never let `settled` mask a symbol that *regressed* to zero stored
bars (a prune/clear) — the `!bars?.length` test at `:437` still forces a fresh fetch
regardless of the probe. `settled` only suppresses the *incomplete-but-present* case.
**Tests:** `intraday.test.ts` — closed market, present-but-short bars + `settled:true`
⇒ symbol absent from `missing`, `needFetch=false`; same with `settled:false` ⇒ present.

### C3 — The resolution algorithm (the heart): progress → escalate → settle
**Goal:** turn each after-close *incomplete-but-present* symbol into one of
{reached-close, progressed, settled-by-agreement, deferred-outage} using the second
provider as the tie-breaker (P1, P2, P4, P5).
**Anchor:** `intraday.ts` fetch block (`:454-483`); providers in `live-graph.ts`
(`makePriceBarFetcher` `~:230-313`, `makeCapacitySplitBarFetcher` `:360`,
`fetchBarLeg` `:325`). Tolerance `INTRADAY_BAR_INTERVAL_MS` (`market-hours.ts:501`).
**Change:** split the closed-market fetch set into two:
- **Wholly-missing** symbols (`!stored?.bars[s]?.length`) → existing path unchanged
  (`fetchBars(missing)` then merge), so a normal cold prime is untouched.
- **Incomplete-after-close** symbols → a new `resolveCloseCompleteness(...)` helper
  (new function in `intraday.ts`, or `live-graph.ts` if it needs the raw legs). For each
  such symbol, with `prevTip = probe?.lastBarAt ?? newest(stored.bars[s])`:
  1. **Primary leg** (Twelve Data on web / yfinance on desktop) for the batch. Compute
     `tipA = newest bar instant` after `clampBarsToDay`.
  2. `sessionBarsComplete` now true ⇒ **reached-close**: merge, clear the probe, done
     (this is the "logged-off-right-at-the-bell, came back later" rescue).
  3. Else if `tipA > prevTip + tol` ⇒ **progressed**: merge, set
     `{ lastBarAt: tipA, attempts+1, sources:1, settled:false }`. Not terminal — a later
     spaced probe (C4) may still reach the close.
  4. Else (no advance vs `prevTip` within `tol`) ⇒ **escalate once** to the **secondary**
     provider for this symbol only (a direct `fetchBarLeg(tiingo, [s])` under the same
     `Reservation`). Let `tipB` be its newest instant:
     - `tipB` reaches close ⇒ reached-close (merge, clear probe).
     - `tipB > tipA + tol` ⇒ progressed (merge B's bars, record `tipB`, `sources:1`).
     - `tipB` within `tol` of `tipA` ⇒ **settled-by-agreement**: two sources concur this
       is the last bar → `{ lastBarAt: tipA, sources:2, settled:true }`. This is the DAX
       resolution and the steady-state end state for any short symbol.
     - both empty/error ⇒ **deferred-outage**: do **not** settle; record the attempt and
       strike the back-off (C4).
- Merge results via `store.mergeSession(day, { bars, closeProbe }, now)`; `onFreshBars`
  (`intraday.ts:470`) still fires for any bars taken so the quote cache is fed.
**Failure modes:**
- **P5 tolerance** — compare `tipA/tipB/prevTip` on session-relative ms with
  `tol = INTRADAY_BAR_INTERVAL_MS`; never raw `===`. A trailing partial bar that only
  moves seconds must read as *no advance*, or step 3 false-progresses forever.
- **Escalation only for the short set** — never for liquid symbols (they hit step 2) and
  never for wholly-missing symbols (normal spill already covers them via `:385`). This
  keeps the second provider's scarce budget for exactly the symbols that need it.
- **Reservation** — both legs reserve through the existing authority; a `0` grant defers
  to a later round (curve holds the symbol flat at its quote, `intraday.ts:526` coverage),
  it does **not** bypass caps (P6).
- **FX parity** — once the short symbols settle, `needFetch` drops and the FX re-pull
  (`intraday.ts:472`) stops on its own. No separate FX completeness change; the secondary
  FX-refill branch (`:494-511`) is already one-shot (gated on `fx.length===0`).
**Tests:** `intraday.test.ts` / `live-graph.test.ts` fixtures, closed market, hourly bars:
- *illiquid*: primary returns same 14:00 tip twice; secondary returns 14:00 ⇒ symbol
  `settled:true, sources:2` after exactly 1 primary + 1 secondary credit; next build = 0.
- *logged-off-early*: stored tip 14:00, primary now returns 15:30 ⇒ reached-close, probe
  cleared, no escalation.
- *weak-on-primary*: primary 13:00, secondary 15:30 ⇒ progressed/closed from B, ≤2 credits.
- *outage*: both empty ⇒ not settled, back-off struck (see C4).
- *tolerance*: primary 14:00:00 then 14:00:40 ⇒ treated as no-advance (escalates), not progress.

### C4 — Bound and space the retries; stop the per-render hammer
**Goal:** even before a symbol settles, never probe more than once per interval; a true
outage gets a few spaced, provider-rotating attempts then parks (P4).
**Anchor:** `intraday.ts` decision (`:431-451`); `SeriesBackoff`/`cacheSeriesBackoff`
(`live-graph.ts:462-511`); `withBarBackoff` scorer (`:567-573`); back-off wiring
`scope: bars:${param}` (`app.ts:1739`, nav `:1844`).
**Change:**
- **Spacing gate:** in the missing-decision, treat an incomplete-but-present symbol as
  *not currently fetchable* when `now − probe.lastAttemptAt < PROBE_MIN_MS` (new constant,
  e.g. 10 min). So between probes the symbol is simply held flat — no fetch, no credit —
  rather than retried every redraw. This alone kills the per-second loop even for a symbol
  mid-resolution.
- **Outage scoring:** the resolution step (C3) must score the back-off **explicitly** —
  call `backoff.fail(key, now)` on a deferred-outage and `backoff.succeed(key)` only on
  reached-close/settled. Do **not** route the resolution legs through `withBarBackoff`'s
  auto-scorer, whose "non-empty ⇒ succeed" (`:568`) is exactly the rule that broke here.
  Leave the open-market / wholly-missing path on `withBarBackoff` unchanged.
- After `DEFAULT_SERIES_BACKOFF_ATTEMPTS` consecutive outages the existing cooldown arms
  (`:506`), giving the "faulty provider" case bounded retries that reset after the window
  (`:504`) — i.e. it will try again much later, not never.
**Failure modes:** don't let the spacing gate suppress a *wholly-missing* symbol (those
must fetch immediately); the gate applies only to the incomplete-but-present branch. Keep
`PROBE_MIN_MS` ≫ a render but ≪ a session so a genuinely-late close still resolves within
the evening.
**Tests:** repeated builds 1s apart with an unsettled short symbol ⇒ at most one fetch per
`PROBE_MIN_MS`; N outages ⇒ cooldown armed, then a later build retries.

### C5 — 1W parity
**Goal:** apply the same terminal-settle to the weekly graph so an illiquid/slow daily
close cannot loop (§1.4).
**Anchor:** `week.ts` `weekStaleSymbols` (`:158-166`), `loadOrBuildWeekCurve`
freshness (`:334-337`, `coversThrough`/`settledEnd` `:327`), nav backfill
(`navBackfillStaleSymbols` `:192-204`, fetch `:370-383`).
**Change:** mirror C1–C4 at daily granularity in the **week** store session:
- Persist a `weekCloseProbe` (same shape) keyed by symbol in the week store record.
- When `coversThrough(settledEnd)` is false for a market symbol, run the C3 resolution
  with `tol = one trading day` and the daily legs: progress = a strictly newer daily
  close; settle-by-agreement = two providers agree on the latest available daily close;
  outage = bounded back-off (scope `bars:<weekParam>`).
- Gate refetch by the same `lastAttemptAt` spacing.
- **nav backfill (lower priority):** a fund-NAV day that no provider can supply should be
  recorded as a settled hole (per `(symbol, sessionStart)`) rather than re-requested each
  build (`:201-204`). Mark optional; the market-symbol parity above is the must-fix.
**Failure modes:** the week's `fresh` short-circuits on `regenerateOnly` and empty sleeves
(`:335-336`) — keep those. Don't settle a symbol that is wholly missing from the window
(that is a real gap, not a short close).
**Tests:** `week.test.ts` — illiquid daily symbol short of `settledEnd`, both providers
agree ⇒ `settled`, no refetch next build; provider gains the daily close later ⇒ progressed.

### C6 — Disambiguate the loggers (so the next log is legible)
**Goal:** make the polling log say *why* a symbol was or wasn't fetched after close.
**Anchor:** the 1D fetch/merge block (`intraday.ts:454-483`) and the 1W equivalent.
**Change:** emit one line per resolved short symbol with its classification and the bar
instants, e.g. `1D close[DAX]: settled-by-agreement (TD 14:00 == Tiingo 14:00, sources=2)`,
`… progressed (14:00→15:30)`, `… reached-close`, `… deferred-outage (backoff armed,
strike 2/3)`. Pure logging — must not alter control flow or credits.
**Tests:** snapshot the four log strings for the four classifications.

### C7 — Token-cost guarantees & budget interplay (acceptance criteria)
Encode these as asserts/comments so a regression is caught:
- **Liquid w/ closing bar:** 0 post-close refetches (step 2; unchanged for these).
- **Illiquid / weak-on-primary:** ≤ 2 credits once (1 primary + 1 secondary), then
  `settled` + remembered ⇒ 0 thereafter, this session and across restart.
- **Outage:** ≤ `DEFAULT_SERIES_BACKOFF_ATTEMPTS` spaced attempts, then parked for the
  cooldown; no per-render spend at any point (spacing gate, C4).
- **Escalation budget:** the one secondary call per short symbol per day is a single
  `Reservation.reserve("tiingo", …)` within Tiingo's existing hourly/daily caps + reserve
  (P6) — it cannot overshoot the budget or bypass the 429 freeze.

---

## 4. Failure-mode matrix (the cases the user called out)

| Scenario | Old behaviour | New behaviour |
|---|---|---|
| Illiquid close (DAX) — last print well before bell | infinite per-render refetch, ~2 cr/s | 1 primary + 1 secondary, agree ⇒ **settled**, 0 after |
| Online then logged off right at the bell | stored partial; next session may re-pull whole tail | next post-close fetch **advances** to the real close (step 2/3), then settles |
| Faulty / flaky provider (empty or error) | non-empty noise cleared back-off, or empty hammered | **bounded** rotating retries (back-off), parks, retries later |
| Provider stamps final bar oddly (seconds off) | could read as progress and re-loop | **tolerance** (P5) treats it as no-advance ⇒ escalate/settle |
| App restart mid-evening | probe lost, re-loops from scratch | `closeProbe` **persisted** ⇒ stays settled |
| Next trading day | n/a | `day` key rolls ⇒ probe naturally resets, fresh resolution |
| 1W illiquid/slow daily close | same loop at daily cadence | C5 settle, same guarantees |
| DAX "primed 0 quotes" currency oddity | — | **out of scope here** (separate ticket); completeness logic untouched by it |

---

## 5. Test plan (summary)
- `timeseries-store.test.ts`: `closeProbe` round-trip, per-symbol merge preservation,
  legacy back-compat (C1).
- `intraday.test.ts`: missing-decision honors `settled` (C2); the four C3 classifications;
  P5 tolerance; C4 spacing + outage cooldown.
- `live-graph.test.ts`: resolution scores the back-off explicitly (fail on outage, succeed
  on settle); open-market/wholly-missing path unchanged.
- `week.test.ts`: C5 daily-granularity parity.
- Log snapshots for C6.
- Re-run the full suite; the existing green tests must stay green (no change to the
  open-market, wholly-missing, or capacity-split-emptiness paths).

---

## 6. Wrap-up (plain language)

The whole change is one idea applied consistently: **stop asking "is this bar near the
closing bell?" and start asking "have we got the best close anyone can give us?"** A busy
stock answers that question for free (it has a bar at the bell). A quiet stock answers it
the moment a second data source agrees nothing newer exists — and we **remember** that
answer so we never ask again that day, even after a restart. A broken data feed is treated
as broken (a few spaced retries), not as a reason to fetch forever. That single reframing
removes the credit-burning loop the log caught on `DAX`, handles the "I logged off at the
bell" and "the provider was flaky" cases the same way, and extends cleanly to the weekly
graph — all while staying inside the spending caps already in place.

**Implementation order:** C1 (storage) → C2 (decision honors settle) → C3 (resolution) →
C4 (bound/space) → C7 asserts → C5 (1W parity) → C6 (logging). Land C1–C4 + C7 first; they
fix the reported 1D burn. C5/C6 are the same pattern and a legibility pass.

**Reminder for the implementer:** re-grep every named function before editing — these line
numbers are a v4.9.3 snapshot and will drift. Cut the work off a fresh branch from
`origin/main`; do not edit a stale local tree.
