# Single-Brain Pull Plan

> **Status:** Implemented in v4.9.0 (feature bump). See the *Implementation notes*
> section at the end of this document for what shipped and where the as-built work
> diverged from this plan.
> **Source:** Diagnosis of the v4.6.0 fresh-device login polling log (2026-06-26).
> **Anchored against:** current `origin/main` **v4.8.0**. All line numbers below are
> v4.8.0. They will drift; re-grep the named symbol before editing. Symbols and
> root causes are structural and stable.
> **Audience:** the implementing agent. Be exact; cite the symbol, not just the line.

---

## Abstract (plain language — read this first)

The app has **two separate decision-makers** for "what price data should I fetch":

- **Brain A — the orchestrator** (`planPull` in `data-orchestrator.ts`). The clean,
  central, well-tested one. It governs the *refresh rounds* after you're logged in.
- **Brain B — the login warm-up** (`prefetchLiveData` in `app.ts`). A second, older
  one that fires the moment the login screen appears — *before* your data is
  decrypted — to race ahead and fetch prices while you type your passphrase.

The two were never merged. Brain B makes its own fetch decisions and then **fails to
tell Brain A's shared notebook (the "freshness ledger") what it actually fetched.**
So when Brain A wakes up a moment later, it looks at the notebook, sees nothing
recorded, assumes nothing was fetched, and **re-fetches everything Brain B already
pulled.** That double-pull — plus a couple of related budget mistakes — is what burned
**31 of 40 hourly Tiingo credits in ~40 seconds on a closed market** in the log.

**The fix is to make the two brains one.** Brain B becomes Brain A's *pre-decrypt
pass*. One planner, run twice: once before decrypt (do all the fetching) and once
after (assemble the total, and only re-fetch if something genuinely changed — a stale
file, a brand-new holding, or a currency surprise). The thing everyone said blocked
this — "the warm-up can't know each holding's currency before decrypt" — turns out to
be false: the currency is already known; it's just not written into the small
unencrypted plan file the warm-up reads. Fix that and the wall comes down.

Nine concrete changes (**C1–C9**) below. The first three are the cure; the rest close
specific holes the log exposed (NAV starved of budget, deferred fetches silently
forgotten, FX pulled three times, two lying log lines).

---

## The invariant we are restoring

> **One planner decides from one honest ledger, once, before decrypt. The
> post-decrypt step is assembly plus a reconcile that pulls only on a genuine change.
> Every mechanism that pulls MUST write its true effects into that ledger. No exempt,
> silent freelancers.**

Every fix below serves that one sentence. If a proposed change does not move toward it,
it does not belong here.

---

## Current architecture (verified against v4.8.0)

### Brain A — the orchestrator (correct, do not rewrite)
- `planPull(ctx: PullContext): PullPlan` — `data-orchestrator.ts:107`. Pure. Reads a
  `PullFreshness` ledger (`data-orchestrator.ts:41-61`) and returns `PullPlan`
  (`:85-91`) naming the legs (`weekBars/dayBars/quotes/nav/fx`).
- `gradedPull(input): GradedPull` — `freshness.ts:122`. The truth-table. The
  **heavily-outdated** trigger is `freshness.ts:125`:
  ```ts
  if (input.deviceDaysMissing > 1 && input.blobDaysOld > 1) {
    return { tier: "heavily-outdated", legs: allLegs() };
  }
  ```
- `reconcileHandshake(booked, truth): HandshakeDiff` — `login-handshake.ts:78`. The
  post-decrypt Step-2 dedup. Already supports `newlyDiscovered`
  (`login-handshake.ts:96`). Pure, unit-tested.
- `planFanout(input): FanoutPlan` — `provider-fanout.ts:115`. Provider split.
  `TIINGO_RESERVE_CREDITS = 10` (`:50`), `FANOUT_INSTANT_THRESHOLD = 16` (`:47`).
  **Login/start is already exempt from the reserve** (`isPriorityPull`, `:97`;
  consumed at `:156` `priority ? tiingoBudget : …`). So a login pull *may* legally
  spend Tiingo freely — C8 leans on this.

