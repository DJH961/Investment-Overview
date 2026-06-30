# Graph Unification Plan — One Intraday‑Window Builder

> Status: **design‑frozen, not yet implemented.** This document is the agreed
> blueprint for eliminating the long‑standing 1D vs 1W graph divergence.

---

## The goal, in plain English

For a long time the portfolio graphs have disagreed with themselves:

- **A — the spiky week.** The same recent period looks smooth on **1D** but
  spiky/sawtooth on **1W**.
- **B — overnight shape drift.** A settled day's 1D shape shifts slightly between
  the night view and the next morning, even though only the level (NAV) should
  move, not the shape.
- **C — the trailing tip.** At the right edge, **1D ends ticking up** while **1W
  ends ticking down** on the *same* close — which is impossible if they describe
  the same portfolio.

The root cause is simple once you see it: **1D and 1W are two different code
paths.** 1D draws dense intraday bars straight from the web provider. 1W draws
one coarse close per day and then *merges in a second, lower‑resolution data
source* (the desktop "blob") to try to add detail back. That merge is where the
spikes, the drift and the trailing‑tip mismatch all come from.

### The idea

Stop treating 1D and 1W as different things. **They are the same graph over a
different number of days.** So we build **one "intraday‑window" graph**:

- It fetches **5‑minute bars per symbol** over a window of `N` days.
- **"1D" is just `window(1 day)`. "1W" is just `window(5 days)`.** 2, 3 or 4‑day
  windows are the exact same builder for free.
- The "1D slice" of the 1W graph is therefore **literally the same bars** as the
  1D graph — not similar, identical.

This is affordable because the price provider (Twelve Data) **bills 1 credit per
symbol per request regardless of how many bars come back** — a dense 5‑day week
costs the same as a single day. So a single windowed fetch is a *superset* of the
1D fetch at *identical cost*: when you log in heavily outdated, **one fetch fills
both graphs.**

And because everything is now drawn from the same dense, per‑symbol intraday data,
the second data source (the blob merge) that caused the spikes is **removed
entirely**, not patched. We keep the blob only as an offline/edge fallback.

Finally, the **Python desktop app gets the same treatment at the same 5‑minute
density**, so neither app — and neither timeframe — can drift from the other.

### What is explicitly *not* changing

- The **update/polling orchestrator**, caching, reservation and back‑off — all
  untouched. We only change **what data is loaded** and the **bar type/settings**.
- **Breadcrumbs** stay as the live‑tail filler for the open session.
- The **provider‑disagreement / settle** machinery stays.
- Nothing is "frozen" at close — that was never the behaviour and isn't changing.

---

## Evidence (live API probes, 2026‑06‑30)

Probes run against the live Twelve Data and Tiingo keys:

| Finding | Result |
| --- | --- |
| TD `time_series interval=5min` + `start_date` over a week | Returns the **full 5 trading days** — `78 bars/day × 5 = 390 bars` — in **one call per symbol** |
| TD billing | **1 credit per symbol per request, regardless of bar count** (`prices.ts:460`) |
| TD coverage at 5min (one call) | Full (78/day): MSFT, VOO, VXUS, VT, VGK, VUG, VTV, VTI, IAUM, VWO. Near‑full: SCHK (74–78). Sparse: **DAX** (20–36/day) |
| Why DAX is sparse on TD | TD omits **no‑trade 5‑min buckets** for the thin Global X DAX ETF; the price info is identical to Tiingo's — Tiingo just forward‑fills empty buckets with synthetic flats |
| EUR/USD at 5min | Dense on **both** TD (~288/day) and Tiingo (~288/day) |
| 5‑min history depth | **~5 trading days** — exactly matches `DEFAULT_WEEK_SESSIONS = 5` (`week.ts:72`) |
| Rate limit | **8 calls/min** on the supplied TD key is real (a 10‑symbol batch returned HTTP 429) |

**Conclusion:** Twelve Data alone can self‑cover the entire 1W window at 5‑minute
density for the whole book in one call per symbol. Tiingo is an *optional*
backfill (DAX/SCHK) and is **not** needed for live FX (credit‑constrained). Thin
symbols are handled by the per‑symbol forward‑fill already present in
`reconstructSessionCurve`.

---

## Current state (verified against `main`)

### 1D — session pipeline
`buildLiveSessionCurve` (`live-graph.ts:680`) → `makePriceBarFetcher`
(`param:"intraday"`, 5‑min) over `sessionFxWindow` (today) →
`loadOrBuildSessionCurve` (`intraday.ts:456`) → per‑symbol bars in
`stored.bars[s]` → `reconstructSessionCurve` (`timeseries.ts:185`).

