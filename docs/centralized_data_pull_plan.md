# Action Plan — Centralized data pull (web companion)

> **Status:** Proposed. This is the **web-only** plan. All changes to the Python
> desktop app — chiefly the richer `live_graphs` export that feeds Pillar 3's
> multi-source 1W merge — are deliberately split into a **separate** plan
> (`docs/centralized_data_export_plan.md`) so the web work can land first. Where
> this plan depends on a richer blob, it is written to **degrade gracefully** on
> today's schema-v2 blob and only *light up* when the v3 export ships.

**Working directory:** `C:\Users\t-dhenke\OneDrive - Microsoft\Documents\VS Code\Investment-Overview`
**Scope:** `web/` (TypeScript companion) only.
**Tests:** existing vitest suite under `web/test/*.test.ts`. No new frameworks.
Verify the baseline is green before and after.

---

## Why this plan exists

The web data layer works but has **sprawled**. The June 2026 market-open
token-burn fix added real safety machinery (the per-provider 429 breaker in
`provider-breaker.ts`, the single credit authority in `reservation.ts`), but the
*decision* logic for **what to pull, when, and in what order** is still scattered
across `app.ts`, `quotes.ts`, `tiingo-fallback.ts`, `live-graph.ts`,
`intraday.ts` and `week.ts`. Symptoms the owner hit directly:

- Safety logic exists but is **undiscoverable** — e.g. manual refresh already has
  a credit-availability gate (`app.ts` ~2790) that even the owner had forgotten.
- Login can **double-pull**: prefetch (pre-unlock) and startup refresh
  (post-unlock) both fetch quotes/FX, only loosely coalesced by an `await`.
- `primeStaleGraphPackages()` fires a graph-bar pull on **every** refresh round
  (`app.ts` ~3004), regardless of trigger — the self-perpetuating storm the
  burn-fix doc named.
- A chart **range toggle can fetch** (`intraday.ts` `loadOrBuildSessionCurve`
  has a live `needFetch` branch), so UI interaction is not guaranteed
  network-free.

The goal is **one readable brain** that owns every pull decision, with the proven
fetch primitives and budget authority kept underneath as dumb, non-bypassable
executors. Centralize the *decisions*, not the *plumbing*.

---

## Guiding principles (the pillars)

1. **One orchestrator.** A single module owns *what/when/which-provider*. Editing
   priority or provider order is a one-file change. It calls existing fetchers +
   `reservation.ts`; it never re-implements them.
2. **Never stale on login — smartly, within budget.** Freshness is delivered by
   *demand minimisation* (blob-first history, derive quotes from bars,
   breadcrumbs), not by exceeding provider caps. Login is allowed to **spend**
   (it is a "glance for 2 minutes" app), but it still obeys the freshness ledger,
   so a log-out/log-in seconds later pulls nothing.
3. **1D fills 1W; never the reverse — and merge all sources.** 1D intraday detail
   accretes into the 1W graph (already implemented). Add multi-source merge
   (device bars + freshly-pulled bars + blob bars) with disagreement *flagged*,
   not blended into spikes.
4. **Graded freshness.** A truth-table keyed on data-age × blob-age × market-state
   decides the pull. **Bars are clock-hour-aligned during market; quotes use a
   rolling TTL.**
5. **Provider spilling under one authority.** Twelve Data leads (≤8/request),
   Tiingo takes overflow. Login/manual may **fan out across providers** for
   instant results; everything stays under the reservation + breaker authority.
6. **Exactly four pull mechanisms.** `start` · `auto` · `manual` · `reset`.
   Everything else (visibility, online, pageshow, range toggle, graph click) is
   either one of these or is **regenerate-only** (no network).

---

## Pillar 1 — The single orchestrator

Introduce `web/src/data-orchestrator.ts`. It is the **only** module that decides
to pull. Everything funnels through one entry:

```ts
type PullKind = "start" | "auto" | "manual" | "reset";

interface PullContext {
  kind: PullKind;
  now: number;
  market: MarketState;          // from market-hours.ts
  freshness: FreshnessLedger;   // quote ages, last-bar-by-clock-hour, blob age/coverage
  holdings: SymbolSet;          // market + NAV split
  blob: BlobView;               // decrypted truth (may be absent at prefetch time)
}

async function pull(ctx: PullContext): Promise<PullReport>;
```

- **The four mechanisms become thin callers** that build a `PullContext` and call
  `pull()`. No mechanism contains fetch logic of its own.
- **`pull()` decides** via the Pillar-4 truth-table which legs to run (1W bars,
  1D bars, quotes, NAV, FX), then dispatches to the **existing** fetchers
  (`loadQuotes`, `runTiingoFallback`, `makePriceBarFetcher`, `makeWindowFxFetcher`,
  …), each already routed through `reservation.ts`.
