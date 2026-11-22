"""The dollar's trend against the euro, from a daily EUR/USD series (pure, v7.2).

Input everywhere is a **daily** series ``[(date, rate), ...]``, oldest first, with
``rate`` quoted **USD per 1 EUR** (the ECB reference rate). Most of this module
works in the **dollar's terms**: ``inverse = 1 / rate`` (EUR per 1 USD), so *up*
means the dollar got stronger.

Regime rules (:func:`regime`), evaluated on each day ``i`` that has a 200-day
moving average of the inverse (``ma``) and one 20 days earlier (``ma_prev``):

* **up condition:** ``inverse > ma × (1 + 0.005)`` and ``ma > ma_prev`` (rising);
* **down condition:** ``inverse < ma × (1 − 0.005)`` and ``ma < ma_prev`` (falling);
* **in the middle:** ``|inverse / ma − 1| ≤ 0.005``.

State machine (hysteresis), starting ``sideways`` on the first evaluable day:

1. not ``dollar_up`` and the up condition holds → ``dollar_up`` since that day;
2. else not ``dollar_down`` and the down condition holds → ``dollar_down``;
3. else in ``dollar_up`` / ``dollar_down``: count consecutive days in the middle;
   on the 10th such day → ``sideways``, *since* = the first day of that run. A day
   outside the middle (but not the opposite condition) resets the count and the
   trend is kept. So a trend ends only by the opposite condition or by ten
   straight days hugging its average; it never flickers on one noisy day.

**The euro's side (``of="euro"``).** The same figures for the euro, computed on the
EUR/USD rate itself (USD per 1 EUR: *up* means the euro got stronger), never by
negating the dollar's percentages (``1 / (1 + m) - 1 != -m``). The regime is then
``euro_up`` / ``euro_down`` / ``sideways``; percentiles count the days the euro was
cheaper (a lower rate); a month run counts the months the rate rose or fell.

Everything is :class:`~decimal.Decimal`; nothing here does I/O.
"""

from __future__ import annotations

import itertools
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Literal

from investment_dashboard.domain.risk import annualized_volatility

Direction = Literal["dollar_up", "dollar_down", "euro_up", "euro_down", "sideways"]
#: Whose trend: the dollar (the inverse, EUR per USD) or the euro (the rate itself).
Asset = Literal["dollar", "euro"]
Normality = Literal["normal", "large", "unusual"]
Side = Literal["above", "below"]

ONE = Decimal(1)
ZERO = Decimal(0)
HALF = Decimal("0.5")

MA_WINDOW = 200
#: Inverse must sit this far (fraction) beyond its MA200 to start a trend.
REGIME_BAND = Decimal("0.005")
#: The MA200 slope is judged over this many rows (business days).
SLOPE_DAYS = 20
#: Consecutive days inside the band that turn a trend into ``sideways``.
SIDEWAYS_DAYS = 10
#: Trailing window (rows = ECB business days) of :func:`move_normality`.
MOVE_WINDOW = 21
LARGE_FROM = Decimal("0.80")
UNUSUAL_FROM = Decimal("0.95")
#: A percentile window counts only when the series starts within this many days
#: of the window's start (so "since 1999" is not claimed before the backfill ran).
WINDOW_START_SLACK_DAYS = 31


def inverse_series(series: Sequence[tuple[date, Decimal]]) -> list[tuple[date, Decimal]]:
    """``[(date, 1 / rate)]`` (EUR per USD); non-positive rates are dropped."""
    return [(d, ONE / r) for d, r in series if r > 0]


def asset_series(
    series: Sequence[tuple[date, Decimal]], of: Asset = "dollar"
) -> list[tuple[date, Decimal]]:
    """The price of ``of`` in the other currency: the dollar ``1 / rate`` (EUR per USD),
    the euro the rate itself (USD per EUR). Non-positive rates are dropped."""
    if of == "dollar":
        return inverse_series(series)
    return [(d, r) for d, r in series if r > 0]


