# Tiingo secondary‑provider fallback — implementation plan

> Status: **fully implemented (desktop + web).** Captures the agreed architecture
> for adding Tiingo as a smart fallback behind the existing primaries, plus a
> user‑initiated manual refresh. Written 2026‑06‑23; revised same day to harden
> the NAV‑late trigger (peer‑confirmation + canary probe) and the
> yfinance retry‑before‑escalate gate.
>
> ### ✅ Implementation complete (2026‑06‑23)
>
> **Everything described in this document — both the desktop (Python) and the
> web/Worker (TypeScript) stacks — has now been built and tested.** The desktop
> side merged to `main` via PR #100 (branch `copilot/tiingo-fallback`). The web
> side is complete on branch `copilot/implement-web-tiingo-fallback` (full client +
> Worker `/price` route + gates + tests + the `3.14.0` version bump) and is merging
> imminently. Treat the design sections below as **as‑built reference**, not pending
> work.
>
> **Follow‑up idea (not built):** extend the same secondary‑provider pattern to the
> **home‑currency FX rate** (USD→EUR). Tiingo's Forex feed was verified live and is
> available on the account. See **`tiingo_forex_fallback.md`** for findings and an
> implementation sketch.
>
> ### Progress (2026‑06‑23, branch `copilot/tiingo-fallback`)
>
> **Done — desktop (Python), all committed + 55 Tiingo tests green:**
> - `adapters/tiingo_client.py` + keyring token storage (`storage/encryption.py`).
> - `services/tiingo_fallback.py` — decision core (gates A–D + NAV two‑tier).
> - `repositories/tiingo_state_repo.py` — persisted budget/canary/stale/habit state
>   (JSON in `app_config`; self‑resetting ET hour/day buckets).
> - `services/tiingo_fallback_runner.py` — orchestration; `tiingo_token` in `config.py`.
> - `services/tiingo_fallback_wiring.py` — wired into `prices_service.refresh_due_prices`
>   (yfinance hard‑fail falls through to Tiingo).
> - `ui/pages/settings.py` — keyring token field + **loud popup** (implemented as a
>   warning‑level `runtime_status.record_warning`, which the toast watcher surfaces).
>
> **Remaining — handed off:**
> - **Desktop polish:** optional wiring of the fallback into the backfill
>   `refresh_prices` path (live `refresh_due_prices` + the manual button are done).
> - **Web/Worker (entire stack):** Worker `/price` route; `web/src/tiingo.ts`; ET
>   budget in `cache.ts`; `loadQuotes` insertion; startup quick‑refresh; visible
>   refresh spinner + outcome toast; discreet caption; `priceProxyUrl` config.
> - **Finalize:** CHANGELOG `## [3.14.0]` + version bump (`pyproject.toml`,
>   `web/package.json`, `web/package-lock.json` ×2). User already set the Wrangler
>   `TIINGO_TOKEN` secret. All web integration points below re‑verified to exist
>   as named on 2026‑06‑23.

## Motivation

A live incident exposed two single‑provider risks:

1. **Twelve Data** (web primary) silently stopped serving **FSKAX** `time_series`
   (stuck at 2026‑06‑18 while FXAIX was current) — an upstream data‑quality gap,
   not a code bug. yfinance had the data; the web app did not.
2. **yfinance** (desktop primary) and Twelve Data are each a single point of
   failure for their stack, both for data‑quality gaps and rate limits.