### Brain B — the login warm-up (the freelancer)
- `prefetchLiveData(): Promise<void>` — `app.ts:727`. Fired fire-and-forget at
  `app.ts:705` (`this.prefetchPromise = this.prefetchLiveData()`), **not awaited**.
- Decides via `planPrefetch(...)` (`app.ts:769`) + `planFanout({kind:"start", …})`
  (`app.ts:850`).
- Graph bars via `prefetchGraphBars(...)` — `app.ts:1391`, signature ends
  `currencyBySymbol: Map<string, string|null> = new Map()`. **The warm-up call passes
  no currency map** (defaults to empty); only the round-driven path passes
  `this.primingCurrencyMap()` (`app.ts:1331`).
- `primingCurrencyMap()` — `app.ts:1068`:
  ```ts
  private primingCurrencyMap(): Map<string, string | null> {
    const map = new Map<string, string | null>();
    for (const h of this.model?.holdings ?? []) {
      const symbol = h.priceSymbol ?? h.symbol;
      if (symbol) map.set(symbol, h.nativeCurrency ?? null);
    }
    return map;
  }
  ```
  **Key finding:** the native currency already exists on `h.nativeCurrency` in the
  decrypted model. It is simply absent from `PlannedSymbol`, so it is unavailable
  *pre-decrypt*. (C2 carries it through — it is not a new data source.)

### The two lies the warm-up tells the ledger
- **Lie A (quotes never priced).** `prefetchGraphBars` (empty currency map) →
  `primeQuotesFromBars` skips every symbol at `cache.ts:180`:
  ```ts
  const currency = existing?.currency ?? currencyBySymbol.get(symbol) ?? null;
  if (currency === null) continue; // cannot denominate a bare native price safely
  ```
  → quote cache stays empty → `buildPullFreshness` (`app.ts:1184`) sets
  `anyMarketMissing` (`app.ts:1206`) → `deviceDaysMissing = 10` (`app.ts:1226`) →
  with `blobDaysOld` also >1, `gradedPull` returns **heavily-outdated** → full re-pull.
- **Lie B (booked = intent, not fact).** `app.ts:895`:
  ```ts
  this.prefetchBooked = {
    symbols: [...prefetch.symbols, ...prefetch.navSymbols],
    predicted: plan.map((e) => e.symbol),
    fx: true,
  };
  ```
  Records *attempted* symbols. Omits the graph-backfilled market symbols (so the
  reconcile re-pulls them) and includes *deferred* NAVs (so the reconcile dedups them
  out → NAV stranded unless the blob rescues it).

### The post-decrypt ordering (verified)
`app.ts`: unlock/"painting cache" (`:2599`) → `reconcileHandshake(this.prefetchBooked,
{staleSymbols: staleFetchSymbols(...), fxStale: isFxStale(...)})` (`:4036`) →
`planRoundPull(kind, opts, now)` (`:4062`) → `runScheduledRefresh(session,"start",
{startup:true, kickoff:true})` (`:2744`).

### Blob recency (the C4 hook)
- `blobDaysOld(now)` — `app.ts:1155`; keys on `this.blobPublishedAt` (`:1103`), default
  `10` when unknown (`:1158`).
- `maybeRefreshBlob(session)` — `app.ts:2912` — already does the cheap probe
  `fetchBlobMeta(metaUrl)` (`:2923`) and sets `this.blobPublishedAt = meta.publishedAt`
  (`:2928`). **But every call is fire-and-forget** (`void this.maybeRefreshBlob(session)`
  at `:2620`, also `:2606`, `:2220`), so the kickoff round at `:4062` decides *before*
  the fresh meta lands.

### The deferral (the C9 hole) and NAV routing (the C8 hole)
- Deferred symbols are logged ("deferred to the post-unlock kickoff", `app.ts:876-881`;
  "N still deferred", `app.ts:4225`) but there is **no explicit retry queue** — the
  comment at `app.ts:864-865` admits it relies on "its per-symbol cache TTL re-pulls
  them". In the log the deferred NAVs were only saved because the blob carried
  `nav_prices`.
