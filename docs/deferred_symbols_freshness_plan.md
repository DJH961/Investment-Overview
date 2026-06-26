# Auto-Updates, Deferred Symbols & Freshness Labels — investigation + action plan

**Status:** ✅ fully implemented. Investigation done; the "always cached"
mislabel fix (§1.1) landed first, and the remaining backlog and original ideas
(§2 per-row freshness chip, §3 deferred-queue freshness + threading, §4.1
freshness legend, §4.2 explicit "updating…" bucket) have now all shipped.
See the per-section **Implemented** notes below.
**Issue:** "deferred symbols never update / the status never changes" plus
"things keep being labelled *cached* even when the value is two minutes old", and
"freshness labels for low-liquidity symbols are wrong (falsely live, or falsely
old)".
**Anchored to:** `web/src/app.ts`, `web/src/compute.ts`, `web/src/freshness.ts`,
`web/src/deferred-queue.ts`, `web/src/quotes.ts`. Symbols drift — **re-grep the
named functions before editing**, trust the names not the line numbers.

---

## Abstract (read this first)

The empirical evidence ("deferred symbols never update, the status never
changes") is **mixed on purpose**: two different things look identical on screen.

1. **Deferred symbols *do* get re-pulled.** A symbol pushed past the free-tier
   per-minute budget is parked, and the very next refresh round re-evaluates it
   against its per-symbol cache TTL (`marketCacheTtlMs` / `quoteRefreshDue`) and
   pulls it when due. The burst cadence (`refresh-policy.ts`,
   `DEFAULT_BURST_INTERVAL_MS = 60s`) exists precisely to drain the overflow
   minute-by-minute until nothing is deferred. So the *updating* machinery works.

2. **But the *label* lied.** While the market was open, the coverage line split
   holdings into "live" (freshly pulled **this round**) and "cached" (anything
   else). A symbol whose spot was confirmed 90 seconds ago — but served from
   cache *this* round because its TTL hadn't elapsed — was stamped **cached**.
   To the user that reads as stale and "never changing", even though the price is
   genuinely current. This is the artefact the issue describes, and it is the
   part we have fixed.

The fix mirrors a pattern the FX side already had: `displayFxSource` promotes a
cache-served EUR/USD spot to "live" when it was observed within the live window.
We now do the same for market holdings in `buildCoverageFacts`.

---

## 1. What was fixed (this PR)

### 1.1 Promote a recently-confirmed cache to "live" in the coverage line
`buildCoverageFacts` (`web/src/app.ts`) previously counted a market holding as
"live" **only** when `report.fetched` contained it this round; everything else
held fell into the "cached" bucket. Now a held holding also counts as live when
its cached observation `at` is within the live window (the user-set
auto-refresh interval, default 15 min), and only while the **session is open**
(where "live" is a meaningful claim). A genuinely aged cache still reads
"cached"; a closed market still reads through the settled-close messaging.

- `at` (observation epoch — *when we last confirmed the price*) is the right
  signal here, not `priceTime` (when the trade actually struck). That is exactly
  what makes a **low-liquidity** symbol read correctly: its last trade may be 30
  minutes old, but if a recent pull *confirmed* that price, it is "live", not
  "old". See §2.
- This is purely presentational — it changes the count in the status string, not
  which symbols are fetched, and not the headline `pricesAreLive` badge (which
  remains the strict, market-open + same-day + within-window claim in
  `compute.ts`).

Tests: `web/test/manual-refresh.test.ts` — "counts a cache-served holding observed
within the live window as live, not cached", plus the aged-cache and
market-closed guards.

---

## 2. Low-liquidity / illiquid symbols — quote freshness (recommendation)

`docs/session_close_completeness_plan.md` fixed the **1D bar** loop for thin
symbols (e.g. the US-listed `DAX` ETF) by changing the question from "is the
newest bar near the clock?" to "have we got the best close anyone can give us?".
The analogue for **individual quotes** is already mostly right and is reinforced
by §1.1:

- The portfolio "live" badge keys off `liveAsOf = max(priceAsOf)` across holdings,
  so a single illiquid symbol whose last trade is 30 min old cannot, on its own,
  drag the whole book out of "live" — the freshest peer carries it.
- The coverage line now treats a *recently-confirmed* cache as live (§1.1), so an
  illiquid symbol we just re-checked is not mislabelled "cached/old".

**Remaining gap (backlog):** there is no *per-row* "stale" flag for a market
holding whose own last confirmed observation is far older than the live window
while the market is open. Today the row simply shows its "as of" time/date
(`formatAsOf`), which is honest but quiet. A future enhancement could add a
per-row freshness chip ("live" / "recent" / "as of <time>") driven by `at`
vs the live window, exactly mirroring `displayFxSource`'s three-way split, so an
individual illiquid holding is neither dressed up as live nor falsely flagged
old. Deferred here to keep this change surgical.

**✅ Implemented.** `web/src/freshness.ts` now exports `holdingFreshness()`,
returning a three-way `RowFreshness` tier (`"live"` / `"recent"` / `"aged"`)
from a holding's observation epoch, the live window, and whether the market is
open. `web/src/compute.ts` classifies each holding into `HoldingView.priceFreshness`
during `buildDashboard`, and `web/src/ui.ts` renders a per-row chip
(`holdingFreshnessChip`): a live dot + "live", a quiet "recent", or the honest
"as of <time>" — the full timestamp always available on hover. Styling lives in
`web/src/styles.css` (`.holding-asof.fresh-live` / `.fresh-recent` / `.fresh-dot`).

---

## 3. Deferred-queue bookkeeping (backlog, *not* changed here)

`drainDeferredQueue` (`web/src/app.ts`) clears a parked symbol from
`DeferredQueue` whenever a cached quote merely *exists* for it
(`(cached.get(symbol)?.quote?.at ?? null) !== null`), regardless of that cache's
age. The drain's return value is currently **ignored** at the call site — the
real re-fetch is driven by each symbol's cache TTL in the round, so this does not
on its own strand a stale symbol. It is therefore a latent correctness wrinkle,
not the bug behind the issue, and is intentionally left untouched to avoid
changing fetch behaviour without strong evidence. If revisited, the
`hasFreshQuote` predicate should test *freshness* (within the live window), not
mere presence, and the `stillMissing` result should be threaded into the round's
fetch set so a parked-but-stale symbol is explicitly drained rather than relying
on the TTL alone.

**✅ Implemented.** `drainDeferredQueue` now tests freshness — a parked symbol is
only cleared when its cached `at` falls within the live window
(`config.updateMinutes`, falling back to `LIVE_PRICE_MAX_STALENESS_MS`, with a
clock-skew guard) — and returns the `stillMissing` set. The round captures that
set and threads it through `refreshPrices({ forceSymbols })` →
`quoteRequest` → `buildQuoteOptions`, whose `forceFetch` predicate now force-pulls
any still-stale deferred symbol instead of leaving it to the TTL alone. The
login-prefetch path passes no force set, so its behaviour is unchanged.

---

## 4. Original ideas (beyond the issue's list)

1. **A single "freshness legend" tooltip.** The status line uses "live",
   "cached", "recent", "at last close", "awaiting" — all honest, but dense. One
   small `?`/legend explaining each term (and that "cached = confirmed within the
   refresh window") would defuse the "why does it say cached?" confusion at the
   source, not just the wording.
2. **Surface the deferral explicitly.** When symbols are parked for the next
   minute (free-tier overflow), say so positively — e.g. "8 live, 4 updating…"
   instead of folding them silently into "cached" — so the user sees the burst
   cadence working rather than inferring a stall. This builds on §1.1 by giving
   the still-draining symbols their own honest bucket.

**✅ Implemented.**
- §4.1 — `web/src/ui.ts` `freshnessLegend()` renders a native `<details>`/`<summary>`
  "?" disclosure appended to the coverage note in `renderNotes`, glossing each
  term ("live", "updating…", "recent", "cached = confirmed within the refresh
  window", "at last close", "awaiting"). Styled via `.freshness-legend*` in
  `web/src/styles.css`.
- §4.2 — `CoverageFacts` gains a `marketUpdating` count (in `buildCoverageFacts`):
  market holdings still held from cache but parked in `report.deferred` and not
  yet live. `summarizeCoverage` carves these out of "cached" into their own
  "updating…" bucket between "live" and "cached" (e.g. "8 live, 4 updating…"),
  and the coverage poll log mirrors the count.