def moving_average[T](
    series: Sequence[tuple[T, Decimal]], window: int = MA_WINDOW
) -> list[tuple[T, Decimal]]:
    """Trailing simple moving average; the first point is the ``window``-th row."""
    if window < 1:
        raise ValueError("window must be >= 1")
    out: list[tuple[T, Decimal]] = []
    total = ZERO
    for i, (key, value) in enumerate(series):
        total += value
        if i >= window:
            total -= series[i - window][1]
        if i >= window - 1:
            out.append((key, total / window))
    return out


@dataclass(frozen=True)
class Regime:
    direction: Direction
    #: The day the current regime started.
    since: date
    #: Inverse (dollar) change since ``since``, fraction (0.01 = 1 %).
    since_change_pct: Decimal
    #: Today's inverse against its MA200.
    vs_ma200: Side


def regime(
    series: Sequence[tuple[date, Decimal]],
    *,
    window: int = MA_WINDOW,
    band: Decimal = REGIME_BAND,
    slope_days: int = SLOPE_DAYS,
    sideways_days: int = SIDEWAYS_DAYS,
    of: Asset = "dollar",
) -> Regime | None:
    """The dollar's (or, ``of="euro"``, the euro's) regime on the last day.

    Rules in the module docstring. ``None`` when the series is shorter than
    ``window + slope_days`` rows.
    """
    up_state: Direction = "dollar_up" if of == "dollar" else "euro_up"
    down_state: Direction = "dollar_down" if of == "dollar" else "euro_down"
    inv = asset_series(series, of)
    ma = [v for _d, v in moving_average(inv, window)]
    offset = window - 1  # inv[offset + k] pairs with ma[k]
    if len(ma) <= slope_days:
        return None
    upper, lower = ONE + band, ONE - band
    state: Direction = "sideways"
    since_idx = offset + slope_days
    run_start: int | None = None
    for k in range(slope_days, len(ma)):
        i = offset + k
        value, avg, prev = inv[i][1], ma[k], ma[k - slope_days]
        up = value > avg * upper and avg > prev
        down = value < avg * lower and avg < prev
        if state != up_state and up:
            state, since_idx, run_start = up_state, i, None
        elif state != down_state and down:
            state, since_idx, run_start = down_state, i, None
        elif state != "sideways":
            if avg * lower <= value <= avg * upper:
                if run_start is None:
                    run_start = i
                if i - run_start + 1 >= sideways_days:
                    state, since_idx, run_start = "sideways", run_start, None
            else:
                run_start = None
    last_value, last_avg = inv[-1][1], ma[-1]
    return Regime(
        direction=state,
        since=inv[since_idx][0],
        since_change_pct=last_value / inv[since_idx][1] - ONE,
        vs_ma200="above" if last_value >= last_avg else "below",
    )


@dataclass(frozen=True)
class MoveNormality:
    #: Today's trailing ``window_days`` move of the inverse (signed fraction).
    move_pct: Decimal
    #: Median |move| over the whole history (fraction).
    typical_move_pct: Decimal
    #: Mid-rank percentile of |today's move| among all |moves|, in [0, 1].
    percentile: Decimal
    label: Normality
    window_days: int


def _median(values: Sequence[Decimal]) -> Decimal:
    ordered = sorted(values)
    n = len(ordered)
    mid = n // 2
    if n % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2


def label_for(percentile: Decimal) -> Normality:
    if percentile >= UNUSUAL_FROM:
        return "unusual"
    if percentile >= LARGE_FROM:
        return "large"
    return "normal"


def move_normality(
    series: Sequence[tuple[date, Decimal]], window_days: int = MOVE_WINDOW, *, of: Asset = "dollar"
) -> MoveNormality | None:
    """How unusual today's ``window_days``-row move of the dollar is.

    Moves are ``inverse[i] / inverse[i - window_days] − 1`` for every row that has
    one (today included). The percentile is the **mid-rank** of |today's move|:
    ``(count(|m| < |today|) + ½·count(|m| = |today|)) / N``, so a flat series gives
    0.5 ("normal"), not 1. ``None`` without at least one move.
    """
    inv = [v for _d, v in asset_series(series, of)]
    if window_days < 1 or len(inv) <= window_days:
        return None
    moves = [inv[i] / inv[i - window_days] - ONE for i in range(window_days, len(inv))]
    today = moves[-1]
    size = abs(today)
    sizes = [abs(m) for m in moves]
    below = sum(1 for s in sizes if s < size)
    equal = sum(1 for s in sizes if s == size)
    percentile = (Decimal(below) + HALF * equal) / len(sizes)
    return MoveNormality(
        move_pct=today,
        typical_move_pct=_median(sizes),
        percentile=percentile,
        label=label_for(percentile),
        window_days=window_days,
    )


