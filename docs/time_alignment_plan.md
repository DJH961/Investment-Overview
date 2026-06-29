# Time-Alignment Plan — One Clock: NYSE Exchange Time

> **💵 USD is the primary/canonical backend currency. EUR is frontend display only.**
> This document is about *time*, not money, but the same rule applies: dollars are
> the source of truth, euros are a display reskin.

## For everyone (non-technical overview)

**Goal:** make the dashboard treat the US stock exchange's clock (New York time) as
the single source of truth for *when a trading day begins, ends, and what counts as
"yesterday."* Everything the user sees is then translated into their own local time
at the very end — never the other way around.

**Why this matters:** two pieces of the app build the same weekly graph — the Python
desktop app and the web companion. Today they quietly disagree about when a "day"
starts. The desktop counts a day from **midnight in New York**; the web counts it
from **midnight in London (UTC)**. Those are ~4–5 hours apart. Same money, two clocks
→ the two lines slide past each other and read as a fake ~1% gap. A second bug makes
the web ask for "the day before yesterday" instead of "yesterday," so the exchange
rate never locks and adds another ~0.4% drift.

**The fix in one sentence:** everyone uses New-York exchange time internally; we
convert to the user's timezone only for display; and we handle the one tricky
exception — the currency (forex) market, which keeps trading after stocks close and
switches daylight-saving on different dates in the US vs Europe.

**Outcome:** the two graphs line up, the ~1% mismatch and ~0.4% currency drift
collapse, and the "I already have the data, why am I re-downloading it?" loop stops.

---

## Root cause (three concrete faults)

All three are pure date/time arithmetic. None is about price source or money.

### Fault 1 — Two different midnights (≈4–5h offset)

A daily close gets a timestamp. The two apps stamp it at different moments:

- **Web — `web/src/week.ts:84`** stamps a daily bar at **UTC midnight**:
  ```ts
  function dayStartMs(day: string): number {
    return Date.parse(`${day}T00:00:00Z`);   // 00:00 UTC
  }
  ```
- **Python — `src/investment_dashboard/services/intraday_snapshots_service.py:503`**
  stamps the same calendar day at **New-York midnight**:
  ```python
  def _session_start_utc(session_date): # 00:00 America/New_York -> UTC
      start_local = datetime.combine(session_date, time(0, 0), tzinfo=_MARKET_TZ)
      return start_local.astimezone(UTC).replace(tzinfo=None)   # 04:00–05:00 UTC
  ```

Same date `2026-06-26`: web = `00:00Z`, python = `04:00Z` (EDT) / `05:00Z` (EST).
Every daily point is shifted 4–5h, so the overlay calibrates on points that do not
truly coincide. This is most of the flat ~1%.

### Fault 2 — "Yesterday" is off by one

- **Web — `web/src/app.ts:2387`** asks for the close *before the last session*:
  ```ts
  const prevDay = previousTradingSession(today);   // Monday -> Friday -> Thursday
  const prevClose = sessionCloseFxFromBars(fx, sessionCloseMs(prevDay));
  ```
  On Monday, `today` = Friday, so `prevDay` = **Thursday**; it should anchor to
  **Friday**. The recent bars never cover Thursday's close → the rate never settles →
  the EUR line floats on the live spot. That is the steady ~0.4% currency gap (the
  `-1675m short` log line is this off-by-one measuring against the wrong day).
- **Python — `intraday_snapshots_service.py:1193`** uses `sessions[0]` (oldest of the
  window) as the start, a different selection rule than the web's "one back." The two
  prev-close pickers must agree.

### Fault 3 — Stale-check compares to a midnight, not the close

- **Web — `web/src/week.ts:148-154`** the "is my week complete?" cutoff returns a
  **day-start**, not the 16:00 close:
  ```ts
  export function weekCoverageCutoffMs(now, sessions): number {
    const settledEnd = isUsMarketOpen(now) ? window[len-2] : window[len-1];
    return dayStartMs(settledEnd);   // midnight, not 20:00Z close
  }
  ```
  Backup-provider funds stamped before that midnight read "incomplete" forever and
  are re-pulled every login. Cheap, but it is the noise that exposed Faults 1–2.

---

## Target architecture: one clock

1. **Canonical internal clock = NYSE exchange time (`America/New_York`).** All session
   dates, day boundaries, closes, windows, and "yesterday" math derive from it.
2. **UTC only as the storage instant.** Timestamps stay epoch-ms/naive-UTC on the
   wire, but every *boundary* is computed by converting an ET wall-clock time to UTC,
   never by truncating UTC to midnight.
3. **Local timezone only at the display edge.** A user in Copenhagen vs New York may
   see a date roll differently; that translation happens at render only.
4. **Forex is the explicit exception.** The currency market trades ~24×5 and is
   already pinned to the ET 17:00 weekly boundary (`web/src/market-hours.ts:423`,
   `FOREX_BOUNDARY_MINUTES = 17*60`). Keep forex on ET, but verify the US/EU DST
   gap weeks (the ~2 weeks where US and Europe have switched and the EUR/USD offset is
   off by an hour) do not strand the prior-close anchor.

