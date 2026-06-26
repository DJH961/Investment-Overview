# Single-Brain Pull Plan

> **Status:** Proposed (planning only — no code yet).
> **Origin:** Diagnosis of the v4.6.0 fresh-device login polling log (2026-06-26).
> Line references below are against the v4.6.0 tree; `main` has since advanced,
> so re-anchor exact line numbers before implementing. The *mechanisms* and
> *root causes* described here are structural and still apply.

## The one-sentence thesis

There is **one disease**: pulls are decided by several independent code paths
that do **not** report their true effects into the shared freshness ledger, so
the central orchestrator (`planPull`) — which is correct in isolation — is forced
to decide on a dishonest ledger and re-pulls work that was already done. The cure
is **one planner, fed an honest ledger, deciding once before decrypt** — and only
ever re-pulling **after** decrypt on a *genuine* change.

## The two brains (why the bug exists at all)

The app currently has **two decision-makers** that never merged:

- **Brain A — the central administrator (`planPull`, `data-orchestrator.ts`).**
  Governs the *refresh rounds* (start / auto / manual / reset). Pure, ledger-keyed,
  designed precisely to prevent duplication. It works.
- **Brain B — the login warm-up (`planPrefetch` + `planFanout`, `app.ts`).**
  A separate, older path that fires the instant login begins — *before decrypt* —
  to race ahead and fetch. It makes its **own** fetch decisions, **never calls
  Brain A**, and **does not write its true effects into the ledger Brain A reads.**

The warm-up was never retrofitted to route through the administrator. The excuse
was "the warm-up runs before decrypt, so it doesn't know each holding's currency,
which Brain A needs to denominate quotes." **That excuse is false:** an
instrument's trading currency is a property of the instrument, not a secret of the
portfolio. It is only unreachable pre-decrypt because it happens to be filed inside
the encrypted holdings model. Hoist it into the unencrypted symbol plan and the
boundary moves.

## What actually moves the decrypt boundary

Once currency is in the unencrypted plan, ask what genuinely still needs decrypt.
**Not the prices.** Bars never needed it; quotes only needed *currency*; NAV class
(`priceType`) is already in the plan. The **only** thing decrypt truly unlocks is
your **quantities** — needed to multiply prices into a headline total, *not* to
decide what to fetch. So the planner can run as **two passes of one function**:

- **Pass 1 (pre-decrypt) — do ALL the pulling.** 1D bars, 1W bars, quotes, NAV
  bars, FX. Everything network, decided once, booked honestly into the ledger.
- **Pass 2 (post-decrypt) — assembly + reconcile only, near-zero network.**
  Multiply the already-fetched prices by the now-known quantities and paint. Then
  reconcile the decrypted *truth* against the ledger and pull **only a genuine
  diff** (see C6).

One function, two passes, one ledger. They cannot diverge by construction — change
a freshness rule and both passes inherit it. The discipline required: the planner
must treat **"currency unknown"** (true only on a genuine first-ever login on a new
device, before any plan is saved) as a first-class state, and *not* mistake it for
"data missing."

## The genuine-surprise safety net (already built — just mis-fed)

`reconcileHandshake` (`login-handshake.ts`) already exists to pull **only** on a
real post-decrypt surprise, deduped against Pass 1 via the ledger. It already
handles:

- **Stale blob** — decrypted truth staler than predicted → legit pull.
- **New holding** — a symbol the prediction never knew (`newlyDiscovered`) → legit
  pull, logged as newly-bought.

It is **not over-designed** — it over-fires today only because Pass 1 lies to it
(reports *intended* symbols, and its quote-prime silently no-ops for lack of
currency), so the ledger shows fetched work as missing. Make Pass 1 honest and the
reconcile fires only on real change. We add **one** missing case (C6): a
**currency-mismatch** check, for the rare "a EUR holding appears" surprise.

A genuine post-decrypt double-pull (stale blob / new holding / currency mismatch)
is **acceptable and expected to be rare** — it must NOT happen the way it did in
the v4.6.0 log, where 12 already-fetched market symbols were re-pulled on false
input.