def rate_percentiles(
    series: Sequence[tuple[date, Decimal]],
    today_rate: Decimal,
    windows: Mapping[str, date | None],
    *,
    slack_days: int = WINDOW_START_SLACK_DAYS,
    of: Asset = "dollar",
) -> dict[str, Decimal | None]:
    """Per window: the share of days the dollar (or the euro) was **cheaper** than today.

    Cheaper dollar = lower inverse = higher rate, so the share is
    ``count(rate > today_rate) / count(rows since start)``; a cheaper euro is a lower
    rate, ``count(rate < today_rate)``. A window is ``None``
    when its start is ``None``, it has no rows, or the series begins more than
    ``slack_days`` after the start (history not there yet).
    """
    out: dict[str, Decimal | None] = {}
    valid = [(d, r) for d, r in series if r > 0]
    first = valid[0][0] if valid else None
    for key, start in windows.items():
        if start is None or first is None or (first - start).days > slack_days:
            out[key] = None
            continue
        rows = [r for d, r in valid if d >= start]
        if not rows or today_rate <= 0:
            out[key] = None
            continue
        cheaper = (
            sum(1 for r in rows if r > today_rate)
            if of == "dollar"
            else sum(1 for r in rows if r < today_rate)
        )
        out[key] = Decimal(cheaper) / len(rows)
    return out


@dataclass(frozen=True)
class Extremes[T]:
    low_at: T
    low: Decimal
    high_at: T
    high: Decimal


def range_extremes[T](points: Sequence[tuple[T, Decimal]]) -> Extremes[T] | None:
    """Lowest and highest rate with their keys (the earliest one on a tie)."""
    if not points:
        return None
    low_at, low = points[0]
    high_at, high = points[0]
    for key, value in points[1:]:
        if value < low:
            low_at, low = key, value
        if value > high:
            high_at, high = key, value
    return Extremes(low_at=low_at, low=low, high_at=high_at, high=high)


# --- "The dollar" section (v7.2) ---------------------------------------------

Slope = Literal["rising", "falling", "flat"]
RunDirection = Literal["rose", "fell"]

#: An MA200 that moved less than this (fraction) over ``SLOPE_DAYS`` is ``flat``.
FLAT_SLOPE = Decimal("0.001")
#: Inside ``±`` this percentile of |move| a move is ``normal`` (matches LARGE_FROM).
NORMAL_QUANTILE = LARGE_FROM
MONTH_ROWS = 21
QUARTER_ROWS = 63
YEAR_ROWS = 252


def quantile(values: Sequence[Decimal], q: Decimal) -> Decimal:
    """Linear-interpolation quantile (spreadsheet ``PERCENTILE.INC``), ``q`` in [0, 1].

    ``h = (n − 1)·q``; the result is ``x[⌊h⌋] + (h − ⌊h⌋)·(x[⌊h⌋+1] − x[⌊h⌋])``.
    """
    if not values:
        raise ValueError("quantile of an empty sequence")
    if not ZERO <= q <= ONE:
        raise ValueError("q must be in [0, 1]")
    ordered = sorted(values)
    h = (len(ordered) - 1) * q
    lo = int(h)
    if lo >= len(ordered) - 1:
        return ordered[-1]
    return ordered[lo] + (h - lo) * (ordered[lo + 1] - ordered[lo])


def trailing_moves(
    series: Sequence[tuple[date, Decimal]], window_days: int, *, of: Asset = "dollar"
) -> list[tuple[date, Decimal]]:
    """The dollar's (inverse) trailing ``window_days``-row change on every row that has one.

    ``inverse[i] / inverse[i − window_days] − 1`` == ``rate[i − w] / rate[i] − 1``; the
    euro's is ``rate[i] / rate[i − w] − 1``.
    """
    if window_days < 1:
        raise ValueError("window_days must be >= 1")
    inv = asset_series(series, of)
    return [
        (inv[i][0], inv[i][1] / inv[i - window_days][1] - ONE) for i in range(window_days, len(inv))
    ]