Goal: a **secondary provider** on each stack that engages **only when it's smart
to** — never burning a call when the "stale" data we already hold is actually
correct (closed market, or a fund NAV that simply hasn't republished).

## Provider evidence (verified live 2026‑06‑23)

| Provider | FSKAX @ 06‑22 | Browser‑callable (CORS) | Intraday equity | Notes |
|---|---|---|---|---|
| Twelve Data | ❌ (the bug) | ✅ | ✅ | web primary; 8/min, 800/day free |
| yfinance | ✅ 206.15 | n/a (Python lib) | ✅ | desktop primary; keyless |
| **Tiingo** | ✅ 206.15 | ❌ no `ACAO` header | ✅ (IEX endpoint) | **chosen fallback** |
| EODHD | ✅ 206.15 | ❌ no `ACAO` header | – | **dropped** — 20 calls/day too low |
| Yahoo raw endpoint | – | – | – | **dropped** — unofficial, crumb/cookie, IP‑rate‑limited |

Tiingo's **IEX** endpoint (`/iex/?tickers=`) returns live intraday for stocks/ETFs
(`tngoLast`, `prevClose`, ET `timestamp`) **and** gracefully returns the last NAV
for mutual funds (FSKAX → 206.15, `prevClose` 206.85). The **daily** endpoint
(`/tiingo/daily/<t>/prices`) supplies historical closes. Tiingo covers **US**
tickers; non‑US symbols simply have no Tiingo fallback (graceful).

## Architecture

| Stack | Primary | Fallback | Tiingo reached via | Tiingo self‑cap |
|---|---|---|---|---|
| Desktop (Python) | yfinance | Tiingo | direct HTTPS | **10/hr · 200/day** |
| Web (PWA) | Twelve Data | Tiingo | existing Cloudflare Worker, new `/price` route | **40/hr · 800/day** |

One shared Tiingo account → static **20 % desktop / 80 % mobile** split, each side
self‑capping locally (they can't see each other's live usage). Limits reset at
**midnight US/Eastern**.

## The smart gate — when do we spend a Tiingo call?

A symbol is a fallback candidate only if **all** hold:

1. **Primary fell short** — failed, over‑quota, or returned a bar older than the
   latest settled session for that symbol's market.
2. **Newer data actually exists** — `held_date < expected_date`, where
   `expected_date` = `latestSettledSessionDate()` for market instruments. For
   **NAV funds** this is *not* a plain clock comparison — see the dedicated
   peer‑confirmation + canary logic below.
3. **Budget remains** in both the hourly and daily windows.

Explicitly **skip** (no call spent) when: market closed and we already hold the
latest settled close; a fund's NAV hasn't republished yet and we hold its most
recent published NAV; or data is only mildly stale within the freshness window.

### NAV‑late funds: peer‑confirmation + canary probe (anti‑waste)

Mutual‑fund NAVs publish *after* close and **trickle in over a window** — and on
a bad day the whole batch can run late upstream. Firing Tiingo the moment a fund
is merely "past its usual publish time" would burn calls chasing NAVs that don't
exist **anywhere yet** (Tiingo wouldn't have them either). So a NAV fund counts
as **truly late** (a real gap worth a call) only when we have *positive evidence
that the day's NAV cycle has actually published*:

1. **Free peer evidence (preferred — costs 0 calls).** If the **primary** already
   returned a fresh NAV dated `target_date` for **any other NAV fund**, the
   cycle is demonstrably flowing. After a **grace period** (default ~30 min,
   configurable) measured *from that first observed peer NAV* — to let the normal
   trickle finish — any fund **still** missing `target_date` is a genuine laggard
   (exactly the FSKAX incident) → Tiingo candidate. If **no** peer holds a fresh
   `target_date` NAV yet → the batch is just running late → **skip Tiingo
   entirely**, wait for the next cycle.

2. **Canary probe (only when there is no free peer evidence).** If the primary
   returned **no** fresh NAV for **any** fund — so we can't distinguish "cycle
   late everywhere" from "primary feed broke for the whole NAV batch" (the FSKAX
   failure generalized) — do **not** fan Tiingo across the batch. Resolve the
   ambiguity with a single probe, governed precisely:

   - **Fires only when all hold:** (i) at least one held NAV fund is missing
     `target_date`; (ii) the primary returned **zero** fresh `target_date` NAVs
     across **all** NAV funds this cycle (Tier 1 yielded no free evidence);
     (iii) the clock is **past the first‑probe time** =
     `max(17:30 ET hard floor, earliest learned per‑fund publish time) + 15 min`
     — so in cold start the **first** canary lands ~**17:45 ET** (≈1 h 45 m after
     the 16:00 close) and never earlier than 17:30 ET no matter what; (iv) the
     **per‑probe cooldown** has elapsed (see below); (v) budget remains. Before
     the first‑probe time, or within cooldown, Tier 2 simply **waits** — zero
     calls.
   - **Pick the canary:** the single fund **most likely to have published by
     now** = earliest *and* most consistent observed publish habit (tightest
     distribution). Tiebreak → largest holding. Cold start (no habit history) →
     largest NAV holding. One fund only.
   - **Probe:** one Tiingo call. *Fresh* = `valueDate == target_date`; *not
     fresh* = an older `valueDate` or no row.
   - **Canary fresh** → the cycle *has* published and the primary missed it →
     promote **every** still‑missing NAV fund to confirmed laggard and fetch them
     via Tiingo in priority order, each budget‑gated. The canary's own value is
     kept (it's 1 of N), and Tier 2 is **done for the day** — subsequent missing
     funds flow through normal per‑symbol gating.
   - **Canary not fresh** → NAVs genuinely aren't out yet → **abort the batch**,
     spend nothing more, and arm the **cooldown** before the next probe:
     **15 min** while inside the active NAV‑posting window (17:30–19:00 ET, when
     NAVs are actively landing — stay responsive), **30 min** outside it (deep
     late, back off). Hard backstop: **≤ 8 canary probes per day**. So even an
     all‑evening primary outage costs ~6–8 probes total — ~1 every 15 min through
     the window — until one returns fresh, then exactly one conversion. It never
     drip‑spends on every refresh tick. (In practice this rarely runs more than
     once or twice: the moment **any** peer NAV arrives via the primary, Tier 1
     takes over for free and the canary stops.)
   - **Degenerate single‑NAV‑fund portfolio:** no peers ever exist, so Tier 1 is
     unreachable and the canary *is* that fund — Tier 2 reduces to "try Tiingo for
     it on the cooldown cadence," still bounded to ~1 call per 20–30 min.
   - **Budget:** every probe and every laggard fetch is a normal budgeted call
     (10/200 desktop, 40/800 mobile). Exhausted budget short‑circuits Tier 2
     before any probe, with the standard "budget spent" message.

This logic is **identical on both stacks** (desktop primary = yfinance, web
primary = Twelve Data) and is shared design, not copy‑paste drift. It needs a
per‑fund "last fresh NAV date seen" record so "did any peer publish
`target_date`?" is answerable: **web** extends `readNavPublishStats` in
`cache.ts`; **desktop** stores last‑seen NAV date per fund in
`price_cache_metadata`. Manual refresh keeps this gate (so a manual NAV refresh
before any NAV has published is a no‑op or a single canary probe, never a batch
burn).

## Timing is persisted — fire on *elapsed*, not live timers

The apps are rarely left open for these windows, so **every timing gate is stored
as a wall‑clock timestamp and evaluated on open — never run as an in‑memory
countdown.** On each launch / refresh we compute "has enough elapsed since the
stored stamp?" and, if so, **act immediately** — we never wait out a fresh timer
the user won't be present for. The cadence numbers above are therefore *minimum
spacings between real attempts*, not a clock that must run live: a user who opens
the app once at 18:10 ET gets the due canary instantly, not 15 minutes later.
Persisted stamps:

- **Desktop stale‑since** (per symbol, `price_cache_metadata`) — drives the
  3‑minute grace + confirmed‑repeat‑failure gate.
- **Tiingo canary** — `last_canary_at` + `canary_count_today` (per ET day) drive
  the first‑probe floor and the 15/30‑min cooldown; on open, if past the floor
  and `now ≥ last_canary_at + cooldown`, probe at once.
- **Mobile startup quick‑refresh** — `last_quick_refresh_at` enforces the
  ~once/hour throttle across reopens.
- **Tiingo budget buckets** — ET hour/day counters persist so reopening can't
  silently reset them.

## Desktop design

- **`adapters/tiingo_client.py`** (new): live quotes via IEX, historical closes
  via daily/prices. Mirrors `yfinance_client` shapes (`fetch_closes`,
  `fetch_latest_close`) for a drop‑in fallback.
- **Token storage**: OS **keyring** (the existing secret mechanism used for
  `db_passphrase` / `publish_token`), surfaced as a **Settings field** — entered
  as a setting, stored encrypted, never plaintext. Env var **not** used (per
  user). 
- **Retry‑before‑escalate (boosted).** yfinance already retries transient
  download failures *in‑call* (`adapters/_retry.retry_call`, `_DOWNLOAD_ATTEMPTS`
  = 3 × 0.5 s backoff) and re‑queries empty windows with a wider lookback. Boost
  this so a blip never reaches Tiingo: **4 attempts / 0.75 s base + jitter**. On
  top of the in‑call retries, Tiingo eligibility requires **two** conditions, not
  one: (a) the per‑symbol *stale‑since* stamp in `price_cache_metadata` has aged
  past the **3‑minute grace**, **and** (b) yfinance has been **re‑attempted and
  failed again at least once** since stale‑since — a *confirmed repeat failure*
  across refresh cycles, not merely elapsed time on a single bad poll. So
  yfinance gets several independent cycles (each itself multi‑attempt) before we
  switch. (Short grace because the apps are usually open only briefly and the
  10/hr cap self‑regulates.) Manual refresh bypasses (a)+(b) but keeps the smart
  (newer‑data / NAV peer‑or‑canary) and budget gates.
- **Fallback merge** at the two `fetch_closes` call sites in `prices_service.py`
  (`refresh_prices` ≈ L116, `refresh_due_prices` ≈ L495): after yfinance, gather
  the stale/missing‑and‑past‑grace set, pass it through the smart gate + budget,
  call Tiingo, merge. NAV funds in that set go through the **peer‑confirmation +
  canary** path above (using last‑seen NAV dates in `price_cache_metadata`)
  rather than a bare date comparison, so a late NAV cycle costs at most one
  canary call.
- **Budget counter**: ET‑aware hour + day buckets persisted in
  `price_cache_metadata`.
- **Loud comms**: on any yfinance→Tiingo switch, raise a warning‑level
  `runtime_status.record_warning` (the app's existing toast watcher pops it as a
  notification — "yfinance couldn't deliver fresh data, so Tiingo covered: …")
  **and** `provider_status.record("tiingo", …)` for Settings/diagnostics. The
  `record_warning` dedup window keeps a repeatedly‑failing tick from spamming.

## Web design

- **`web/src/tiingo.ts`** (new): `fetchTiingoQuotes` via the Worker `/price`
  route → `Map<string, Quote>`. IEX for equities (price=`tngoLast`,
  previousClose=`prevClose`, priceTime=live timestamp), NAV for funds
  (priceTime=null, valueDate from the bar date — shown honestly as a settled
  close, not faux‑live).
- **Separate Tiingo budget** in `cache.ts`: new credit‑log key + `startOfEtDay`
  helper (Intl `America/New_York` → ET‑midnight epoch) for the daily reset; hourly
  via rolling window. **40/hr · 800/day.** (Note: the existing Twelve Data budget
  resets at **UTC** midnight via `startOfUtcDay`; Tiingo must use **ET**.)
- **Insertion** in `quotes.ts loadQuotes`, **after** the Twelve Data pass, for
  (a) symbols still missing/stale and (b) the **over‑quota / 429** case ("when I
  run out of Twelve Data tokens"). NAV funds in that set take the
  **peer‑confirmation + canary** path (above), reading/extending
  `readNavPublishStats`, so a late web NAV cycle also costs at most one canary
  probe before fetching confirmed laggards.
- **Startup quick‑refresh**: on load, use Tiingo (no per‑minute limit → fast)
  when prices are **badly outdated** — triggered by **either** being ≥1 settled
  session behind (market closed) **or** >1h stale **during** market hours. The 1h
  floor naturally limits this path to ~once/hour, preserving the rest of the
  budget for true fallbacks. Skip if market closed with latest close in hand, or
  only minutes/hours stale.
- **Discreet comms**: a quiet line appended to the overview status caption in
  `app.ts` (e.g. "Some prices via Tiingo fallback"). No modal, no badge.
- **Visible refresh activity (login feedback).** Logging in has too often
  *looked* idle while a refresh actually ran. Make in‑flight work obvious: the
  overview refresh control **spins** whenever a price load (Twelve Data **or**
  Tiingo) is in progress, driven by the real `loadQuotes` lifecycle (start →
  settle) so it reflects genuine work, and a brief **toast/pill** announces the
  outcome — "Prices updated", "Some prices via Tiingo fallback", or "Already up
  to date". The Tiingo‑fallback note rides this same surfacing rather than a
  second banner.
- **Config**: `priceProxyUrl` added to `AppConfig`, **auto‑derived** from the
  blob Worker origin + `/price`, with an optional Settings override. Browser stays
  **Tiingo‑keyless** (token lives only in the Worker).

## Manual "Refresh via Tiingo now" (both stacks)

A **user‑initiated** action that bypasses the **timing** gates only:

- Desktop: skips the 3‑minute grace (don't wait for yfinance retries).
- Mobile: skips the once‑per‑hour startup throttle and the ">1h during market
  hours" timing gate.

It **still enforces** the smart gates: newer data must actually exist (else it's a
**no‑op** with an "already up to date" message — never a wasted call), and the
per‑side **budget caps** still apply (blocked with a clear message if exhausted).

- Desktop UX: a button/menu item (refresh indicator or Settings) → runs the gated
  Tiingo pull immediately; loud notification of the result.
- Mobile UX: a discreet control on the overview; result noted in the caption.

## Cloudflare Worker — new `/price` route (extends `web/proxy/worker.js`)

- A second **pinned** route alongside the blob route. Proxies **only**
  `api.tiingo.com` (`/iex` and `/tiingo/daily/.../prices`), injects the
  `TIINGO_TOKEN` **secret** (`wrangler secret put TIINGO_TOKEN`), validates the
  symbol against a strict charset (stays non‑SSRF), and stamps the same CORS
  headers. Blob route untouched; the Worker still never holds anything but a
  read‑through to pinned upstreams.
- **No KV budget backstop** — per‑side client budgeting is deemed sufficient.
- Update `wrangler.toml` (document the secret) and `web/proxy/README.md` (route,
  secret step, `curl` test).

## Security

- Token **never** stored in plaintext or shipped to the browser.
- Desktop: OS keyring. Web: Worker secret only. The PWA is Tiingo‑keyless.
- **Blob‑embedding the token: declined.** The Worker can't read the user's
  decrypted blob (it only proxies opaque ciphertext), so it needs its own secret
  regardless; routing the token through the browser to the Worker would expose it.
  Desktop is the blob's producer, so it can't bootstrap the token from the blob it
  creates. Net: keep the two one‑time, invisible entries — simpler and safer than
  one shared blob copy.

## Budgets — quick reference

| | Hourly | Daily | Reset |
|---|---|---|---|
| Desktop Tiingo | 10 | 200 | midnight ET |
| Mobile Tiingo | 40 | 800 | midnight ET |

## Build order

1. ~~Desktop `tiingo_client` → smart‑gate fallback chain → keyring Settings field →
   loud popup.~~ **✅ done (branch `copilot/tiingo-fallback`).**
2. Worker `/price` route + docs.
3. Web `tiingo.ts` → ET budget (persisted) → `loadQuotes` insertion + startup
   quick‑refresh → **visible refresh activity (spinner + outcome toast)** +
   discreet caption + config.
4. ~~Manual "Refresh via Tiingo now" on both stacks.~~ **✅ desktop done; web pending.**
5. Tests both stacks (keep Python + the 425 web tests green) → CHANGELOG/docs.

## User (deploy) steps

- `cd web/proxy && wrangler login && wrangler secret put TIINGO_TOKEN` then
  `wrangler deploy` (after the Worker change lands).
- Paste the Tiingo token into desktop **Settings** (stored to keyring).
- Web price‑proxy URL auto‑derives from the blob Worker — usually nothing to set.

## Integration points (verified)

- `src/investment_dashboard/services/prices_service.py` — `refresh_prices`
  (≈L48/L116), `refresh_due_prices` (≈L452/L495), `instruments_due_for_refresh`
  (market‑aware TTL).
- `src/investment_dashboard/adapters/yfinance_client.py` — `fetch_closes`,
  `fetch_latest_close`, `_record_status`.
- `src/investment_dashboard/services/provider_status.py` — `record()` / status log.
- `src/investment_dashboard/config.py` — secrets resolve from OS keyring.
- `web/src/quotes.ts` — `loadQuotes`, `FREE_TIER` budgeting.
- `web/src/prices.ts` — `fetchQuotes`, `fetchNavQuotes`, `Quote`, `TWELVE_DATA_ROOT`.
- `web/src/cache.ts` — `recordCredits`, `creditsSpentWithin`, `creditsSpentToday`,
  `startOfUtcDay` (Tiingo needs an ET analogue), `readNavPublishStats`.
- `web/src/market-hours.ts` — `latestSettledSessionDate`, `isUsMarketOpen`,
  holiday calendar.
- `web/src/config.ts` — `AppConfig`, `resolveBlobUrl`; `web/src/secret-store.ts`.
- `web/proxy/{worker.js,wrangler.toml,README.md}` — existing closed blob proxy.