- Live tip: whole‑book **breadcrumb** spliced after the last bar while the market
  is open (`intraday.ts:699‑712`).
- After close: `capAtClose(points, closeMs)` filters `t > closeMs`
  (`intraday.ts:232‑234, 713‑718`).
- **Never merges the blob.** Clean and smooth.

### 1W — week pipeline
`buildLiveWeekCurve` (`live-graph.ts:751`) → `makePriceBarFetcher`
(`param:"daily"`, `interval:"1day"`, `outputsize ≈ 8`) → `loadOrBuildWeekCurve`
(`week.ts:431`): **one close per session per symbol** in `stored.bars[s]`.

- Per‑day enrichment (`week.ts:660‑723`) swaps each day's coarse close for fine
  1D intraday bars **read from that day's session cache** via
  `store.loadSession(day)` (`week.ts:674`) — but that cache only exists for days
  the dashboard watched live, so **older days stay one coarse point/day**.
- `reconstructSessionCurve` (`week.ts:725`), **then** `enrichWeekWithBlobSleeve`
  (app.ts) → `mergeSleeveSeries` (`market-sleeve.ts:180`), **then**
  `capWeekToSessionClose` (`week.ts:801`).

### The defect, exactly
`mergeSleeveSeries` agree‑branch (`market-sleeve.ts:221‑224`):

```ts
if (Math.abs(deltaFraction) <= tau) {
  // Agree — thicken the line with the union of both sources' true points.
  points.push(...tag(w, "both"), ...tag(b, "both"));
  counts.both += 1;
}
```

It **unions** web 5‑min points and blob 30‑min points whenever they agree within
`tau = 0.25%`. They agree but are not equal, so the blob sample sits offset from
the web line and, sorted by time, interleaves web/blob/web → **sawtooth = A**. The
EUR leg is doubly affected because the two sources carry different per‑instant FX.
The conditional tail pin `pinMergedTipToWebTip` (`market-sleeve.ts:305`) plus the
post‑merge cap seam produce the **trailing‑tip mismatch = C**. (The disagree‑branch
already keeps the blob authoritative and raises a `ReconciliationFlag` — that part
is fine.)

### Supporting systems (unchanged by this plan)
- **Blob** ships an **aggregate** market sleeve (`market_series`: FX‑free USD
  value + per‑instant `fx_eur_usd`), **not per‑symbol**; only the 1W builder
  consumes it.
- **Disagreement:** `resolveCloseCompleteness` (`close-completeness.ts`) — primary
  TD + secondary Tiingo; a symbol is **settled** when one source reaches the close
  *or* two sources agree 3×. Used by **both** 1D (`tol ≈ 1h`) and 1W
  (`tol ≈ 12h`). Provider‑agnostic; kept.
- **FX:** EUR/USD is just another symbol on the same price pipe
  (`makeFxFetcher`); applied per bar in `reconstructSessionCurve`
  (`timeseries.ts:127‑145, 211`). The live quote is stamped at **fetch time**
  (`quotes.ts:866` `const at = now()`).

---

## The changes

### C1 — 1W bar type/settings → intraday 5‑min over the window
`live-graph.ts:766‑801`: change the 1W fetcher from
`param:"daily" / interval:"1day" / outputsize≈8` to
`param:"intraday" / interval:"5min" / outputsize ≈ sessions·78 + pad` with
`startDate = week‑window start`. Now `stored.bars[s]` holds **dense 5‑min bars for
every window day**, feeding the same `reconstructSessionCurve`. The today‑slice of
1W becomes the same bars as 1D.

### C2 — Remove the blob merge from the live 1W path
Drop the `enrichWeekWithBlobSleeve` call and retire `mergeSleeveSeries` /
`calibrateSleeveBase` / `rebaseSleeveToWholeBook` / `pinMergedTipToWebTip` from
the live path. With C1 there is **no second aggregate to reconcile** → the union
sawtooth (**A**) and the pin/cap tail seam (**C**) disappear by construction.
This is why **no per‑symbol blob export is needed** — we delete the unifier rather
than perfect it.

### C3 — Tail unification
Once the merge and pin are gone, 1W uses the **same `capAtClose`** as 1D (it
already calls it internally via `capWeekToSessionClose`). No special tail logic
remains → **C** resolved.

### C4 — FX policy (no polling change)
Switch the 1W FX leg from daily to 5‑min (same pipe, mirrors C1) and stop
consuming the blob's `fx_eur_usd` (gone with C2). **Trust device‑pulled 5‑min
FX.** Do **not** touch quote polling or live‑quote stamping.

