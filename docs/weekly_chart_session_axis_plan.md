# Weekly chart: collapse dead time, break gaps, mark sessions

Goal: make the 1W graph read like a broker terminal. A regular session is ~6.5h
but a calendar week is 168h, so on a continuous wall-clock axis ~80% of the width
is dead air (nights / weekends / holidays) and the real price action is crushed
into thin slivers joined by long smoothing lines.

Implement options:
1. Collapse non-trading time (overnight / weekend / holidays) on the x-axis.
3. Draw light vertical separators between trading days.
4. Never interpolate a line across a closed period (break per session).

Scope: **1W range only**. 1D (single session) and the long history ranges stay
unchanged.

## Current state (why it looks like mush)

### Python (desktop) — Plotly
- Figure built in `src/investment_dashboard/ui/pages/overview.py` (the
  `_value_chart`-style fn, ~L658+): `go.Scatter(x=dates, y=values, mode="lines",
  fill="tozeroy")` with a **real datetime** x-axis.
- `week=True` branch already exists (tickformat `%a %d`, weekday hover) but the
  axis is still continuous wall-clock time, so nights/weekends eat ~80% of the
  width and Plotly draws a straight smoothing line Fri-close -> Mon-open.
- Week series = 3 points/session (start / midday / close) from
  `_overview_query.build_week_value_series`.
- `domain/market_hours.py` gives `_holidays_for_year`, `is_trading_day`,
  `regular_session_close`, session open/close times.

### Web — custom inline-SVG (`web/src/chart.ts`)
- `buildLineChart` positions points with `timeFractions(dates)` = real elapsed
  time => same gap problem. `linePath` already breaks on `null` values.
- 1W curve built in `web/src/week.ts`; chart-ready columns in
  `web/src/value-graph.ts` (`dates` = ISO instants via `new Date(p.t).toISOString()`).
- Wired in `web/src/ui.ts` `applyLive("1W", ...)` -> `buildLineChart({dates, series,...})`.
- `web/src/market-hours.ts` has holiday calendar, `recentTradingSessions`,
  `sessionOpenMs/sessionCloseMs`.

## Python plan

1. **Collapse gaps (opt 1)** — add Plotly `rangebreaks` in the `week` branch only:
   - `dict(bounds=["sat","mon"])` — drop weekends.
   - `dict(bounds=[16, 9.5], pattern="hour")` — drop the overnight non-session
     hours on weekdays.
   - `dict(values=[holiday "YYYY-MM-DD" in window])` — drop holidays, sourced from
     `market_hours._holidays_for_year` for the spanned years.
   - **tz caveat:** rangebreak hour bounds are in the axis's displayed tz. Render
     the week x in **ET** (or compute local-tz session bounds) so `[16, 9.5]`
     lines up with the 09:30-16:00 ET session. Set the week build `tz` and the
     hours bound consistently.

2. **Break the line per session (opt 4)** — post-process `(dates, values)` for the
   week curve: when consecutive points cross into a new session date, insert a
   `(boundary_instant, None)` row. `mode="lines"` + `fill="tozeroy"` then renders
   one area "island" per session instead of one interpolated ribbon. (Ensure
   `connectgaps` stays False — default.)

3. **Session separators (opt 3)** — `fig.add_vline(x=session_open_instant,
   line=dict(width=1, color="rgba(91,107,124,0.35)"))` per session boundary (or
   alternating `add_vrect` bands). With rangebreaks these land on the collapsed
   axis automatically.

Tests: extend the overview-chart UI test to assert rangebreaks present + a None
gap between sessions for the week range; keep 1D/history snapshots unchanged.

## Web plan

1. **Collapse gaps (opt 1)** — add an opt-in flag to `LineChartOptions`
   (e.g. `collapseSessions?: boolean`). When set, replace `timeFractions` with a
   new `sessionFractions(dates)`:
   - session day = `dates[i].slice(0,10)`; group consecutive points by day.
   - give each session an equal-width band; within a band place points by their
     fraction of that session's own first->last span; insert a small fixed gutter
     between bands. Return `{ fractions, boundaryIndexes }`.

2. **Break the line per session (opt 4)** — pass `boundaryIndexes` to `linePath`
   so it emits `M` (new subpath) at each session's first point instead of `L`;
   area fill closes per session. (Reuses the existing null-break machinery.)

3. **Session separators (opt 3)** — in `buildLineChart`, when `collapseSessions`,
   draw a thin `<line>` at each band boundary (gutter centre). Switch
   `xAxisTicks` to one day-label per session band ("Mon 22", "Tue 23").

Wiring: `ui.ts applyLive("1W")` passes `collapseSessions: true` into
`buildLineChart`; `LiveCurveChart` carries the flag. 1D path untouched.

Tests: `web/test` unit for `sessionFractions` (equal bands, gutters, boundary
indexes) and a `linePath` break-at-boundary check.

## Density: keep all sourced bars per trading day — DONE
- The week curve previously emitted **3** points/session (open / midday / close),
  then a thinned **5**. It now keeps **every** genuinely time-stamped bar each
  side sources, so the finer time scale carries each day's real intraday shape
  instead of a coarse few-point step.
- Python: `intraday_snapshots_service._pick_session_points` keeps *all* sourced
  30-minute bars (~13/day) rather than sampling a handful; the desktop feed has no
  token/credit limit, so there is no reason to drop good data. The
  `WEEK_POINTS_PER_COMPLETE_SESSION = 5` constant is now only a *coverage floor* —
  a finished day with fewer points is treated as missing and re-pulled — not a cap.
  Per-instant repricing builds each forward-fill lookup once (`_make_forward_fill`)
  so keeping more points doesn't re-sort bars per point.
- Web: `intraday-tiingo.barsFromTiingoDaily` emits only the **2** genuinely
  time-stamped points/day (open at 09:30 ET, close at 16:00 ET). The daily OHLC
  candle has no within-day clock for the high/low, so no interior points are
  synthesised — only actually-timestamped marks are plotted.
- First/last (open/close) stay exact so the day's endpoints still match the
  settled values.

## Shared notes
- Keep both implementations behind the 1W path so 1D and history are untouched.
- Parity: mirror the band/gutter + per-session break logic so desktop and web
  read the same.
