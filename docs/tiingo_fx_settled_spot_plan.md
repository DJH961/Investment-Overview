# Plan — stop Tiingo's out‑of‑session FX bar from masquerading as a live EUR/USD spot

> Status: **implemented in v4.16.1; step 0 extended to both providers in
> v4.16.2.** Steps 0–6 + 8 are in `web/src/cache.ts`
> (`primeEurUsdFromFxBars` close-clamp + settled `observedAt` + self-heal),
> `web/src/quotes.ts` (`loadEurUsd` threads `observedAt` and a forced weekend
> re-pull), `web/src/app.ts` (display reads `observedAt`, TTL keeps `at`), and —
> for step 0's request-window narrowing — `web/src/prices.ts` (`fetchTimeSeries`
> now honours `start_date`/`end_date`) and `web/src/live-graph.ts`
> (`makeTwelveDataBarFetcher` threads the same settled-session window the Tiingo
> pipe already used). **Step 7 (the indicative-bar sanity band) was deliberately
> dropped** — a thin-liquidity FX print mistimed to *before* the close instant is
> vanishingly unlikely, so the close-clamp alone is the guard. This document
> captures the agreed approach plus the answer to the "can we amend the API call to
> ask the specific range that makes sense?" question.

## The bug (verified)

`primeEurUsdFromFxBars` (`web/src/cache.ts:318`) folds the **newest** EUR/USD bar
back into the live spot cache, stamped `at = bar.t`, with **no upper time bound**.
The forex market trades ~24/5, so Tiingo keeps emitting thin, indicative EUR/USD
bars long after the 16:00‑ET equity close that the book actually settles at —
documented in `docs/tiingo_forex_fallback.md:158` ("the live `/top` endpoint keeps
quoting into Friday evening / over the weekend at the last rate"). Because those
indicative prints carry a later UTC instant than Friday's close (a Friday‑evening
ET bar is already Saturday in UTC), the newest bar:

1. **corrupts the value** — a thin weekend indicative rate becomes the spot that
   values the whole EUR leg of the book, and
2. **lies about its time** — it is stamped with a live clock instant, so
   `formatAsOf` renders it as a same‑day "as of 15:00" live reading instead of an
   honest "Friday's close / settled".

The 1D/1W graph paths defend themselves (`capAtClose`, `clampBarsToDay` in
`web/src/intraday.ts`); the **spot prime does not**. That asymmetry is the bug.
Every backfill/repair path funnels the FX bar through this one function
(`app.ts:1968` graph backfill, `app.ts:2183` after‑hours FX‑close repair), so a
single fix covers them all.

## Answer to the question — "amend the API call to ask the specific range?"

**Short answer: yes, we should — but it is a complementary first line of defence,
not the whole fix.** Here is the honest picture.

- The FX‑history request already supports `startDate`/`endDate`
  (`fetchTiingoFxBars`, `web/src/tiingo.ts:288`; and **now** Twelve Data's
  `time_series` via `fetchTimeSeries`, `web/src/prices.ts`), and every FX prime
  path already bounds the window to the **last settled equity session** rather than
  the live calendar day: `sessionFxWindow` / `weekFxWindow`
  (`web/src/live-graph.ts:73‑85`) derive both edges from `lastSessionDate(now)`. So
  on a Saturday we already ask for *Friday*, not *today*. Good — and we keep an
  audit guarantee that **no** prime path ever passes the live calendar day.

- **Why this is a *shift*, not just a clamp (v4.16.2).** Twelve Data's Pipe A used
  to fetch "the most recent `outputsize` bars ending now" with **no** date bound,
  so on a weekend it returned only thin post‑close indicative prints — the
  client‑side clamp then discarded *all* of them and Friday's genuine session was
  never even requested. The fix is to **shift the requested window's start *and*
  end** back to the settled session (the same `start_date`/`end_date` the Tiingo
  pipe already received), so the provider returns the *full* Friday session from
  open to close. The clamp then degrades to a pure safety net rather than the load‑
  bearing mechanism that could starve the curve of in‑session data.

- **The residual limitation:** a date bound is **day‑granular**. It fences off
  whole weekend/holiday calendar days, but it cannot by itself exclude the
  Friday‑evening / post‑16:00‑ET indicative intraday bars that share Friday's
  calendar day yet print after the equity book settled. (Twelve Data accepts a
  `HH:MM:SS` end bound, but we widen the intraday end to end‑of‑day for symmetry
  with Tiingo and let the client clamp own the exact 16:00‑ET cut.)

- **Conclusion:** amending the request range tightens the payload and removes the
  pure weekend/holiday calendar‑day leak cheaply and upstream **on both
  providers**, but the **authoritative time‑bound guard stays client‑side** — clamp
  the primed bar to the session close, the FX analogue of the graph's `capAtClose`.
  The two guards are layered, not redundant: range‑bound the request *and*
  close‑clamp the result.

This is why the plan below keeps the client‑side clamp as the core, and folds the
API‑range request in as step 0 (a cheap upstream narrowing + an invariant that the
live day is never requested), now applied symmetrically to **both** Tiingo and
Twelve Data.

## Plan