---

## The changes (C1–C9)

### Structural spine (one root cause)

**C1 — Merge the two brains into one planner, run as two passes.**
The login warm-up becomes the orchestrator's **pre-decrypt pass**; the kickoff
becomes the **post-decrypt pass**. One function, two passes, one shared ledger.
FX, quotes, NAV and bars are all **booked once** by this single planner — no code
path fetches a resource the planner didn't decide.

**C2 — Hoist native currency into the unencrypted symbol plan.**
Written at logoff (currency known from the decrypted model), read at next login
pre-decrypt. Lets Pass 1's quote-prime actually land instead of silently
no-op'ing, so the ledger reflects reality. *Pre-req: add `nativeCurrency` to the
`PlannedSymbol` shape and to plan read/write.*

**C3 — Pass 1 books what it TRULY fetched, not what it intended.**
Record actual fetches (include graph-backfilled symbols, exclude anything
deferred). The ledger stops lying to the reconcile.

### Supporting

**C4 — Check blob freshness before spending.**
`await` the cheap blob metadata probe (already inside `maybeRefreshBlob`) **before**
the planner decides, so `blobDaysOld` reflects *remote* recency and the planner
doesn't fetch what the blob already carries. *Care: avoid `refreshPrices`
re-entrancy.*

**C5 — Bars-first for NAV.**
A 1W NAV daily-bar fetch delivers the **whole week AND the current settled tip** in
one credit; the last bar *is* the current NAV (NAV publishes ~once/day, so there is
no intraday tick a quote would add). Therefore:
- Fresh device / week not covered → pull **1W NAV bars**, no separate quote.
- Week already covered through latest settled day → pull nothing.
- Quote-only is worth it in *one* narrow case: the week is cached except today's
  brand-new settled NAV → a single fresh point.
*Pre-req: the headline total must read the NAV price off the **bar tip** instead of
a `Quote` object — a small, contained wiring change.*

**C6 — Post-decrypt reconcile = genuine-change only, plus a currency check.**
Keep `reconcileHandshake` for stale-blob and new-holding (already built). **Add** a
currency-mismatch guard: if a decrypted holding's currency differs from what the
plan assumed (the "an EUR holding appears" case — shouldn't happen given a USD-only
book, but cheap insurance), re-mark/re-pull just that symbol.