- **`primeStaleGraphPackages` is dissolved** into `pull()` as a *decision*, not a
  standing pre-step. It can no longer fire unconditionally every round.
- **Readability acceptance:** a developer can read `data-orchestrator.ts` top to
  bottom and state, for any (kind, market, freshness), exactly what will be
  fetched and from which provider — without opening another file.

> **Refactor discipline:** move *policy* into the orchestrator; leave
> `prices.ts`, `quotes.ts`, `tiingo*.ts`, `live-graph.ts`, `blob.ts` as executors.
> Do **not** rewrite the fetch primitives. The 429 breaker and reservation
> authority remain the hard floor and are never bypassed by any kind.

---

## Pillar 2 — Never stale on login (two-step handshake)

Login is **two steps that cooperate through the freshness ledger**, so they are
additive, never redundant:

1. **Step 1 — Prefetch (may start before unlock).** Pull what the *predicted*
   symbol set (last-known holdings) + market state say we need, against the
   freshness ledger. Don't wait for the passphrase.
2. **Step 2 — Post-decrypt reconcile.** Decrypting the blob reveals the truth —
   blob staler than predicted, or a **newly-bought symbol**. Pull **only the
   diff**, deduped against Step 1 via the same ledger. Step 2 can never re-fetch
   what Step 1 already booked.

**Definition of "fresh on login":** *no older than the freshest point our
providers could legally have returned within budget* — not a real-time tick. The
17th+ symbol of a large sleeve may be one minute behind at the instant of login;
that falls inside the owner's own carve-out and is acceptable.

**Re-login is a no-op by construction:** login bypasses the *latency* throttle
(spacing / the 16+ gate — see Pillar 5) but still honours the *staleness* ledger
(rolling quote TTL, clock-hour bar gate). A log-out/log-in seconds later finds
every symbol inside its freshness window and pulls nothing. **No special
re-login guard is needed.**

---

## Pillar 3 — 1D fills 1W, and multi-source merge