@dataclass(frozen=True)
class MoveBand:
    """The normal band of the dollar's ``window_days``-row moves over the whole series."""

    window_days: int
    #: Median |move| ("a typical month moves ±X").
    typical_move_pct: Decimal
    #: :data:`NORMAL_QUANTILE` quantile of |move|: inside ``±`` this is ``normal``.
    normal_limit_pct: Decimal


def move_band(
    series: Sequence[tuple[date, Decimal]],
    window_days: int,
    *,
    q: Decimal = NORMAL_QUANTILE,
    of: Asset = "dollar",
) -> MoveBand | None:
    """Typical size and normal limit of every ``window_days`` move (``None`` without one)."""
    sizes = [abs(m) for _d, m in trailing_moves(series, window_days, of=of)]
    if not sizes:
        return None
    return MoveBand(
        window_days=window_days,
        typical_move_pct=_median(sizes),
        normal_limit_pct=quantile(sizes, q),
    )


@dataclass(frozen=True)
class MaSlope:
    #: Today's MA of the inverse and the one ``slope_days`` rows earlier.
    ma_now: Decimal
    ma_then: Decimal
    #: ``ma_now / ma_then − 1``.
    slope_pct: Decimal
    label: Slope
    #: Today's inverse against ``ma_now``.
    side: Side
    #: ``inverse_now / ma_now − 1``.
    distance_pct: Decimal
    #: MA of the rate itself on the last row (for the rate quote).
    ma_rate_now: Decimal


def ma_slope(
    series: Sequence[tuple[date, Decimal]],
    *,
    window: int = MA_WINDOW,
    slope_days: int = SLOPE_DAYS,
    flat: Decimal = FLAT_SLOPE,
    of: Asset = "dollar",
) -> MaSlope | None:
    """The dollar (or the euro) against its MA200 and where that average points.

    ``None`` if too short. ``ma_now`` / ``ma_then`` / ``side`` / ``distance_pct`` are
    in ``of``'s terms; ``ma_rate_now`` is always the MA of the rate.
    """
    valid = [(d, r) for d, r in series if r > 0]
    inv = asset_series(valid, of)
    ma = moving_average(inv, window)
    ma_rate = moving_average(valid, window)
    if len(ma) <= slope_days:
        return None
    now, then = ma[-1][1], ma[-1 - slope_days][1]
    slope = now / then - ONE
    label: Slope = "flat" if abs(slope) < flat else ("rising" if slope > 0 else "falling")
    last = inv[-1][1]
    return MaSlope(
        ma_now=now,
        ma_then=then,
        slope_pct=slope,
        label=label,
        side="above" if last >= now else "below",
        distance_pct=last / now - ONE,
        ma_rate_now=ma_rate[-1][1],
    )


def share_below(
    series: Sequence[tuple[date, Decimal]], threshold: Decimal, start: date | None = None
) -> Decimal | None:
    """Share of rows from ``start`` (all rows if ``None``) whose rate is below ``threshold``.

    ``None`` without rows. Rates are USD per 1 EUR, so "rate below the average"
    means "the dollar above it".
    """
    rows = [r for d, r in series if r > 0 and (start is None or d >= start)]
    if not rows:
        return None
    return Decimal(sum(1 for r in rows if r < threshold)) / len(rows)


def share_above(
    series: Sequence[tuple[date, Decimal]], threshold: Decimal, start: date | None = None
) -> Decimal | None:
    """Share of rows from ``start`` whose rate is above ``threshold`` (``None`` without rows)."""
    rows = [r for d, r in series if r > 0 and (start is None or d >= start)]
    if not rows:
        return None
    return Decimal(sum(1 for r in rows if r > threshold)) / len(rows)


@dataclass(frozen=True)
class SeriesMean:
    since: date
    #: Mean of the rate and mean of the inverse (each its own average).
    rate: Decimal
    inverse: Decimal
    rows: int