**C7 — Disambiguate two misleading log lines (pure logging, no flow change).**
- The "primed those quotes" line must report the **real** primed count (today it
  claims success even when the prime no-op'd).
- The "reused the exported week sleeve" line must distinguish **blob-served** vs
  **stored-cache-reconstructed** vs **live-tip-only**, so a cache reconstruction is
  never reported as a blob springboard.

**C8 — NAVs may overflow to Tiingo.**
Drop the Twelve-Data-only pin on NAVs. NAVs are *policy*-restricted to TD to
"reserve Tiingo for market bars" — but Tiingo serves mutual-fund EOD NAV prices
fine; the TD-only rule is the direct cause of the v4.6.0 deferral. On login (and
whenever TD's minute budget is exhausted while Tiingo has hourly headroom), route
NAVs to whichever pipe has budget. *(The "never NAV via Tiingo" rule legitimately
remains for the intraday **graph bar** backfill — NAVs have no intraday series.)*

**C9 — The deferred set becomes a tracked work-queue.**
A deferral must be an explicit promise the next round is **guaranteed** to drain —
or that an arriving blob explicitly satisfies and **clears with a logged reason** —
never a silent hope rescued by luck. Today the deferred NAVs were only saved
because the blob happened to carry `nav_prices`; on a config without them they would
be stranded.

---

## How C1–C9 kill every bug in the v4.6.0 log

| Log bug | Evidence (v4.6.0 line) | Root cause | Killed by |
| --- | --- | --- | --- |
| **1. 12 market symbols re-pulled at reconcile** | L26 `Backup (Tiingo) filled 12` (+12 credits) | Empty quote cache (prime no-op) + intent-not-actual booking → ledger shows fresh symbols as missing | **C1 + C2 + C3** |
| **2. Warm-up fetches before the blob lands** | L8–16 warm-up vs L29 blob arrives | No remote-recency check before the spend | **C4 + C1** |
| **3. FX pulled 3× in 4s** | L9 spot, L12 1D(`1hour`), L15 1W(`1day`) | Three independent paths each fetch FX; spot not derived from a series tip | **C1** (FX booked once, spot from tip, intraday only on genuine need) |
| **4. NAVs deferred then effectively dropped** | L18 `deferred 5 … 0/min`, L28 `5 still deferred`, L39 `NAVs 0/0` | (a) NAVs TD-only + 1D graph ate TD's minute → starved; (b) deferral untracked, rescued only by blob | **C8** (overflow to idle Tiingo) + **C9** (tracked queue) + **C5** (whole week in one shot) |
| **5. Bars vs NAV fighting over the TD minute** | L10 TD 7/8 credits → L18 NAV `0/min` | Two brains race the same scarce budget with no sequencing | **C1** (one planner sequences + allocates) + **C8** |
| **6. Pointless 60s startup burst / false "heavily-outdated"** | L21 `heavily-outdated`, L28 burst | Empty quote cache fakes "10 days missing" → false heavy tier → panic re-pull | **C2 + C3** (prime lands → no false-heavy → no burst) |
| **Headline: 31/40 hourly Tiingo credits in ~40s on a closed market** | L26 budget `31/40` | = Bug 1 (dup 12) + Bug 6 (false-heavy burst) | falls out of **C1+C2+C3** |
| **Ambiguous "reused the week sleeve" line** | L31 | Logger conflates blob-springboard with cache reconstruction | **C7** |

Five of the six bugs (1, 3, 5, 6, and half of 4) share the **single** root cause —
the warm-up being a parallel brain that lies to the ledger. **C1 + C2 + C3** alone
eliminate Bugs 1, 3, 6 and de-risk 4 and 5. C4 finishes 2; C5/C8/C9 finish 4 and 5;
C6 is the rare-surprise net; C7 is cosmetic honesty. No new special-case guards —
every fix restores the same invariant.

---

## Sequencing

- **Phase 1 (the spine, biggest credit saving):** C1 + C2 + C3. Eliminates the dup
  12-symbol re-pull and the false heavily-outdated burst.
- **Phase 2 (NAV correctness + budget sanity):** C5 + C8 + C9. Fresh-device week
  graph correct, NAVs never starved or forgotten.
- **Phase 3 (recency + safety + hygiene):** C4 + C6 + C7.

## Pre-reqs to confirm before coding

1. **Currency carrier (C2):** add `nativeCurrency` to `PlannedSymbol` and to plan
   read/write at logoff/login.
2. **Headline-from-bar-tip (C5):** the headline total must accept the NAV price read
   off the 1W bar tip instead of a `Quote`.
3. **Model availability:** confirm the decrypted model is present at the Pass-2
   reconcile point for the quantity multiply.
4. **Bar timestamp for priming:** stamp primed quotes with the bar's own newest
   instant, never `Date.now()`.
5. **Per-leg reserve (C8):** confirm `reservation.ts` / `provider-fanout.ts` can
   express "NAV may use Tiingo overflow when TD is exhausted and Tiingo has hourly
   headroom" without breaking the market-bar reserve.
6. **Blob FX reuse:** confirm whether the blob's `fx_eur_usd[]` can serve the 1W FX
   track (would shave one of the three FX pulls under C1).

## The invariant (the through-line)

> One planner decides from one honest ledger, **once, before decrypt** — and the
> post-decrypt step is assembly plus a reconcile that pulls **only on a genuine
> change** (stale blob, new holding, or currency mismatch). Every mechanism that
> pulls MUST write its true effects into that ledger. No exempt, silent freelancers.