### C5 — Shared per‑day store (answers "identical + carried forward")
Both views reconstruct from the **same per‑day session bars** via the **same**
`reconstructSessionCurve`, so the 1D slice of 1W is identical, not similar. The
carry‑forward already exists (`week.ts:674` reads each window day's session);
today's dense session persists per‑day and is read as a prior day tomorrow. We
just make **every** window day dense.

### C6 — Unify the fetch (answers "for outdated situations, one bar set")
The windowed 5‑min pull is a **strict superset** of the 1D pull at **identical
cost** (1 credit/symbol regardless of length). Collapse the two fetchers into one
windowed intraday fetcher feeding the shared per‑day store; each view is a slice:

- **Heavily outdated / fresh login:** one windowed fetch serves **both** 1D and
  1W — no separate 1D call.
- **Warm store, market open:** only today's slice is refreshed.

The orchestrator's timing/triggers are **untouched**; only *what* is loaded is
deduplicated. **Consequence:** the separate `WEEK_STORE_KEY` daily‑close cache
(`week.ts:639‑658`) and the `daily/1day` close‑completeness path **retire** — the
week reconstructs from the shared per‑day intraday store. This is the load‑bearing
deletion; it is gated behind the test suite.

### C7 — Reframe: it's just intraday‑window fetching
There is no "1D path" and "1W path" — there is **one intraday‑window builder
parameterized by `[start, end]`**. "1D" = `window(1 session)`, "1W" =
`window(5 sessions)`; 2–4‑day windows are the same builder/fetch/reconstruction
for free. **Bound:** 5‑min depth ≈ 5 trading days (probe ceiling) → the intraday
builder covers any range up to ~5 sessions at 5‑min; **beyond that the existing
long‑range/daily path** (`app.ts:8032`, interval steps up with window length)
takes over unchanged.

### C8 — Python parity at 5‑min
Collapse Python's `build_intraday_value_series` vs `build_week_value_series` into
**one range‑parameterized intraday builder at 5‑min**, sharing the per‑session
reconstruction, so Python graphs match web density and Python's own
1D‑slice‑of‑1W equals Python 1D. **If web is 5‑min, Python is 5‑min.**

---

## What stays (explicit)

- **Breadcrumbs** — unchanged; still the live‑tail filler in both views
  (`intraday.ts:699‑712`, `week.ts:758‑778`). They simply matter less for the body
  once it is dense.
- **Blob loading** — kept as springboard/initial paint **and offline/edge
  fallback only** (no longer a live merge source). If a window day's 5‑min pull
  can't reach (offline, or the oldest edge beyond depth), fall back to that day's
  **daily close** — a fallback, never a blended merge.
- **Disagreement** — keep `resolveCloseCompleteness` (TD primary + Tiingo
  secondary). 1W simply moves from daily granularity to the intraday granularity
  1D already uses. Thin symbols (DAX) rely on the per‑symbol forward‑fill already
  in `reconstructSessionCurve`.
- **Orchestrator / polling / caching** — untouched (`regenerateOnly` redraw path,
  store, reservation, back‑off).
- **No‑freeze** — already the existing behaviour (`capAtClose` only *filters*
  post‑close); not a change.

---

## How this kills the three symptoms

| Symptom | Mechanism removed/added | Result |
| --- | --- | --- |
| **A** — 1W spiky | C1 + C2: dense per‑symbol bars, no two‑aggregate union merge | sawtooth gone |
| **B** — overnight shape drift | C5: same per‑day bars + same builder; settled days stop being reshaped by a second source | only level moves, never shape |
| **C** — 1D‑up / 1W‑down tail | C2 + C3: same builder, same today bars, no pin/cap seam | trailing tip identical |

---

## Cost / risk

- 1W refresh ≈ 17 credits (1/symbol; dense week = same as one day). The existing
  orchestrator already gates *when* — no budget‑regime change.
- **Exact depth fit:** window = 5 sessions vs 5‑min depth = 5 sessions has no
  margin at the oldest edge → the C2 daily‑close fallback covers a
  holiday‑shortened or edge miss.
- Removing the blob merge and the weekly daily‑close cache is the largest
  deletion → gated behind tests (`market-sleeve.test.ts` contract flips from
  "union/thicken" to "no live merge").

---

## Build order

1. **C1** — 1W bars → 5‑min over the window.
2. **C2** — remove the blob merge from live 1W; add edge/offline daily fallback.
3. **C3** — tail unification (drops to 1D's `capAtClose`).
4. **C6** — unify the fetch into one windowed intraday fetcher + shared per‑day
   store; retire the `daily/1day` week cache.
5. **C4** — FX leg → 5‑min; drop blob FX.
6. **C8** — Python mirror at 5‑min.

> No code is to be written until this plan is explicitly approved for
> implementation.