---

## Work plan (phased, no implementation yet)

### Phase 1 — Make the day boundary exchange-time everywhere (Fault 1)
- Replace `dayStartMs` UTC-midnight stamping at **`web/src/week.ts:84`** with an
  exchange-time day start. Reuse the existing ET converter `exchangeWallToUtcMs`
  (**`web/src/market-hours.ts:357`**, already DST-aware via `etOffsetMinutes:340`) so a
  "day start" = 00:00 ET in UTC, matching Python's `_session_start_utc:503`.
- Audit all `dayStartMs`/`DAY_MS` daily-bar arithmetic in `web/src/week.ts` so weekly
  daily bars align to the same ET boundary Python writes at lines `1212-1213` /
  `1270-1271`.
- **Confirm** with paired timestamps that web bar `t` == python sample `t` for one day.

### Phase 2 — Cutoff = the close, not midnight (Fault 3)
- Change **`web/src/week.ts:148-154`** to return the session **close** instant
  (`sessionCloseMs(settledEnd)`, `market-hours.ts:375`) instead of `dayStartMs`.
- `weekStaleSymbols:161` and `weekCoverageGap` then judge completeness against 16:00 ET;
  the perpetual 4-fund re-pull stops.

### Phase 3 — Fix "yesterday" once, shared rule (Fault 2)
- Anchor prevFx to the **last completed session**, not one further back:
  audit **`web/src/app.ts:2387`** `previousTradingSession(today)`.
- Make the desktop selector (**`intraday_snapshots_service.py:1193`**, `sessions[0]`)
  and the web selector return the same prior-close day; add a shared definition note.

### Phase 4 — Forex DST guard
- Verify `isForexMarketOpen` / `forexMarketReopenMs` (`market-hours.ts:440,457`) and
  `isWeekendOvernight:504` over the US/EU DST mismatch weeks; ensure the EUR/USD prior
  close still settles when the ET↔CET offset is transiently 5h or 7h.

### Phase 5 — Regression pins
- Test the `-1675m` case resolves to 0; a paired ET/UTC day-start equality test
  (web vs python); a DST-transition date; a US/EU forex-gap week.

### Phase 6 — Full-coverage sweep (no other area lags behind)
The three faults are not the only places a day boundary is computed. Every site
below derives a "day" and must move to the **same ET clock** so a fix here doesn't
just shift the mismatch into another graph. Three flavours exist today — ET (keep),
UTC-midnight (migrate), local-midnight (migrate) — plus provider gates that are
deliberately *not* ET and must be left alone.

**Migrate → ET day boundary (currently UTC-midnight):**
- `web/src/week.ts:8,30` — `dayStartMs` / `DAY_MS` daily-bar buckets (Fault 1 core).
- `web/src/long-range.ts:42,89-94,126-135` — `isoPlusDays` + window floor/ceil parse
  `T00:00:00Z`; 5Y/MAX graph day count must use ET dates.
- `web/src/springboard.ts:25-30` — backbone intraday + daily closes bucketed UTC-day.
- `web/src/week-repair.ts:153-165` — `getUTCDay()` grouping must match the ET window.
- `web/src/prices.ts:180` — date-only request bounds; align to ET session edges.

**Migrate → ET day boundary (currently LOCAL-midnight — worst, off ±4–5h by TZ):**
- `web/src/value-history.ts:18-31,73-80` — buckets to *local* midnight to match Python
  blob `date.today()`; both sides move to ET, not the user's clock.
- `web/src/long-range.ts:262-273` — `localDayOfInstant()`.
- `web/src/freshness.ts:295-330` — `sameLocalDay()` "aged" gate fires on local calendar.
- Python `publish_service.py` / `live_graphs.py:150-200` — blob daily curve uses bare
  local dates; stamp closes at ET so the web counterpart can match without local fudge.

**Display only — convert at render, leave logic ET (no change needed):**
- `web/src/chart.ts:127-155`, `web/src/format.ts`; Python `overview.py`,
  `daily_growth_view.py:46-80`, `refresh_indicator.py`. Verify these are the *only*
  local-time conversions and they all sit at the display edge.

**Provider-pinned, deliberately NOT ET — do not touch:**
- `web/src/cache.ts:558-575` Twelve Data credit window = UTC midnight (provider reset).
- `web/src/cache.ts:603-671` Tiingo window/canary = ET midnight (provider reset).
- `web/src/tiingo-gate.ts`, `web/src/tiingo.ts` ET NAV windows. `projection.ts:96-110`
  year/month simulation math (calendar, not session) stays UTC.

---

## Acceptance
- 1W reconciliation USD Δ collapses from ~1% toward ~0; FX Δ from ~0.4% toward ~0.
- No `short-coverage` re-pull on an already-complete settled book.
- prevFx settles on the first login after close (no perpetual "not yet settled").
- 1D, 1W, 5Y/MAX, value-history and springboard all bucket on the same ET boundary —
  no graph keeps a UTC- or local-midnight boundary except the provider credit gates.
