# FX KPI cold-start regeneration plan

> **Status:** proposal (not implemented). Created to let the owner weigh options
> before any code is written.

## Problem

The hero currency KPI ("Currency effect" in EUR / "Investing power" in USD) and
its market-hours/overnight split still fail to regenerate **all** of their
information from an empty state at the worst possible moment:

> **Worst case:** Sunday, ~10 minutes before the FX market reopens (≈16:50 ET
> Sunday), with wiped device storage. Forex is therefore still **frozen**, and
> the last completed US equity session was **Friday**, whose prior session was
> **Thursday**.

At that moment the currency box is a `sessionView` (forex frozen, US shut), so
the UI wants to draw the **full frozen two-leg split** plus the
"since yesterday" headline — but one of the four anchors it needs cannot be
recovered, so the headline collapses to zero and the panel is dropped.

## Background — the four EUR→USD anchors the KPI runs on

| Anchor (`OverviewView` field) | Meaning | Role |
| --- | --- | --- |
| `fxRateEurUsd` (**liveFx**) | current spot | right edge of "today" |
| `fxRateEurUsdPrev` (**prevFx**) | prior session's *settled daily close* (provider `previousClose`) | **outer baseline** — left edge of the whole "since yesterday" span |
| `fxRateEurUsdSessionOpen` | last session's 09:30 ET open, from intraday FX bars | interior split point |
| `fxRateEurUsdSessionClose` | last session's 16:00 ET close, from intraday FX bars | interior split point |

`fxEffectSplit` enforces `total = marketHours + overnight`:

- **prevFx defines the *total*** (`todayFxMoveEur = book@liveFx − book@prevFx`).
- **sessionOpen / sessionClose only *partition* that total** into the two legs.

So prevFx is **not** duplicative with the two session anchors — it is the only
baseline that exists in *every* phase (while the market is open, `sessionClose`
is `null` and prevFx is the sole "yesterday" rate). Its *value* merely coincides
with the last session's close over a weekend, which is why the code already does
`fxEffectPriorFx = prevFx ?? sessionClose`, and which is the cheap lever this
plan exploits.

### Consumers of each anchor (grep-verified)

- `prevFx` → `compute.ts` `todayFxMoveEur`, `fxTodayDeviationPct`; `ui.ts`
  `renderEurFxEffect` headline, `renderInvestingPowerEffect` baseline, currency
  box "Today" stat (open market).
- `sessionOpenFx` / `sessionCloseFx` → `ui.ts` `renderEurFxEffect` /
  `renderInvestingPowerEffect` split bars, currency box "Since open/close" stat,
  and the live-graph freeze anchor (`graphAnchorFx`).

## Why the worst case fails today — anchor-by-anchor trace

Traced through `loadEurUsd`, `prefetchSessionFx` / `prefetchGraphBars`, and the
`buildDashboard` post-processing block in `app.ts`:

| Anchor | Recoverable from empty state? | Path |
| --- | --- | --- |
| **liveFx** | ✅ | forex frozen ⇒ `loadEurUsd` returns `now:null`, but the `fxBars` orchestrator leg pulls Friday's intraday EUR/USD and `primeEurUsdFromFxBars` folds Friday's last bar into the spot cache as the frozen live spot (ECB EOD is a further fallback). |
| **sessionCloseFx** | ✅ | `barsSessionCloseFx` → `sessionCloseFxFromBars` on Friday's freshly-pulled bars. |
| **sessionOpenFx** | ✅ | `barsSessionOpenFx` → `sessionOpenFxFromBars` on the same bars. |
| **prevFx** | ❌ **the gap** | `loadEurUsd` (frozen) returns `previousClose:null`; the persisted fallback `readPrevSessionCloseFx(Thursday)` is empty on a wiped device; and **nothing fetches Thursday at all** — `sessionFxWindow` is a *single-day* window (`startDate = endDate = Friday`), so the FX backfill never reaches back to the prior session's close. |

**Consequence:** prevFx null ⇒ `todayFxMoveEur` = 0 ⇒ `renderEurFxEffect`'s
zero-guard drops the entire panel, so the headline + frozen two-leg split never
render. The KPI's headline and split are exactly the stats that stay blank at the
worst time.

## The fix

### 1. Derive `prevFx` from FX bars (mirror how open/close already work)