**0. Amend / harden the API call's range (cheap upstream guard) — both providers.**
Make every FX‑history / price‑bar request explicitly bounded to the last settled
equity session and assert that invariant in one place, so no path can quietly
request the live calendar day (which on a weekend would invite a Saturday‑dated
indicative bar). Concretely: route all FX prime fetches through the existing
`sessionFxWindow` / `weekFxWindow` helpers, document at the `fetchTiingoFxBars`
boundary that the window must end on a settled session, **and thread the same
window into Twelve Data's `time_series` (`fetchTimeSeries` `start_date`/`end_date`,
wired through `makeTwelveDataBarFetcher`)** so the formerly count‑only Pipe A is
window‑bounded too. Accept the documented day‑granular limit that this cannot
fence off intraday post‑close bars — that is step 1's job.

**1. Clamp the primed bar to the session close (value guard).**
Change `primeEurUsdFromFxBars` to pick the newest bar **at or before**
`sessionCloseMs(lastSessionDate(now))` — the FX analogue of `capAtClose` — instead
of the unconditional newest. Inject `now` so it is clock‑testable. Indicative
post‑close / weekend bars can then never become the spot value. If no bar survives
the clamp, prime nothing and keep the existing cache (no regression to a worse
value). Because the surviving bar is then Friday's genuine close instant,
`formatAsOf` naturally renders a date, not a live clock.

**2. Stamp bar‑primed readings as settled, not live (label guard).**
Give the cached EUR/USD reading an explicit "settled / value‑dated" notion (a
`settled` flag and/or a separate `observedAt` that is null for bar‑derived rates),
so a bar‑primed rate carries **no live observation instant**. When `loadEurUsd`
serves it, route the UI through the existing honest "EOD FX" / settled‑date path
(`fxFreshness → "eod"`, `formatAsOf → date`) rather than a clock. This closes the
softer case where a regeneration on the *same* local calendar day after close
(e.g. Friday evening) would otherwise still show a misleading clock for the close
instant.

**3. Decouple the TTL anchor from the displayed observation time.**
Today `at` double‑serves as both the TTL freshness anchor
(`now() - cached.at < ttlMs`) and the displayed "as of" instant. Separate them:
keep an internal stored‑at for the TTL math (so a freshly primed value stays
"fresh enough to serve" and the book keeps regenerating) while exposing the
settled/observation semantics independently for display. This is the crux of the
compromise — the value lives and regenerates; the label tells the truth.

**4. Preserve regeneration from empty / offline / after‑close.**
Confirm every regeneration path still fully populates from clamped, settled bars:
`prefetchSessionFx`, the graph backfill, the NAV/login warm‑up, and the
after‑hours FX‑close repair — value, untouched `previousClose` baseline, the
session‑open / session‑close anchors, and the overnight/market‑hours
currency‑effect split. Nothing here is blocked; only the timestamp semantics
change. The weekend `loadEurUsd` freeze already prefers this cache, so the clamped
settled bar correctly *becomes* the frozen Friday spot.

**5. Keep the currency stats regenerating, just honestly labelled.**
Because the value is retained, "Today ±x%", "Since close ±x%", and the
overnight/market‑hours split keep computing from the settled bar + the open/close
anchors — they simply stop being advertised as live.

## Additional ideas (the list isn't exhaustive)

**6. One settled‑vs‑live choke point.** Keep the time guard inside
`primeEurUsdFromFxBars` (the single function every prime path shares) rather than
duplicating it at each call site, so there is one authority and no parallel leak
can reopen.

**7. Sanity band on indicative bars — _dropped (v4.16.2)._** ~~Beyond the close
clamp, reject a primed bar whose value deviates beyond a small tolerance (e.g. a
few percent) from the existing cached close.~~ Deliberately **not** implemented: a
thin‑liquidity weekend print would have to be mistimed to *before* the 16:00‑ET
close instant to slip past the clamp at all, which is vanishingly unlikely, so the
close‑clamp alone is the guard and a value band is not worth the added complexity.

**8. Self‑heal the sticky bad stamp.** Today the "only move freshness forward"
rule (`latest.t <= cached.at` → skip) means a once‑cached bad late stamp *rejects*
every later correct restore for the rest of the weekend (the likely reason it
persisted on screen). Let the settled rewrite path replace a previously‑primed
settled stamp with the clamped/earlier close, so a later correct pull repairs it
instead of being pinned.

## Validation (when implemented)

- `web/test/cache.test.ts`: `primeEurUsdFromFxBars` rejects a post‑close / weekend
  bar, accepts the Friday‑close bar, primes nothing when only post‑close bars
  exist, never overwrites a genuinely newer live spot, and self‑heals a prior
  settled stamp.
- `web/test/quotes.test.ts`: a bar‑primed weekend reading served by `loadEurUsd`
  returns settled semantics (null observation / settled flag) yet stays fresh
  enough to value the book.
- A regression guard reproducing the screenshot (weekend, indicative bar)
  asserting the FX box shows "Market closed / Frozen at Friday's close / EOD" and
  **no** live "as of HH:MM" clock.
- The `web/` suite gate: `npm run typecheck && npm test && npm run build` (run in
  `web/`). No Python or version‑file changes are involved, so no version bump is
  needed.

## What this does **not** change

The timestamp *semantics* change (a settled rate now carries no live instant), but
no displayed value regresses: every regeneration path still fully populates from
clamped, settled bars, and the weekend `loadEurUsd` freeze still prefers this
cache so the clamped settled bar becomes the frozen Friday spot.