**Already implemented (protect, don't rebuild):** intraday bars are retained for
**7 trading days** (`pruneOldSessions`, `intraday.ts` ~567; merge-not-replace in
`timeseries-store.ts` `mergeSession` ~309), and `week.ts` (~435–455) already
**replaces each window day's coarse close with that day's stored fine intraday
bars** and splices rebased breadcrumbs into the gaps. A day watched on 1D renders
at intraday resolution in the 1W view; a day skipped falls back to its daily
close. This *is* the "regular logins ⇒ richer graphs" reward. The redesign must
**not** prune or coarsen it — add a regression guard.

**New: treat the 1W curve as a union of homogeneous per-symbol sources.** Once the
v3 export ships (separate Python plan), the web can see up to three **per-symbol
native-price** sources for a given day:

1. device-captured 1D intraday bars (already on device),
2. freshly-pulled 1W daily / intraday bars,
3. **blob bars** from the desktop (token-free, so potentially the richest).

Because all three are `(symbol, time, native price)` and are **repriced against
the current anchor** (holdings + FX), there is **no base-change step** to create
spikes. Merge is **per nominal time-slot, per symbol**:

| Slot state | Action |
|---|---|
| One source present | use it |
| Multiple agree within **τ ≤ 0.25%** | **keep all** (denser, richer line) |
| Multiple disagree > τ | keep the authoritative source for the line **and emit a reconciliation flag** |

- **Timestamps are real, not snapped.** Live-captured points land just before/after
  the nominal mark (14:03, not 14:00). Keep true timestamps; the 30/15-min grid is
  only a **bucketing rule for comparison**, never a snapping rule. Off-grid points
  are *more detail*, not a problem.
- **Disagreement is a feature.** Out-of-tolerance cells surface in a quiet
  reconciliation report `(symbol, slot, web_price, blob_price, Δ%)` — the owner's
  early-warning that the two apps diverge, instead of a silently averaged lie.
- **Breadcrumb / whole-book layers stay display-only.** The desktop's live-tip
  trail (whole-book value, base-dependent) is rebased on import like the web's own
  `session.tips` and spliced after the freshest real bar; it thickens the line but
  is **never** cross-checked (no per-symbol price to check).

**Graceful degradation:** on a schema-v2 blob (no per-symbol bars) the merge
simply has fewer sources and behaves as today. No web release is blocked on the
Python plan.

---

## Pillar 4 — Graded freshness truth-table

Inputs: data-age (device), blob-age, blob-completeness, market state,
minutes-since-open, last-pull-by-clock-hour. Applies to **start / manual / reset**
(prefill / login pull and reset pull); auto is the steady cadence below.

| Tier (condition) | Market state | Pull | Provider strategy |
|---|---|---|---|
| **Heavily outdated** — >1 market day missing **AND** newest blob >1 market day old | any | **1W + 1D** series, full (all graphs + holding values) | login: instant fan-out; else 16+ rule |
| **Minorly outdated** — on-device **and** blob ≤1 market day old, but older than 1h | open ≥30 min, **or** closed | **1D** series only (1W fills from it) | Twelve Data first, Tiingo overflow |
| ″ | open <30 min | **quotes only**; fill 1D from quote + breadcrumbs (no bars) | Twelve Data first |
| ″ — only NAV prices missing, no newer blob | n/a | **NAV quote + FX quote** only | TD; Tiingo NAV per existing gates |
| **Relatively fresh** — latest <1h old but older than last auto-update interval | open | market data; + NAV if missing | Twelve Data first |
| ″ | closed, NAV present | **FX value only** | cheap leg |
| **Blob-trust re-engage** (overlay) | any | if a leg was skipped expecting blob data and the decrypted blob lacked it → **re-run the matching row, ignoring the blob** | per row above |

**Two overlays that apply on every tier during market hours:**

- **Bar clock-hour gate (authoritative — wins over resume-backfill).** A 1D
  **bar** is pulled **at most once per clock hour** per symbol. After a pull at
  15:30, the next bar pull is allowed at **17:00** (the next `:00`), not before;
  breadcrumbs fill the line until then. This **supersedes** the existing 10-minute
  `DEFAULT_RESUME_BACKFILL_MS` re-pull *during* market hours — that 10-min resume
  now applies **only** to re-entry after the app was closed across an hour
  boundary. Aligning to `:00` also matches Tiingo's hourly reset and naturally
  dedupes across refreshes and devices.
  - Consequence (free): "open <30 min ⇒ no bars" falls out automatically, since
    the first bar cannot be due until a clock hour after ≥1 interval of session
    has elapsed. Gate the *first* bar on "≥1 bar-interval elapsed" so a 09:30 open
    does not chase a 10:00 bar off five minutes of trading.
- **Quote rolling TTL.** Quotes refresh on a **rolling 15-minute** window for a
  live feel (the existing `DEFAULT_CACHE_TTL_MS`).

**"Last auto-update" is the user-editable refresh interval.** The
"relatively fresh" trigger compares against the configured interval (default
15 min), so anything fresher than one interval is left alone — this is what makes
a seconds-later re-login a no-op. The interval remains **user-editable in
settings**.

---

## Pillar 5 — Provider spilling (under one authority)

**Steady rule:** Twelve Data leads, Tiingo takes genuine overflow. This already
holds.

**Latency optimisation for login + manual:** instead of dripping 8/min over
several minutes, **fan out across providers in parallel** for instant results —
e.g. for 20 symbols, **8 via Twelve Data + 12 via Tiingo at once**, rather than
8 + 8 + 4 over three minutes.

**Hard invariants (write these into the orchestrator; a refactor must not lose
them):**

1. **The Twelve Data leg is always one request of ≤8 symbols.** TD `time_series`
   is all-or-nothing; a >8 batch 429s wholesale. "Fan-out" means *across
   providers*, never a bigger TD batch.
2. **The "instant" trigger is ">2 TD-minutes of work" (>16 symbols).** Above it,
   spend Tiingo to parallelise. Below it, the normal lead/overflow spacing applies.
3. **Login is exempt from the spacing/16+ *latency* throttle** (it may spend
   Tiingo freely for instant first paint) **but never from the freshness ledger,
   the reservation authority, or the 429 breaker.**
4. **Never cut into the last 10 Tiingo credits** when the 16+ instant rule fires.
5. **No path is ever exempt from the hard provider caps.** Hard-refresh/reset may
   clear soft Tier-1 series backoff and freshness TTLs **only** — never the budget
   or the breaker. (This preserves the June burn-fix invariant verbatim.)

> The owner confirms this device **owns its full Tiingo allotment** (the shared
> cap was lowered so there is no competing second device for the 40 credits). The
> reservation ledger is therefore authoritative for this device; the cross-device
> hazard that motivated parts of the burn-fix no longer applies to credit
> accounting, though the 429 breaker stays as defence-in-depth.

---

## Pillar 6 — Exactly four mechanisms + regenerate-only interactions

**`kind` becomes the mechanism; scope/force lives in `opts`, never in a reused
label.** Verified consolidation from the trigger trace:

| Today | Folds into |
|---|---|
| `app.start()` prefetch (pre-unlock) + `startupRefresh` (post-unlock) | **`start`** — the two-step handshake; post-login fetches only the diff |
| `visibilitychange`, `pageshow`, `online` listeners | **`auto`** — all route through the one auto entry under the same gates |
| timer `scheduleNext` → `runScheduledRefresh("auto")` | **`auto`** |
| `maybeRefreshBlob` on its own `BLOB_CHECK_MIN_INTERVAL_MS` clock | **`auto`** sub-step, not its own timer |
| manual button, "force-fetch all", "via backup provider" | **`manual`** (force/backup as opts) |
| reset / "re-pull everything from scratch" | **`reset`** (forceAll as opts) |
| `primeStaleGraphPackages()` every round | **dissolved** into `pull()`'s freshness decision |

**The decisive seam — interaction = regenerate, never poll:**

- Split the curve builders into:
  - **`regenerate(range)`** — pure: recompute the curve from already-stored bars +
    fresh breadcrumbs. **Zero network.** This is what a **1D/1W toggle, a graph
    click/tap/hover** calls.
  - **`pull(ctx)`** — the only path that fetches, callable **only** by the four
    mechanisms.
- Concretely: `loadOrBuildSessionCurve` / `loadOrBuildWeekCurve` already separate
  "fetch-then-reconstruct" from "reconstruct-from-store" via a `needFetch` flag
  (`intraday.ts` ~459). Add a **`regenerateOnly` flag** that hard-forbids the
  fetch branch, and have all UI interaction paths pass it. Fetching is removed
  from the render path entirely.

**Acceptance:** toggling 1D/1W or clicking the graph issues **0** network
requests (assert in `web/test`). The only callers that can reach a fetcher are the
four mechanisms.

---

## Workstreams (priority order)

1. **Mechanism consolidation + `kind` cleanup** `[pillar-6]` — collapse all
   triggers into `start/auto/manual/reset`; route visibility/online/pageshow into
   `auto`. No behaviour change yet beyond labelling and a single funnel.
2. **`regenerate()` / `pull()` seam** `[pillar-6]` — add `regenerateOnly`; prove
   chart interaction is network-free.
3. **Stand up `data-orchestrator.ts`** `[pillar-1]` — move the pull *decision* in;
   dissolve `primeStaleGraphPackages` into it. Fetchers/reservation unchanged.
4. **Truth-table + clock-hour bar gate + rolling quote TTL** `[pillar-4]` — encode
   the table as a tested decision function; clock-hour gate wins over resume
   backfill during market.
5. **Two-step login handshake** `[pillar-2]` — prefetch predicts, post-decrypt
   reconciles the diff through the ledger; remove the loose double-pull.
6. **Provider fan-out for login/manual** `[pillar-5]` — bounded parallel spill with
   the five invariants; 16+ instant rule, 10-credit Tiingo floor.
7. **Multi-source 1W merge + reconciliation flags** `[pillar-3]` — per-slot,
   per-symbol, τ ≤ 0.25%, true timestamps, display-only breadcrumb layer.
   Degrades gracefully on schema-v2 blobs; fully lights up with the v3 export.
8. **Regression guards** — 1W detail-accretion not coarsened; no path bypasses
   budget/breaker; interaction stays network-free.

---

## Verification

- **Unit (`web/test`):** decision-function truth-table cases (each tier × market
  state); clock-hour bar gate (pull at 15:30 ⇒ none until 17:00; breadcrumbs fill);
  rolling quote TTL; regenerate-only issues zero fetches; login handshake dedupes
  Step 2 against Step 1; fan-out keeps TD ≤8 and never touches the last 10 Tiingo
  credits; reset clears soft backoff but not budget/breaker; 1W merge keeps all
  agreeing points and flags > τ disagreements without spiking.
- **Manual:** cold login mid-session (fresh, sliced, no double-pull); seconds-later
  re-login (zero pulls); range toggle + graph click (zero pulls); market-open hour
  boundary (bar pull only at `:00`).

---

## Explicit assumptions (flag if any is wrong)

1. Four mechanisms are the complete set the owner wants: `start`, `auto`,
   `manual`, `reset`.
2. Clock-hour bar gate **wins** over the 10-min resume-backfill during market;
   resume-backfill survives only for cross-hour re-entry after the app was closed.
3. "Last auto-update" = the **user-editable** refresh interval (default 15 min).
4. Login may spend Tiingo for instant first paint, exempt from spacing/16+ only,
   never from freshness/reservation/breaker.
5. This device owns its full Tiingo allotment (no competing second device for the
   40-credit cap).
6. Reconciliation tolerance τ = **0.25%**; bucketing grid 30-min default.
7. All Python-side changes (the v3 per-symbol export) live in the **separate**
   `docs/centralized_data_export_plan.md`; this web plan degrades gracefully
   without them.
