# Action Plan — Python desktop parity & NAV-in-1W (main app)

**Context:** Companion to `docs/tiingo_polling_storm_cleanup_plan.md` (the web
companion's remediation). We audited the **Python desktop app**
(`src/investment_dashboard/`) against the same eight issue classes we flagged in
the web build. The desktop is the **source of truth** — the web springboards off
its exported 1D/1W curves (`readmodels/live_graphs.py`) — so anything the desktop
gets wrong, the phone inherits.

**Headline:** the desktop is **already on par or superior** on six of the eight
web issues. Only **three** real workstreams remain, and the largest (NAV-in-1W)
turns out to be much cheaper than feared because the data already exists.

**Key latitude:** the desktop's **primary price source is yfinance, which is
effectively unmetered** (prices_service.py:93 — "the desktop's yfinance primary is
unmetered, so this broad re-pull is free"). So unlike the web build we can **pull
aggressively**; budget concern applies *only* to the optional Tiingo fallback.

**Working dir:** `C:\Users\t-dhenke\OneDrive - Microsoft\Documents\VS Code\Investment-Overview`
**Tests:** existing `pytest` suite under `tests/`; `ruff` + `mypy` via
`.pre-commit-config.yaml`. No new frameworks. Verify baseline green before & after.

---

## Audit result — already on par or SUPERIOR (preserve, do NOT regress)

These web shortcomings **do not exist** in the desktop; the listed code is
load-bearing and must be kept intact when implementing the workstreams below.

1. **Budget accounting** — desktop charges the Tiingo budget per **request**
   (correct: Tiingo meters requests, not payloads), with a conditional canary
   two-phase pattern. `tiingo_fallback_runner.py:108,146,155–169`;
   `tiingo_state_repo.py:164–174`. *(Web's phantom-charge-on-empty bug: absent.)*
2. **Pull error handling** — every yfinance/Tiingo failure is caught and logged
   with provider + symbol + HTTP status; partial/empty results recorded as
   `ok`/`partial`/`error`. `tiingo_client.py:217–345`; `prices_service.py:196–198,
   646–651,739–767`. *(Web's silent swallow: absent.)*
3. **Provider selection** — strict primary→fallback; a symbol can never hit both
   providers in one cycle (yfinance returns `{}` on failure, Tiingo fills only the
   missing symbols), with eligibility gates *before* the budget trim.
   `prices_service.py:644–695`; `tiingo_fallback_runner.py:76–112`;
   `tiingo_fallback_wiring.py:176`. *(Web's fallback↔graph double-buy: absent.)*
4. **Structured pull logging** — provider, symbol list, date range, counts, market
   state all logged. `prices_service.py:184–193,217–222,637–700`;
   `fx_service.py:282–289,321–343`. *(Web's blind polling log: superseded.)*
5. **Reset / refresh / version observability** — app version at startup, storage
   layout, backups, migrations, every boot refresh stage with counts, and DB
   resets all logged; plus a **Data Health page**, **support bundle**, and a
   `_RuntimeStatusHandler` mirroring WARN/ERROR into the UI. `main.py:152–157`;
   `boot.py:239–933`; `database_reset_service.py:162–193`; `diagnostics_service.py`;
   `support_bundle.py`; `logging.py:34–64`. *(Web item 6 + UI: already done.)*
6. **Live FX fallback chain** — live EUR/USD is yfinance→Tiingo, budget-gated.
   `fx_service.py:116–177`. *(Web's FX-only-Tiingo live gap: absent.)*

**Flexible provider split (web item 8):** **N/A by design** — yfinance is the
unmetered primary, so there is nothing to ration on the hot path. No work needed.

---

## Workstreams (priority order)

### 1. NAVs in the 1W curve — make funds drift per-day  `[py-nav-week]`  **(PRIMARY)**
**This is the parity item that matters most** (≈ half the book is NAV, so weekly
NAV drift moves the total materially), and it is **cheaper than expected**.

**Status quo (confirmed):** `build_week_value_series` (_overview_query.py:365–417)
computes a single constant `base = total_now - market_now` (line 398) — cash **plus
every NAV fund** — and adds it unchanged to every point via `_compose_currency_points`
(lines 323–362). NAV funds are kept out of the intraday samples by
`_NAV_ASSET_CLASSES`/`is_intraday_priced` (intraday_snapshots_service.py:138–159).
So funds ride **flat** across the whole week at today's NAV.

**The cheap unlock — dated NAV history already exists.** `refresh_prices` fetches
**all non-synthetic** instruments and `mutual_fund` is **not** synthetic
(`_SYNTHETIC_ASSET_CLASSES = {"cash","savings"}`, prices_service.py:63), so each
fund's **daily close — which *is* its NAV — is already persisted to `price_history`**
via `upsert_closes` (prices_service.py:150,211). `prices_repo.close_as_of`
(prices_repo.py:93) already forward-fills a fund's NAV for any date. **No new
table, no backfill** — the "remember NAVs from close pulls" idea is effectively
already built; the week builder simply doesn't read it.

**Change (range-aware base split):**
1. In the **week** range only, stop folding *price-moving* NAV funds into the flat
   base. For each session date the week plots, add each such fund's contribution
   using its **own dated NAV** (`prices_repo.close_as_of(cache, fund_id, day)` ×
   shares × that day's FX) instead of today's NAV. Keep the **1D** range exactly
   as-is (funds flat — there is no intraday NAV).
2. Keep **truly flat** holdings in the constant base: **cash, savings, and
   money-market funds** (~1.00 NAV). Money-market detection already exists
   (`money_market.py:54–93`, `is_money_market`); use it to exclude MMFs from the
   per-day treatment so they never wiggle and are never specially fetched.
3. **Reuse is already free:** the week builder is cache-first and reuses today's
   dense 1D live samples verbatim, refilling only gaps
   (intraday_snapshots_service.py:740–814) — so funds gain per-day drift with **no
   extra network fetches** (their NAVs are already in `price_history`).
4. Carry the new per-day fund track through the **mobile springboard export**
   (`readmodels/live_graphs.py` → `build_week_value_series`) so the web companion
   inherits the richer 1W instead of diverging at the tip.
- Tests: a fund whose `price_history` NAV changed across the week produces a
  **sloped** 1W contribution (not flat); a money-market fund stays flat; the 1D
  curve is unchanged; the springboard export reflects the per-day track.

### 2. Coverage-vs-presence freshness fix  `[py-staleness]`
Parity with web item 5b. Two desktop guards use a **presence** test ("any sample
exists") where a **coverage** test ("enough of the expected samples exist") is
needed, so a partially-written or mid-failure session is wrongly judged complete
and never retried.
- **Week anchor (today):** `_is_covered` treats today as covered if **any** sample
  exists (intraday_snapshots_service.py:789–791), while finished sessions correctly
  require ≥ `WEEK_POINTS_PER_COMPLETE_SESSION` (line 133,794). A single stray 10:00
  capture marks the whole day covered, so later gaps in today's curve aren't filled.
- **1D reconstruction:** `reconstruct_last_session` is guarded by
  `_already_reconstructed AND _session_has_samples` (lines 522–527), and
  `_session_has_samples` is presence-only (lines 643–656). A reconstruction that
  wrote 1 sample then failed mid-fetch sets the done-marker, so the gap is never
  re-attempted once the feed recovers.
- **Fix:** make both guards **coverage-aware** — compare the count (and ideally the
  time-spread) of stored samples against the expected bar count for the session
  before declaring it complete; only then set the done-marker. yfinance being
  unmetered means the extra refetch is essentially free, so we can bias toward
  re-pulling when coverage is uncertain.
- Tests: a session with 1 of N expected samples reports **not covered** and
  refetches; a fully-covered session is left untouched (no double-pull, the
  per-anchor marker at lines 927–938 still holds within a session).

### 3. FX history provider fallback  `[py-fx-history]`
Parity with web item 4 (milder here). Per-day week-base FX comes from **Frankfurter
only** (fx_service.py:321–323) — no fallback, unlike the live spot which already has
yfinance→Tiingo. It **degrades gracefully** today (catches `FrankfurterError`, logs,
keeps stale rates, records provider status — fx_service.py:324–332) and a
per-session fetch guard prevents any re-fire storm
(intraday_snapshots_service.py:801,927–932), so this is **lower priority**.
- **Change:** add a fallback chain for FX **history** mirroring the live-spot
  pattern: Frankfurter → yfinance `EURUSD=X` daily → (optional, budget-gated)
  Tiingo FX daily. Keep the existing stale-rate degradation as the final floor.
- Tests: Frankfurter empty/error ⇒ yfinance consulted ⇒ Tiingo (if budget) ⇒ stale
  floor; provider status records which source served each day.

---

## Sequencing & dependencies

- **Item 1 (NAV-in-1W)** is the priority and is largely self-contained
  (`_overview_query.py` + the springboard export). Land first.
- **Item 2 (coverage)** is independent and small; can land alongside item 1.
- **Item 3 (FX history fallback)** is lowest priority (graceful degradation already
  in place) — schedule last.
- After each: run `pytest`, `ruff`, `mypy`; eyeball a 1W render with a fund whose
  NAV moved across the week to confirm it now slopes.

## Out of scope (already correct in the desktop)
- Budget-on-empty, pull error logging, provider double-pull, structured/ reset/
  version logging, live-FX fallback, flexible provider split — see the
  "already on par or SUPERIOR" section. Do not touch except to preserve.
