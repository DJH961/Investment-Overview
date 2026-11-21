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

Everything is :class:`~decimal.Decimal`; nothing here does I/O.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Literal

Direction = Literal["dollar_up", "dollar_down", "sideways"]
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
) -> Regime | None:
    """The dollar's regime on the last day (rules in the module docstring).

    ``None`` when the series is shorter than ``window + slope_days`` rows.
    """
    inv = inverse_series(series)
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
        if state != "dollar_up" and up:
            state, since_idx, run_start = "dollar_up", i, None
        elif state != "dollar_down" and down:
            state, since_idx, run_start = "dollar_down", i, None
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
    series: Sequence[tuple[date, Decimal]], window_days: int = MOVE_WINDOW
) -> MoveNormality | None:
    """How unusual today's ``window_days``-row move of the dollar is.

    Moves are ``inverse[i] / inverse[i - window_days] − 1`` for every row that has
    one (today included). The percentile is the **mid-rank** of |today's move|:
    ``(count(|m| < |today|) + ½·count(|m| = |today|)) / N``, so a flat series gives
    0.5 ("normal"), not 1. ``None`` without at least one move.
    """
    inv = [v for _d, v in inverse_series(series)]
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
) -> dict[str, Decimal | None]:
    """Per window: the share of days the dollar was **cheaper** than today.

    Cheaper dollar = lower inverse = higher rate, so the share is
    ``count(rate > today_rate) / count(rows since start)``. A window is ``None``
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
        out[key] = Decimal(sum(1 for r in rows if r > today_rate)) / len(rows)
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


__all__ = [
    "Direction",
    "Extremes",
    "MoveNormality",
    "Normality",
    "Regime",
    "inverse_series",
    "label_for",
    "move_normality",
    "moving_average",
    "range_extremes",
    "rate_percentiles",
    "regime",
]
