# Why the twin estimate used to drift from the held twin's own close

Investigated 2026-11-07 after the owner noticed a mutual fund's ETF-twin estimate
(e.g. VTI estimating a fund's NAV) showing a day percentage about 0.05pp away from
VTI's *own* "today" row, even in USD view with no FX involved. A prior pass had
blamed this on the FX anchor (ECB fixing vs. session close); the owner confirmed the
gap survives in USD, which rules FX out. This note records the real cause, now
fixed — see the dated `CHANGELOG.md` entry for the release.

## The two figures compared

```
twin estimate:  pct = twin_now / twin_prev_close - 1
holding row:    pct = close_last / close_prev - 1
```

Both are meant to be the same ETF's close-to-close return. They used to differ
because they were drawn from different *moments*, not different prices:

- `close_last` (the held ETF's own row) is the session's true 16:00 ET settled
  close. `prices_service.refresh_prices` / `refresh_due_prices` re-fetch "today"
  once the market shuts regardless of what is already cached
  (`prices_service._force_refresh_window` clamps the fetch window back onto
  "today" even when it's the cached date) — this is the scheduler's `eod` job
  (`services/scheduler.py`), which runs once per settled session.
- `twin_now` (the fund's twin) came from `services/intraday_snapshots_service
  .refresh_twin_prices`'s live capture, which only ever runs `while
  is_us_market_open(now)` — strictly `t < 16:00` — stamping `min(now, close_at)`.
  The last sample of a session was therefore always *before* the bell, by up to
  one scheduler poll interval (default 60s). Once the market shut,
  `refresh_twin_prices`'s one remaining fetch branch was gated on
  `market_open or missing_prev`; for an already-tracked twin (the normal case,
  since its previous close is always cached by then) both were false, so the
  session's own close was **never** fetched again — the twin's session was
  frozen at that pre-close sample for good (the next write to that twin isn't
  until the *next* session, by which time the fund's NAV has usually already
  posted and the estimate for the earlier session is no longer shown at all).

So the holding's close reflects the whole session including the closing
auction; the twin's "close" reflected everything *except* the last ~minute. A
closing-auction move of a few cents on a large liquid ETF is exactly enough to
produce a ~0.05pp gap.

## Bug, not FX, and not one-directional

This is a genuine defect, not an inherent property of estimating a NAV from a
twin: a NAV strikes at the close, so measuring the twin to 15:59 instead of
16:00 is a real miss, not just a display nuance. It is **not** a systematic,
one-directional bias — whether an evening reads a touch high or low depends on
which way the twin moved in its own final minute, which varies session to
session. It does mean the stored twin-divergence/tracking-error stats
(`last_pp`, `median_abs_pp`, `bias_pp`, …) have been absorbing this timing gap
as extra (zero-mean) noise on top of real tracking error, inflating the
dispersion figures without skewing `bias_pp` in one direction. Past sessions'
stored stats are not retroactively corrected by the fix below — only new
sessions benefit.

## The fix

`refresh_twin_prices` (`backend/src/investment_dashboard/services
/intraday_snapshots_service.py`) now also re-fetches a twin's closes once the
market has shut if no stored sample is at or after the session's TRUE close
instant (`_session_actual_close_utc`, early-close aware) — the same "once
after the bell" guarantee the holdings price pipeline already gives a
directly-held instrument. The newly-fetched settled close is stored at the
true close instant rather than at a `now`-stamped live instant, so the existing
`_latest_at_or_before` lookups used by `_twin_estimates` automatically prefer
it over the earlier pre-close sample — no change was needed to the
estimate-reading code itself.

## What would have to change for this NOT to be a bug

If the owner instead wants the estimate to always reflect "the best data
available right now" rather than eventually settling on the true close — i.e.
accept the pre-close sample as final and never re-fetch — that would be a
deliberate product choice to keep rather than a defect, and the `at_close` ✓
promise in `readmodels/holdings.py` would need rewording (it currently reads
as "the market is shut, so this won't move again *and* is the real close").
No such preference was expressed; the fix assumes "the real close, slightly
delayed" is what the ✓ already promises.