- NAVs are pinned to Twelve Data by policy: `app.ts:867` `const twelveSymbols =
  [...fanout.twelveData, ...prefetch.navSymbols]`, comment `:861-865` ("NAV funds
  always warm on the cheap Twelve Data primary … so the scarce hourly Tiingo budget is
  reserved"). Tiingo **can** serve NAV EOD prices; this is a budget *policy*, and it
  starves NAV when the 1D graph backfill has already eaten the TD minute.

### The plan shape (the C2 target)
`PlannedSymbol` — `cache.ts:771-780`: `symbol`, `priceType`, `assetClass`, `sizeEur`.
**No currency field.** Read `readSymbolPlan` (`:789`), write `writeSymbolPlan` (`:808`).

### NAV-on-the-week mechanics (the C5 target)
- `navBarsFromQuotes(quotes, navSymbols)` — `week.ts:215` — stamps **one** bar per
  fund from a quote's `valueDate`+`price` (`week.ts:223`). One day only.
- The week history comes from the gap-fill in `buildLiveWeekCurve` via
  `navBackfillSymbols`/`fetchNavBars`/`onNavBackfill` (`week.ts` options `:241/:247/:270`),
  gated off by `regenerateOnly` (`:279`).
- `persistFundNavBars(quotes)` (`app.ts:5057`, called at `app.ts:5060` via
  `navBarsFromQuotes`) is where the live NAV **quote** is turned into the daily bar —
  the headline currently reads NAV from a `Quote`, not from a bar tip.

### Budget caps (authoritative numbers)
- Twelve Data: `FREE_TIER.creditsPerMinute = 8`, `creditsPerDay = 800` (`quotes.ts`).
- Tiingo (web): `WEB_HOURLY_CAP = 40`, `WEB_DAILY_CAP = 800` (`tiingo-gate.ts`).
- Single authority: `reservation.ts` — `twelveDataAvailable` (`:59`),
  `tiingoAvailable` (`:77`), `ledgerReservation` (`:127`).

---

## The changes (C1–C9)

Each: **Goal · Root cause (anchored) · Change · Failure modes to avoid · Tests.**

### C1 — One planner, two passes (the spine)
- **Goal.** The login warm-up stops being a second brain; it becomes the
  orchestrator's **pre-decrypt pass**. The kickoff is the **post-decrypt pass**. Both
  read/write one ledger.
- **Root cause.** `prefetchLiveData` (`app.ts:727`) decides via `planPrefetch`
  (`:769`) and never calls `planPull`; the kickoff decides via `planRoundPull` (`:4062`)
  from a ledger the warm-up never wrote to.
- **Change.**
  1. Introduce a `phase: "pre-decrypt" | "post-decrypt"` notion the planner honors.
     Concretely, extend `PullContext` (`data-orchestrator.ts:72`) with a
     `currencyKnown: boolean` (true once `nativeCurrency` is available — see C2) and a
     `phase` tag, **without** changing `gradedPull`'s math.
  2. Route the warm-up's fetch decision through `planPull({kind:"start",
     phase:"pre-decrypt", …})`. Pass 1 runs the **currency-free + currency-via-plan**
     legs: `weekBars`, `dayBars`, `quotes` (now primeable, C2), `nav` (C5/C8), `fx`.
  3. The post-decrypt kickoff stays `planPull({kind:"start", phase:"post-decrypt"})`
     but now its ledger already reflects Pass 1, so `gradedPull` no longer sees
     `anyMarketMissing`.
- **Critical discipline.** The planner must treat **"currency unknown"** (genuine
  first-ever login, no saved plan) as a *first-class* state — **not** as "data
  missing". A `currencyKnown === false` Pass 1 may pull bars but must **not** inflate
  `deviceDaysMissing` to 10 from an empty quote cache (that is the very bug). Gate the
  `anyMarketMissing → 10` path (`app.ts:1206/1226`) on `currencyKnown`.
- **Failure modes to avoid.**
  - Do **not** call `planPull` twice with the same nowMs and let both pull bars — Pass
    2 must see Pass 1's bars on the ledger and the clock-hour gate
    (`data-orchestrator.ts:143-158`) must keep `dayBars` off.
  - Do **not** route the warm-up through `runScheduledRefresh` directly — keep the
    fast fire-and-forget path (`app.ts:705`); only its *decision* moves to `planPull`.
- **Tests.** New `data-orchestrator.test.ts` cases: (a) Pass-1 pre-decrypt with
  `currencyKnown=false` and empty quote cache does **not** grade heavily-outdated;
  (b) Pass-2 post-decrypt after a Pass-1 that booked the 12 market symbols returns
  `legs.quotes=false, dayBars=false` (within TTL). Assert no leg double-fires across
  the pair.

### C2 — Carry `nativeCurrency` in the unencrypted plan
- **Goal.** Make Pass-1 quote-priming actually land, so the ledger is honest.
- **Root cause.** `PlannedSymbol` (`cache.ts:771-780`) lacks currency;
  `primingCurrencyMap()` (`app.ts:1068`) can only build the map from the decrypted
  `this.model`. The warm-up passes an empty map (`app.ts:1391` default) →
  `primeQuotesFromBars` skips all (`cache.ts:180`).
- **Change.**
  1. Add `nativeCurrency: string | null` to `PlannedSymbol` (`cache.ts:771`).
  2. Populate it in `writeSymbolPlan` callers from `h.nativeCurrency` at logoff/refresh
     (the same field `primingCurrencyMap` already reads).
  3. Tolerate it in `readSymbolPlan` (`cache.ts:797-802`) with a safe default
     (`typeof e.nativeCurrency === "string" ? e.nativeCurrency : null`).
  4. Build a pre-decrypt currency map from the plan and pass it into the warm-up's
     `prefetchGraphBars` call (replace the empty-map default).
- **Failure modes to avoid.**
  - A stale plan currency (user changed denomination): treat the plan value as a
    *prediction*, corrected post-decrypt by C6. Never let it silently misprice the
    headline — the headline waits for the decrypted model regardless.
  - Back-compat: an old plan with no `nativeCurrency` → `null` → C1's `currencyKnown`
    is false for that symbol → falls back to post-decrypt priming. No crash.
- **Tests.** `cache.test.ts`: round-trip a plan with/without `nativeCurrency`;
  `readSymbolPlan` defaults legacy entries to `null`. A priming test: bars + a
  USD plan currency → `primeQuotesFromBars` writes a quote (no skip).

### C3 — `prefetchBooked` records true fetches, not intent
- **Goal.** The reconcile dedups against reality.
- **Root cause.** `app.ts:895` books `[...prefetch.symbols, ...prefetch.navSymbols]`
  (intent), omitting graph-backfilled symbols and including deferred NAVs.
- **Change.** Build `prefetchBooked.symbols` from the **actual** filled set:
  `fanout.twelveData ∪ fanout.tiingo ∪ (graph-primed market symbols) ∪ (NAVs actually
  fetched)`, and **exclude** `fanout.deferred`. Keep `predicted` = full plan universe
  (`plan.map(e=>e.symbol)`) for the `newlyDiscovered` labeling.
- **Failure modes to avoid.**
  - Don't book a symbol whose fetch threw — book only confirmed fills, or the
    reconcile will skip a genuinely-missing symbol.
  - Deferred NAVs must flow to C9's queue, not be silently dropped from `booked`.
- **Tests.** `login-handshake.test.ts`: booked = filled set excluding deferred ⇒
  reconcile re-pulls deferred NAV; booked includes graph symbols ⇒ reconcile does
  **not** re-pull the 12 market symbols (the log's +12 dup is gone).

### C4 — Consult blob metadata before the heavy spend
- **Goal.** The planner sees *remote* blob recency before deciding, so it doesn't pull
  what a fresh blob already covers.
- **Root cause.** `maybeRefreshBlob` (`app.ts:2912`) sets `blobPublishedAt` (`:2928`)
  but is always `void`-called (`:2620` etc.), so `blobDaysOld` (`:1155`) is stale at
  the kickoff decision (`:4062`).
- **Change.** Extract the cheap meta probe (`fetchBlobMeta` → set `blobPublishedAt`)
  into an awaitable step and `await` it in the kickoff **before** `buildPullFreshness`
  / `planRoundPull`. Leave the heavy blob *download* fire-and-forget.
- **Failure modes to avoid.**
  - **Re-entrancy:** don't `await` the full `maybeRefreshBlob` (it triggers a
    re-render / price refresh) — await *only* the meta probe. Split the function.
  - Network hang: the probe must be time-boxed; on timeout fall back to the current
    `blobDaysOld` default, never block the kickoff indefinitely.
- **Tests.** A kickoff with a fresh remote meta (blobDaysOld=0) and an empty device
  must **not** grade heavily-outdated; a probe timeout falls back to today's behavior.

### C5 — Bars-first for NAV
- **Goal.** On a fresh device, the 1W NAV line is correct in one shot; no wasted quote.
- **Root cause.** Today NAV is quote-first: `navBarsFromQuotes` (`week.ts:215`) stamps
  one day; the week is filled only if the later gap-fill runs. `persistFundNavBars`
  (`app.ts:5057`) reads the NAV from a `Quote`.
- **Change.**
  - Fresh device / week **not** covered through latest settled session → pull **1W NAV
    daily bars** (the gap-fill path, `week.ts` `fetchNavBars`), whose last bar **is**
    the current settled NAV. **Skip the separate NAV quote.**
  - Week already covered → pull nothing.
  - Narrow exception: week cached *except* today's brand-new settled NAV → a single
    NAV quote top-up is cheaper.
  - Headline must read the NAV price from the **bar tip** when the quote is skipped.
- **Failure modes to avoid.**
  - **Headline regression:** the total currently expects a `Quote`. Wiring the headline
    to read a bar tip (C5 pre-req) must preserve `valueDate` semantics — a NAV's tip is
    a *settled* value, not a live tick. Don't mark it "live".
  - Money-market/pinned-$1 funds must stay excluded (they already are — not in
    `lastNavSymbols`).
- **Tests.** `week.test.ts`: fresh store + NAV bars ⇒ full week curve with correct tip,
  zero quote credits. Headline test: bar-tip NAV equals the prior quote-derived total.

### C6 — Post-decrypt reconcile = genuine-change only, + currency-mismatch
- **Goal.** Keep the rare, legitimate double-pull (stale blob / new holding / currency
  surprise); kill the bogus one.
- **Root cause.** `reconcileHandshake` (`login-handshake.ts:78`) is correct but
  currency-blind; it compares *symbols*, not currencies.
- **Change.** Extend `PostDecryptTruth` (`login-handshake.ts:41`) with an optional
  `currencyMismatches: string[]` (symbols whose decrypted `nativeCurrency` ≠ the plan's
  assumed currency from C2). Add them to the diff `symbols` and mark them in `reason`.
- **Failure modes to avoid.**
  - Don't conflate "newly-discovered" with "currency-mismatch" — they are distinct log
    reasons. A USD-only book should produce **zero** mismatches in steady state.
- **Tests.** `login-handshake.test.ts`: a symbol whose plan currency was USD but
  decrypts to EUR ⇒ appears in the diff; identical currency ⇒ no diff.

### C8 — NAVs may overflow to Tiingo
- **Goal.** Stop deferring NAVs when TD's minute is spent and Tiingo is idle.
- **Root cause.** `app.ts:867` pins NAV to TD; the 1D graph backfill ate the 8 TD/min
  (log L10) so NAVs hit `0/min` and deferred (log L18) while Tiingo sat at ~13/40.
- **Change.** Let the login/start NAV pull spill to Tiingo via the **existing**
  priority path: include NAV symbols in (or alongside) the `planFanout` input so that,
  when `twelveDataSpendable` is exhausted and `tiingoSpendable>0`, NAVs route to Tiingo.
  Login is already reserve-exempt (`provider-fanout.ts:156`), so no cap change needed.
- **Failure modes to avoid.**
  - Keep the "never NAV via Tiingo" rule for the **intraday graph-bar backfill** (NAVs
    have no intraday series) — C8 is about NAV *EOD price/bar*, not graph bars.
  - Respect `reservation.ts` clamps — never bypass `tiingoAvailable` (`:77`).
- **Tests.** `provider-fanout.test.ts` (or a new NAV-routing test): TD spendable = 0,
  Tiingo spendable > 0, kind="start" ⇒ NAVs land in the Tiingo leg, none deferred.

### C9 — The deferred set becomes a tracked work-queue
- **Goal.** A deferral is a guaranteed-drained promise, never a hope rescued by luck.
- **Root cause.** No retry queue; `app.ts:864-865` relies on "per-symbol cache TTL".
  The next burst round re-planned from the ledger and dropped the NAVs (log L33/L39)
  once the blob satisfied them.
- **Change.** Persist a `deferredQueue` (symbols + why) on the instance. The next round
  must (a) drain it explicitly, or (b) clear entries the arriving blob satisfied **with
  a logged reason** (`"deferred X cleared by blob nav_prices"`). Never let an entry
  vanish unlogged.
- **Failure modes to avoid.**
  - Don't double-pull a symbol the blob already satisfied — clear-with-reason, don't
    re-fetch.
  - Bound the queue and its retries (avoid an infinite burst if a symbol never fills).
- **Tests.** A deferred NAV with **no** blob coverage ⇒ next round pulls it; with blob
  coverage ⇒ cleared with a logged reason, not re-pulled.

### C7 — Disambiguate two misleading log lines (pure logging)
- **Goal.** The log stops lying; no flow change.
- **Root cause / change.**
  - The warm-up "and primed those quotes" line must report the **real** primed count
    (today it claims success even when `primeQuotesFromBars` skipped all — `cache.ts:180`).
  - The "reused the exported week sleeve (… 0 credits)" line (the v4.6.0 L31 you
    flagged) must distinguish **blob-served** vs **stored-cache-reconstructed** vs
    **live-tip-only** in `week.ts`'s curve path. Today `todaySlice` may come from
    either a blob springboard or a store reconstruction and both log the same.
- **Tests.** Logging assertions: primed-count line equals the number of symbols
  actually written; the week-source line matches the branch taken.

---

## How C1–C9 kill every bug in the v4.6.0 log

| Log bug | Evidence (v4.6.0 line) | Root cause (v4.8.0 anchor) | Killed by |
|---|---|---|---|
| **1. 12 market symbols re-pulled at reconcile** | L26 `Tiingo filled 12` (+12) | Lie A (`cache.ts:180` skip → `app.ts:1226` =10 → `freshness.ts:125`) + Lie B (`app.ts:895`) | **C1+C2+C3** |
| **2. Warm-up fetches before the blob lands** | L8–16 vs L29 | `maybeRefreshBlob` void (`app.ts:2620`) decides after kickoff (`:4062`) | **C4+C1** |
| **3. FX pulled 3× in 4s** | L9 spot, L12 1D, L15 1W | Three independent FX fetch paths, no coordinator | **C1** (FX booked once; spot from series tip; intraday only on genuine need) |
| **4. NAVs deferred then dropped** | L18 `0/min`, L28 `5 deferred`, L39 `0/0` | NAV pinned to TD (`app.ts:867`) starved by 1D backfill; deferral untracked (`:864-865`) | **C8 + C9 + C5** |
| **5. Bars vs NAV fight the TD minute** | L10 TD 7/8 → L18 NAV 0/min | Two brains race one budget, no sequencing | **C1 + C8** |
| **6. 60s burst / false heavily-outdated** | L21 tier, L28 burst | Empty quote cache fakes 10 days (`app.ts:1206/1226`) | **C2+C3** |
| **Headline: 31/40 Tiingo in ~40s** | L26 `31/40` | = Bug 1 + Bug 6 | **C1+C2+C3** |
| **Ambiguous "week sleeve" line** | L31 | `week.ts` curve source conflated | **C7** |

Five of six bugs (1, 3, 5, 6, half of 4) are the **same disease**: the warm-up lies to
the ledger. **C1+C2+C3** alone fix 1, 3, 6 and de-risk 4/5. C4 fixes 2; C5/C8/C9 finish
4/5; C6 is the rare-surprise net; C7 is cosmetic honesty.

---

## Sequencing

- **Phase 1 (the spine — biggest saving):** C2 → C1 → C3. (C2 first: it unblocks C1's
  honest priming.)
- **Phase 2 (NAV correctness + budget sanity):** C5, C8, C9.
- **Phase 3 (recency + safety + hygiene):** C4, C6, C7.

Land each phase behind its own tests; do not start Phase 2 until Phase 1 turns the
reconcile into a no-op on a steady-state re-login.

## Pre-reqs to confirm before coding

1. **C2 carrier.** Confirm every `writeSymbolPlan` call site has the decrypted
   `h.nativeCurrency` in scope at write time (logoff + each successful refresh).
2. **C5 headline-from-bar-tip.** Confirm `persistFundNavBars` (`app.ts:5057`) and the
   headline total can source NAV from a bar tip with correct `valueDate`/settled
   semantics, not a `Quote`.
3. **C1 model availability.** Confirm `this.model` is populated at the reconcile point
   (`app.ts:4036`) for the post-decrypt currency check (C6).
4. **Prime timestamp.** Stamp primed quotes with the **bar's** newest instant, not
   `Date.now()` (avoid a false-fresh quote age feeding `quoteAgeMs`).
5. **C8 reserve semantics.** Confirm `planFanout` priority path (`provider-fanout.ts:156`)
   plus `tiingoAvailable` (`reservation.ts:77`) express "NAV may use Tiingo overflow on
   login" without weakening the non-login market-bar reserve.
6. **C4 split.** Confirm the meta probe can be separated from `maybeRefreshBlob`'s
   render/refresh side effects so it is safely awaitable.

---

## Wrap-up (plain language)

If you only remember one thing: **the warm-up and the orchestrator must become a single
brain that writes down everything it fetches.** Right now the warm-up fetches in
secret, the orchestrator can't see it, and so it pays twice. Make the warm-up the
*first pass* of the orchestrator, give it the one missing fact (each holding's
currency, which we already have — we just forgot to save it), and the orchestrator's
existing, well-tested dedup does the rest. After that, the post-decrypt step only
spends money when something *genuinely* changed since you last logged in — a stale
data file, a holding you just bought, or a currency that isn't what we assumed. That is
exactly the behavior you wanted, and it is mostly *already built* — we are removing
lies from the ledger, not bolting on new machinery.

The remaining changes are small, targeted repairs of holes the log exposed: let NAVs
borrow the idle Tiingo budget instead of starving (C8), remember what we deferred
instead of hoping the blob saves us (C9), fetch the whole NAV week in one shot instead
of one day plus a gamble (C5), look at the data file's freshness *before* spending
(C4), and make two lying log lines tell the truth (C7). Together they take a login that
burned 31 of 40 hourly credits in 40 seconds down to the handful of pulls that were
ever actually needed.

---

## Implementation notes (as built — v4.9.0)

This plan shipped in **v4.9.0** (feature bump; see `CHANGELOG.md`). Each change below
notes the symbols touched and any honest divergence from the plan as written. Line
numbers in the plan above are v4.8.0 anchors and have since drifted — re-grep the named
symbol.

- **C1 — currency-known gate, routed through `planPull`.** The login warm-up now
  literally runs its leg decisions through the shared `planPull` planner, so it can
  never again diverge from the kickoff/auto pulls. `buildPrefetchFreshness` +
  `planWarmupPull` (`web/src/app.ts`) build a `PullContext` for the warm-up and gate
  the quotes / NAV / day-bar / week-bar legs on the same `planPull` verdict the other
  pulls use; a missing leg is emptied to `[]` before `planPrefetch` routing. The pure
  `deviceDaysMissing` helper (`web/src/data-orchestrator.ts`) is the single
  market-gap-to-device-age mapping shared by `buildPullFreshness` and
  `buildPrefetchFreshness`, so both pulls grade staleness identically. A
  `currencyKnownForPrefetch()` gate keeps a pre-decrypt empty cache from faking a
  10-day gap (an unknown-currency entry can't inflate to the "heavily outdated"
  bucket), and the decision-neutral `phase` / `currencyKnown` fields on `PullContext`
  thread the warm-up phase to downstream planners.
  - **Faithfulness:** this resolves the earlier divergence where the warm-up only
    *approximated* the planner via the honest-ledger pair (C2 priming + C3 booking).
    The warm-up still keeps `planPrefetch` for symbol/provider routing; `planPull` is
    layered on top as the leg-gate authority, so the observable invariant — the second
    pull only fetches what the first genuinely missed — is now enforced by the same
    code path rather than a parallel one. FX is not re-gated because the warm-up's FX
    pull is already interval-gated on the same cadence as `planPull`'s overlay.
- **C1b — NAVs pull exactly like stocks.** The moment a NAV needs a price the primary
  couldn't supply, it takes the identical routing, fallback, login fast-track and
  ">16 queued" path as a stock. `planFanout` (`web/src/provider-fanout.ts`) merges
  NAVs into one unified sleeve (the old NAV-only `allocateNav` split is gone; NAV
  buckets are now descriptive partitions of the same TD-first / Tiingo-spill
  decision), so a non-priority sleeve over the 16-symbol instant threshold spills
  NAVs to Tiingo just like stocks. `runTiingoFallback` (`web/src/tiingo-fallback.ts`)
  replaced the NAV-only peer-confirmation/canary timing path with one candidate loop
  over all symbols gated by `marketSymbolEligible` + `selectWithinBudget`; bounded
  re-probing for a fund Tiingo has nothing fresher for now comes from the same
  per-symbol "nothing newer" cooldown that already governs a closed-market stock.
- **C2 — honest priming.** Warm-up priming carries each symbol's `nativeCurrency` into
  the quote cache (`primeQuotesFromBars` / `PlannedSymbol.nativeCurrency` in
  `web/src/cache.ts`) instead of dropping every symbol on the old `currency === null`
  guard, so primed quotes survive into the post-decrypt freshness check.
- **C3 — honest booking.** Prices actually fetched during warm-up are booked into the
  freshness ledger so they are not later re-counted as missing.
- **C4 — blob-meta probe before the kickoff.** A module-level `withTimeout` helper and
  a `refreshBlobMeta` method (`web/src/app.ts`) refresh the shared blob metadata
  (bounded by `BLOB_META_PROBE_TIMEOUT_MS = 2500`) before `planRoundPull`, with a
  session-validity recheck so a stale-but-already-written price is seen and not
  re-fetched. Kickoff-only.
- **C5 — bars-first NAV.** Root cause: `primeQuotesFromBars` stamped `valueDate: null`,
  so `priceForHolding` (`web/src/compute.ts`) rejected bar-primed NAV quotes as stale
  and the headline fell back to the export. Fix: `primeQuotesFromBars` gained a
  `navValueDateSymbols` set that stamps NAV quotes with the bar day's settled
  `valueDate` (and `marketOpen: false`); `prefetchNavWeekBars` pulls 1W daily-NAV bars
  for week-stale moving funds via `wrapDailyNavFetcher(makePriceBarFetcher(...))`,
  books them, and drops them from the NAV quote leg.
- **C6 — currency-mismatch handshake.** The login handshake
  (`web/src/login-handshake.ts`) reconciles currency mismatches between cached and
  freshly observed quotes.
- **C7 — truthful log lines.** The two misleading log lines now report what actually
  happened.
- **C8 — NAV provider routing (now unified, see C1b).** `planFanout`
  (`web/src/provider-fanout.ts`) routes NAV symbols through the *same* sleeve as
  stocks: Twelve Data first (up to remaining TD budget), spilling to Tiingo whenever a
  priority round or a >16-symbol non-priority sleeve would spill a stock, otherwise
  deferring. The earlier NAV-only `allocateNav` split was removed in C1b; the
  `navTwelveData` / `navTiingo` buckets are now descriptive partitions of the one
  unified decision.
- **C9 — accounted deferral queue.** The deferred-symbol logic is extracted to a pure
  `DeferredQueue` module (`web/src/deferred-queue.ts`, `DEFERRED_QUEUE_MAX = 64`,
  `DEFERRED_MAX_ATTEMPTS = 4`) so it is unit-testable and so no deferred entry vanishes
  unlogged: blob-satisfied entries are cleared (logged), retries are capped, and the
  queue is size-bounded (oldest evicted). `drainDeferredQueue` deliberately does *not*
  re-inject symbols into `refreshPrices` — the normal round already re-pulls stale
  uncached symbols; the queue exists for honest accounting, not re-fetching.

**Tests added:** C1 (`data-orchestrator.test.ts`), C5 (`cache.test.ts`,
`compute.test.ts`), C6 (`login-handshake.test.ts`), C8/C1b
(`provider-fanout.test.ts`, `tiingo-fallback.test.ts`), C9 (`deferred-queue.test.ts`).
Full web suite green (typecheck + 1089 vitest tests + build); Python suite unaffected
(web-only change).