Add a bar-derived prior-close fallback `barsPrevSessionCloseFx(sessionDay)` that
reads the **prior trading session's** close
(`sessionCloseFxFromBars` at `sessionCloseMs(previousTradingSession(sessionDay))`)
from the stored FX track. Wire it into the `eurUsdPrev` resolution block in
`app.ts` (the `recordPrevSessionCloseFx` / `readPrevSessionCloseFx` block) as the
next fallback **after** the live `previousClose` and the persisted close, before
giving up. prevFx then regenerates from the same authoritative on-device source
the other three anchors already use; no behavioural change when the live feed is
healthy.

> Note on semantics: over the weekend the "since yesterday" cutoff sits at the
> prior session close, and the provider's `previousClose` value converges with
> Friday's settled close. In the strict design, the frozen *market-hours* leg is
> `book@FridayClose − book@prevFx`. Keeping prevFx as the genuine prior settle
> (Thursday) preserves the existing two-leg semantics; substituting Friday's close
> would zero the frozen market-hours leg. The plan therefore reaches back one
> session rather than reusing Friday's close as the baseline.

### 2. Make sure the prior-session close is actually on the device

Two complementary sources, cheapest first:

- **Reuse the 1W FX track (zero extra credits).** The weekly curve's FX track
  (`weekFxWindow`, ≈5 sessions) already spans Thursday. Read prevFx from it first.
  Verify the empty-state warm-up / regeneration schedules the 1W FX leg at cold
  start (not only the 1D leg).
- **Widen the currency-KPI FX window as a guaranteed path.** Extend
  `sessionFxAnchorMissing` (and the `fxBars` leg it drives) to also flag
  "prior-session close missing" while the market is closed, and have
  `prefetchSessionFx` / `sessionFxWindow` fetch
  `[previousTradingSession(lastSession) … lastSession]` (Thursday→Friday) in one
  request when that anchor is absent. One extra credit guarantees the baseline
  even if the 1W leg was skipped.

### 3. Persist what we recover

Once prevFx is resolved from bars, write it via
`recordPrevSessionCloseFx(previousTradingSession(lastSession), prevFx)` so
subsequent paints — and the next cold start — read it back instantly without
re-fetching.

## Two extra ideas (beyond plugging the prevFx hole)

### 4. Graceful partial split instead of an all-or-nothing blank

Even if the prior-session close genuinely can't be recovered, we still hold
Friday's open and close. Let `renderEurFxEffect` render the frozen **market-hours
leg alone** (Friday open→close — needs only `sessionOpenFx` + `sessionCloseFx`)
rather than dropping the whole panel when only prevFx is missing. The KPI then
always shows something truthful at the worst time and self-completes the moment
the baseline lands.

### 5. One "FX cold-start completeness" predicate + a single consolidated backfill

Today the anchors are repaired by several scattered gates (close-only leg, open
leg, prev-close persistence). Add one phase-aware predicate that reports *which*
of the four anchors are missing for the current phase, and drive a single
consolidated FX backfill from it (widening the window to whatever span covers the
missing anchors). This removes per-anchor drift between the leg gates and makes
"regenerate ALL of its information" one unit-testable decision — directly matching
the problem framing.

## Validation

- Pure helpers (`barsPrevSessionCloseFx` logic, widened `sessionFxAnchorMissing`,
  the partial-split render gate) are unit-testable with injected clock/bars — add
  cases to `web/test/session-fx.test.ts`, `web/test/data-orchestrator.test.ts`,
  and `web/test/live-graph.test.ts` (which already pins `sessionFxWindow`).
- Add a focused "Sunday pre-forex-open, empty store" scenario asserting all four
  anchors resolve and both EUR/USD panels render with the frozen Friday split.
- Run the web suite from `web/`:
  `npm ci && npm run typecheck && npm test && npm run build`.

## Option summary (for weighing)

| Option | Cost | Guarantees baseline? | Notes |
| --- | --- | --- | --- |
| 1 only (bars fallback) | 0 extra credits | only if Thursday already on device | depends on 1W FX leg coverage |
| 1 + 2a (reuse 1W FX) | 0 extra credits | yes, if 1W FX is fetched at cold start | cheapest full fix |
| 1 + 2b (widen window) | +1 credit on cold start | yes, always | belt-and-suspenders |
| + 4 (partial split) | 0 | n/a | UX safety net; shows truthful partial KPI immediately |
| + 5 (unified predicate) | 0 | n/a | refactor; reduces future drift, larger change |