def series_mean(
    series: Sequence[tuple[date, Decimal]], start: date | None = None
) -> SeriesMean | None:
    """Mean rate and mean inverse of the rows from ``start`` (``None`` without rows)."""
    rows = [(d, r) for d, r in series if r > 0 and (start is None or d >= start)]
    if not rows:
        return None
    n = Decimal(len(rows))
    return SeriesMean(
        since=rows[0][0],
        rate=sum((r for _d, r in rows), start=ZERO) / n,
        inverse=sum((ONE / r for _d, r in rows), start=ZERO) / n,
        rows=len(rows),
    )


@dataclass(frozen=True)
class MonthRun:
    direction: RunDirection
    count: int
    of: int
    #: The dollar's move in each of the ``of`` months, oldest to newest, and the month
    #: (the date of its last row) each one ends on. Detail only: not part of equality.
    months: tuple[str, ...] = field(default=(), compare=False)
    month_ends: tuple[date, ...] = field(default=(), compare=False)


def monthly_run(
    series: Sequence[tuple[date, Decimal]], months: int = 6, *, of: Asset = "dollar"
) -> MonthRun | None:
    """ "The dollar fell in 5 of the last 6 months".

    Month ends are the last row of each calendar month (the current month's last
    row so far counts as its end). The dollar's month change is the inverse of one
    month end against the previous one; the last ``months`` changes are counted.
    ``direction`` is the majority; on a tie, the direction of the latest month. A
    flat month counts for neither. ``None`` with fewer than ``months`` changes or
    when every one of them is flat.
    """
    if months < 1:
        raise ValueError("months must be >= 1")
    ends: list[tuple[date, Decimal]] = []
    for d, r in series:
        if r <= 0:
            continue
        if ends and (ends[-1][0].year, ends[-1][0].month) == (d.year, d.month):
            ends[-1] = (d, r)
        else:
            ends.append((d, r))
    if len(ends) <= months:
        return None
    # The dollar rose when the rate fell (inverse up); the euro when the rate rose.
    sign = -1 if of == "dollar" else 1
    changes = [sign * (ends[i][1] - ends[i - 1][1]) for i in range(len(ends) - months, len(ends))]
    rose = sum(1 for c in changes if c > 0)
    fell = sum(1 for c in changes if c < 0)
    if rose == fell == 0:
        return None
    if rose == fell:
        latest = next(c for c in reversed(changes) if c != 0)
        direction: RunDirection = "rose" if latest > 0 else "fell"
    else:
        direction = "rose" if rose > fell else "fell"
    return MonthRun(
        direction=direction,
        count=rose if direction == "rose" else fell,
        of=months,
        months=tuple("rose" if c > 0 else "fell" if c < 0 else "flat" for c in changes),
        month_ends=tuple(d for d, _r in ends[len(ends) - months :]),
    )


def daily_returns(values: Sequence[Decimal]) -> list[Decimal]:
    """``v[i] / v[i − 1] − 1`` for consecutive positive values."""
    return [b / a - ONE for a, b in itertools.pairwise(values) if a > 0]


def rate_volatility(
    series: Sequence[tuple[date, Decimal]], rows: int = YEAR_ROWS, *, inverse: bool = False
) -> Decimal | None:
    """Annualised volatility of the last ``rows`` daily changes of the rate (or its inverse).

    Uses :func:`domain.risk.annualized_volatility` (sample stdev × √252).
    """
    valid = [r for _d, r in series if r > 0]
    values = [ONE / r for r in valid] if inverse else valid
    return annualized_volatility(daily_returns(values[-(rows + 1) :]))


__all__ = [
    "Asset",
    "Direction",
    "Extremes",
    "MaSlope",
    "MonthRun",
    "MoveBand",
    "MoveNormality",
    "Normality",
    "Regime",
    "SeriesMean",
    "asset_series",
    "daily_returns",
    "inverse_series",
    "label_for",
    "ma_slope",
    "monthly_run",
    "move_band",
    "move_normality",
    "moving_average",
    "quantile",
    "range_extremes",
    "rate_percentiles",
    "rate_volatility",
    "regime",
    "series_mean",
    "share_above",
    "share_below",
    "trailing_moves",
]
